/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / guard.mjs — 出站闸门
//
// 为什么要有这一层：老的三套代码各写了一遍限速和去重，结果是
//   · 私信、评论、@人 三处限额互不相干（各开各的额度）
//   · 去重键包含回复正文 → 换个说法就绕过去了 → 出现过同一评论被回 4 次的事故
//   · 台账写入依赖「从服务端读回 answered_by_me」，而那个接口在本号下永远挂起
//     → 台账永远是空的 → 去重闸形同虚设
//
// 这里的原则：
//   1. 判重只看「回的是哪一条」，不看「回了什么」。目标级（target）优先。
//   2. 先记账再发送（pending），发送后回填 cid/confirmed。宁可少发，不可重发。
//   3. 所有出站走同一个闸门，额度按能力分开计（评论/私信各自 6 条每小时）。
//
// 状态全部落盘成 JSONL，进程重启不丢。

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

// ── 默认策略（可被 config 覆盖）──────────────────────────────────────────────
export const DEFAULT_POLICY = {
  maxChars: 60,            // 单条评论字数上限
  perHour: 6,              // 每小时评论数
  perDay: 30,              // 每天评论数
  dedupeHours: 168,        // 同一目标 7 天内不回第二次
  dmPerHour: 20,           // 私信额度（私信本来就该比评论宽松）
  dmPerDay: 100,
  minGapMs: 8 * 1000,      // 两次出站最小间隔，避免刷屏节奏
  bannedWords: [],         // 额外禁止词
  allowOutsideLink: false, // 是否允许在回复里带站外链接
}

// 站外引导/广告腔：一出现就拒。
const OUTBOUND_PATTERNS = [
  { re: /https?:\/\//i, why: '含站外链接' },
  { re: /\bwww\./i, why: '含站外链接' },
  { re: /(微信|weixin|wechat)\s*[:：]?\s*[a-z0-9_-]{4,}/i, why: '引导加微信' },
  { re: /(qq|扣扣)\s*[:：]?\s*\d{5,}/i, why: '引导加 QQ' },
  { re: /加\s*(我|一下)?\s*(的)?\s*(微信|vx|v信|qq)/i, why: '引导加好友' },
  { re: /(支付宝|收款|转账|扫码付|付款码)/, why: '涉及金钱' },
  { re: /(兼职|刷单|返利|日赚|月入\s*\d+)/, why: '疑似广告' },
]

// 客服腔/机器人腔：让人一眼看出来是机器。命中只是提示，不拦（除非配置严格）。
const ROBOT_PATTERNS = [
  /^\s*(亲|您好|尊敬的)/,
  /感谢您的(支持|关注|理解|反馈)/,
  /欢迎(关注|来到|光临)/,
  /(家人们|宝子们|各位)/,
  /(已读|收到您的)/,
]

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// ── 台账 ────────────────────────────────────────────────────────────────────
/**
 * 一行一条 JSON 的追加日志。
 * 不做删除，只追加；读的时候取每个 key 的最后一条有效记录。
 */
class Ledger {
  constructor(file) {
    this.file = file
    this.rows = []
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    this.loaded = true
    try {
      if (!existsSync(this.file)) return this
      const txt = readFileSync(this.file, 'utf8')
      for (const line of txt.split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        try { this.rows.push(JSON.parse(s)) } catch { /* 坏行忽略，不因一行脏数据炸掉 */ }
      }
    } catch { /* 读不了就当空 */ }
    return this
  }

  append(row) {
    this.load().rows.push(row)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8')
    } catch (e) {
      // 落盘失败不能阻断发送流程，但要让调用方看见
      console.error('[douyin-all/guard] 台账写入失败：' + (e && e.message))
    }
    return row
  }

  all() { return this.load().rows }

  /** 某目标最近一次有效（非 unverified/失败）记录 */
  lastForTarget(kind, target) {
    if (!target) return null
    const rows = this.all()
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.kind !== kind) continue
      if (String(r.target || '') !== String(target)) continue
      // 去重只认「真的发出去过」（confirmed）。failed 是明确没发出去的；
      // pending 只是这一轮还没走完，不代表已经回过。
      if (r.state !== 'confirmed') continue
      return r
    }
    return null
  }

  /** 同目标是否有「没走完」的占位（默认 220 秒内）。只防并发重入，不做长期去重。 */
  pendingForTarget(kind, target, ttlMs = 220 * 1000) {
    if (!target) return null
    const now = Date.now()
    const rows = this.all()
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.kind !== kind || r.state !== 'pending') continue
      if (String(r.target || '') !== String(target)) continue
      if (now - Number(r.at || 0) > ttlMs) return null
      return r
    }
    return null
  }

  countSince(kind, sinceMs) {
    return this.all().filter(r => r.kind === kind && Number(r.at || 0) >= sinceMs).length
  }

  lastConfirmedAt(kind) {
    const rows = this.all().filter(r => r.kind === kind && r.state === 'confirmed')
    return rows.length ? Math.max(...rows.map(r => Number(r.at || 0))) : 0
  }

  lastAt(kind) {
    const rows = this.all().filter(r => r.kind === kind)
    return rows.length ? Math.max(...rows.map(r => Number(r.at || 0))) : 0
  }
}

// ── 闸门 ────────────────────────────────────────────────────────────────────
export class Guard {
  constructor({ file, policy = {} } = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy }
    this.ledger = new Ledger(file)
    this.ledger.load()
  }

  setPolicy(p = {}) {
    this.policy = { ...this.policy, ...p }
    return this.policy
  }

  get file() { return this.ledger.file }

  /**
   * 检查一条待发出的评论。
   *
   * ⚠️ 成败全在「检查完有没有记账」。老实现把 checkComment 和 reserve 拆成两个方法，
   *    结果调用方只要漏掉 reserve，同一目标就会被反复回复（线上就是这么出的重复评论事故）。
   *    现在默认 `reserve: true`：一次调用即「判 + 占位」，想只探测就显式传 `reserve: false`。
   *
   * @returns {{ok:boolean, code?:string, why?:string, soft?:string[], row?:object}}
   */
  checkComment({ awemeId, target, text, now = Date.now(), reserve = true, source = 'brain', skipPending = false }) {
    const p = this.policy
    const body = norm(text)
    // 两段式调用：第一次只判目标重复与额度（正文还没生成，text 缺省），
    // 第二次带真正要发的正文做内容校验。所以没有正文时跳过正文类检查，不当成错误。
    const hasBody = !!body

    if (hasBody && body.length > p.maxChars) {
      return { ok: false, code: 'too_long', why: `超过 ${p.maxChars} 字（当前 ${body.length}）` }
    }

    for (const { re, why } of (hasBody ? OUTBOUND_PATTERNS : [])) {
      if (p.allowOutsideLink && why === '含站外链接') continue
      if (re.test(body)) return { ok: false, code: 'outbound', why }
    }

    for (const w of (hasBody ? (p.bannedWords || []) : [])) {
      const x = norm(w)
      if (x && body.includes(x)) return { ok: false, code: 'banned_word', why: `含禁止词「${x}」` }
    }

    // 严格模式（默认开）：客服腔/机器人腔一律拦。
    // 让人一眼看出是机器的回复，比不发更糟 —— 一旦被认出来，前面装的人味全白费。
    // 关掉时只留软提示，仍放行（软提示在下面统一算）。
    if (hasBody && p.strict !== false) {
      const hit = ROBOT_PATTERNS.find((re) => re.test(body))
      if (hit) return { ok: false, code: 'robot_tone', why: '太像客服/机器人了，换个说法再发' }
    }

    // ── 判重：只看目标，不看正文 ──
    if (target) {
      // 自己刚记下的 pending 不是「重复回过」，只是这一轮还没走完 —— 用短 TTL 防并发重入。
      // skipPending：调用方自己刚占过位（两段式校验的第二次调用），别把自己的 pending 当重复。
      const pending = skipPending ? null : this.ledger.pendingForTarget('comment', target)
      if (pending) {
        const sec = Math.round((now - Number(pending.at || 0)) / 1000)
        return { ok: false, code: 'in_flight', why: `这条正在处理中（${sec} 秒前占位）` }
      }
      const prev = this.ledger.lastForTarget('comment', target)
      if (prev) {
        const ageH = (now - Number(prev.at || 0)) / 3600000
        if (ageH < p.dedupeHours) {
          return {
            ok: false,
            code: 'duplicate_target',
            why: `这条 ${ageH < 1 ? Math.round(ageH * 60) + ' 分钟' : ageH.toFixed(1) + ' 小时'}前已经回过了`,
          }
        }
      }
    }

    // 同一作品同一条正文，也没必要重复。
    // 只有「已经确认发出去过」的行才参与正文判重：pending/failed 行的 text 往往是占位符
    // 或没发出去的草稿，拿它比会把正常回复误杀。
    if (awemeId && hasBody) {
      const dup = this.ledger.all().some(r =>
        r.kind === 'comment' && r.state === 'confirmed' && String(r.aweme || '') === String(awemeId) &&
        norm(r.text) === body && now - Number(r.at || 0) < p.dedupeHours * 3600000)
      if (dup) return { ok: false, code: 'duplicate_text', why: '同一作品下说过一模一样的话' }
    }

    const hourAgo = now - 3600000
    const dayAgo = now - 86400000
    if (this.ledger.countSince('comment', hourAgo) >= p.perHour) {
      return { ok: false, code: 'quota_hour', why: `这一小时已经回了 ${p.perHour} 条` }
    }
    if (this.ledger.countSince('comment', dayAgo) >= p.perDay) {
      return { ok: false, code: 'quota_day', why: `今天已经回了 ${p.perDay} 条` }
    }

    // 「距上一条」只看真正发出去的（confirmed）。自己刚占的 pending 不是上一条，
    // 否则两段式校验里的第二次调用会把刚占位的自己当成间隔 0 秒而误杀。
    const gap = now - this.ledger.lastConfirmedAt('comment')
    if (gap < p.minGapMs) {
      return { ok: false, code: 'too_soon', why: `距上一条才 ${Math.round(gap / 1000)} 秒` }
    }

    // 软提示：不拦，但让上层知道这句像客服
    const soft = ROBOT_PATTERNS.filter(re => re.test(body)).map(re => String(re))

    // 判过就立刻占位 —— 即使后面发送失败/进程挂掉，也留下「这条可能已发」的痕迹
    const row = reserve ? this.reserve('comment', { awemeId, target, text: body || text, source }) : null
    return { ok: true, soft, row }
  }

  /** 私信闸门。私信没有 target 去重概念，按额度 + 最小间隔。 */
  checkDm({ text, now = Date.now(), to } = {}) {
    const p = this.policy
    const body = norm(text)
    if (!body) return { ok: false, code: 'empty', why: '正文为空' }
    if (to) {
      const prev = this.ledger.lastForTarget('dm', to)
      if (prev && now - Number(prev.at || 0) < p.minGapMs) {
        return { ok: false, code: 'too_soon', why: '刚发过，稍等' }
      }
    }
    if (this.ledger.countSince('dm', now - 3600000) >= p.dmPerHour) {
      return { ok: false, code: 'quota_hour', why: `这一小时已经发了 ${p.dmPerHour} 条私信` }
    }
    if (this.ledger.countSince('dm', now - 86400000) >= p.dmPerDay) {
      return { ok: false, code: 'quota_day', why: `今天已经发了 ${p.dmPerDay} 条私信` }
    }
    return { ok: true }
  }

  /**
   * 先记账再发。返回一个 token，发送成功后调 confirm() 回填 cid。
   * 这样即使发送过程中进程挂了，重启后也知道「这条可能已经发了」，不会重发。
   */
  reserve(kind, { awemeId, target, text, to, source = 'brain' } = {}) {
    return this.ledger.append({
      at: Date.now(),
      kind,
      aweme: String(awemeId || ''),
      target: String(target || ''),
      to: String(to || ''),
      text: norm(text).slice(0, 300),
      state: 'pending',
      source,
    })
  }

  confirm(row, { cid = '', note = '', text = '' } = {}) {
    if (row && text) row.text = norm(text).slice(0, 300)
    if (!row) return null
    row.state = 'confirmed'
    row.cid = String(cid || '')
    if (note) row.note = note
    row.confirmedAt = Date.now()
    // 回填：重写整个文件（行数不多，几十到几千，可接受）
    this.flush()
    return row
  }

  markFailed(row, why) {
    if (!row) return null
    row.state = 'failed'
    row.error = String(why || '').slice(0, 200)
    row.failedAt = Date.now()
    this.flush()
    return row
  }

  flush() {
    const tmp = this.file + '.tmp'
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, this.ledger.all().map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.error('[douyin-all/guard] 台账回写失败：' + (e && e.message))
    }
  }

  /** 用量统计，给设置页显示。 */
  usage(now = Date.now()) {
    const L = this.ledger
    return {
      comment: {
        hour: L.countSince('comment', now - 3600000),
        day: L.countSince('comment', now - 86400000),
        total: L.all().filter(r => r.kind === 'comment').length,
        perHour: this.policy.perHour,
        perDay: this.policy.perDay,
      },
      dm: {
        hour: L.countSince('dm', now - 3600000),
        day: L.countSince('dm', now - 86400000),
        total: L.all().filter(r => r.kind === 'dm').length,
        perHour: this.policy.dmPerHour,
        perDay: this.policy.dmPerDay,
      },
      file: this.file,
    }
  }
}

export { OUTBOUND_PATTERNS, ROBOT_PATTERNS, norm }
