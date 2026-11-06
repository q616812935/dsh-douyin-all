/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / loop.mjs — 在专用 Edge 里跑「一轮」的主体逻辑
//
// 为什么是一轮而不是一个一直跑的后台循环：
//   · DSH 插件会被重载（loader/volatile-update），常驻定时器容易跑出两份；
//   · 出问题时开发/用户都能手动触发一轮，看完 events.jsonl 就知道卡在哪；
//   · 自我调度的「下一轮」由一个 setTimeout 串起来，进程活着就一直转，
//     进程死了也不会有 zombie 定时器（老 watch 的坑）。
//
// 一轮做什么（都是开关化的，默认只做最安全的几件）：
//   1. 探活 Edge（空壳则补页）
//   2. 开一个干净的 /chat 页，等接口就绪
//   3. 看左栏有没有新私信 → 回
//   4. 扫自己作品下的新评论 → 回
//   5. 刷推荐流 → 挑一条 → 可选转发给对端
//   6. 按需写日记、生成日报

import { ensureEdge, connect, openFreshPage, closePage, healthCheck, ensureLivePage, pruneTargets, listPages, sleep, stateRoot } from './edge.mjs'
import * as api from './api.mjs'
import * as chat from './chat.mjs'
import * as comments from './comments.mjs'
import * as feed from './feed.mjs'
import * as share from './share.mjs'
import * as social from './social.mjs'
import * as learn from './learn.mjs'
import * as voice from './voice.mjs'
import * as usage from './usage.mjs'
import * as report from './report.mjs'
import { Guard } from './guard.mjs'
import { paths } from './edge.mjs'
import { activeWindow } from './soul.mjs'
import { outboundLocked } from './setup.mjs'
import { join } from 'node:path'
import { readState, writeState, appendEvent } from './state.mjs'

/** 一轮的上下文：页面、闸门、灵魂、大脑，都在这里备好。 */
export async function makeRound({ cfg, soul, brain, guard, log = () => { }, manual = false }) {
  const port = Number(cfg.port || 9334)
  const edge = await ensureEdge({ port, headless: cfg.headless !== false, url: 'https://www.douyin.com/chat', browserPath: cfg.browserPath || '' })
  // 空壳（端口在、没有 page）时补一个常驻页，否则后面开新页会一起失败
  try { await ensureLivePage(edge.port) } catch { /* 补不上就下面 open 时再报 */ }
  const cdp = await connect(edge.port)
  // 顺手回收几轮下来泄漏的空白页（closePage 之后 target 总数并不会下降）
  try {
    const p = await pruneTargets(edge.port, { max: 3 })
    if (p.ok && p.closed > 0) log('info', `回收了 ${p.closed} 个残留页（原有 ${p.pages} 个）`)
  } catch { /* 回收失败不影响这一轮 */ }
  // manual：手动「现在就试一次」，忽略 minGapMinutes（夜间静音与每日配额照旧生效）
  return { cdp, port: edge.port, edge, cfg, soul, brain, guard, log, manual: !!manual }
}

/**
 * 在「干净的新页」上跑一段逻辑，跑完把页收掉。
 * 所有真正的操作都应该走这里 —— 页复用是「半死」的唯一来源。
 */
export async function onPage(round, fn, { navigate = null } = {}) {
  const t = round
  const r = await openFreshPage(t.cdp, t.port, navigate || 'https://www.douyin.com/chat')
  try {
    // 签名头要页面自己跑一会儿才生成，先拿最便宜的接口探一下
    if (!navigate) {
      const w = await api.warmup(r.s, { tries: 6, gapMs: 600 })
      if (!w.ok) t.log('warn', `接口还没就绪（${w.head || '?'}），照常继续`)
    }
    return await fn(r.s, r)
  } finally {
    await closePage(t.cdp, r.targetId)
  }
}

/** 关掉一轮的 CDP 根会话（浏览器进程不杀）。 */
export function endRound(round) {
  try { round.cdp?.close() } catch { /* ignore */ }
}

// ── 私信 ────────────────────────────────────────────────────────────────────

/**
 * 看左栏有没有新私信并回一条。
 *
 * 判据（实测过的三条）：
 *   · 会话行文本变了 → 有新消息（抖音私信没有独立的「收件箱接口」）
 *   · 未读角标 > 0 → 有新消息
 *   · 两者都没有但离上次检查超过 10 分钟 → 主动点开看一眼（兜底）
 *
 * @returns {Promise<{ok:boolean, acted:boolean, why?:string, sent?:string}>}
 */
export async function dmRound(round, { force = false } = {}) {
  const t = round
  const c = t.cfg
  const peer = String(c.peer || '').trim()
  if (!peer) return { ok: false, acted: false, why: '没配置对端昵称（设置页 → 抖音自动陪伴 → 基础设置 → 对端昵称）' }
  if (!c.dm?.enabled) return { ok: true, acted: false, why: '私信功能已关闭' }

  const wm = readState('chat-watermark.json', {}) || {}
  const cur = wm[peer] || {}

  return await onPage(t, async (p) => {
    const rows = await chat.conversationRows(p, { waitMs: 15000 })
    const row = chat.findConversationRow(rows, peer)
    if (!row) {
      return { ok: false, acted: false, why: `左栏没找到「${peer}」（会话可能在折叠区里，或昵称改了）` }
    }

    const changed = cur.row !== row.text
    const unread = Array.isArray(row.unread) ? row.unread : []
    let needOpen = force || changed || unread.length > 0
    if (!needOpen && cur.checkedAt && Date.now() - Number(cur.checkedAt) < 10 * 60 * 1000) {
      return { ok: true, acted: false, why: '没有新消息' }
    }

    const oc = await chat.openConversation(p, { nick: peer })
    if (!oc.ok) return { ok: false, acted: false, why: '打不开会话：' + (oc.why || oc.code) }
    const msgs = await chat.readMessages(p)
    const incoming = lastIncoming(msgs, cur.messages || 0)
    wm[peer] = { ...cur, row: row.text, checkedAt: Date.now(), messages: msgs.length }
    writeState('chat-watermark.json', wm)

    if (!incoming.length) return { ok: true, acted: false, why: '点了会话但没有新的对方消息' }

    // 他聊到什么，她就学着爱看什么（用户要的「根据我的回复兴趣了解我的兴趣点」）。
    // 先学再回：万一后面模型或发送挂了，学到手的口味也不会丢。
    const lastShare = (readState('last-share.json', {}) || {}).shares?.[0] || null
    const leaned = await learn.learnFromDm(t.soul, incoming[incoming.length - 1].text, { peer, lastShare })

    const acted = []
    for (const m of incoming.slice(-1)) {
      if (!c.dm.autoReply) break
      // 故意慢一点再回，秒回太像机器人
      if (Number(c.dm.replyDelayMs || 0) > 0) await sleep(Math.max(0, Math.min(30000, Number(c.dm.replyDelayMs))))
      // 闸门拿占位符 'x' 去查只有「空正文/太频繁/超配额」——真正的正文校验放在拿到模型输出之后
      const g = t.guard.checkDm({ text: 'x', to: peer })
      if (!g.ok) { acted.push('闸门拦下：' + g.why); break }

      // 他主动来了就一定要回：免打扰时段只管「她主动开口」，不拦「回复」。
      const out = await t.brain.replyDm({ who: peer, incoming: m.text, recent: msgs.slice(-8) })
      if (!out || !out.text) { acted.push('模型没给出话'); break }
      const gb = t.guard.checkDm({ text: out.text, to: peer })
      if (!gb.ok) { acted.push('闸门拦下：' + gb.why); break }
      const sent = await chat.sendMessage(p, out.text, { nick: peer, timeoutMs: 25000 })
      if (!sent.ok) {
        usage.bump('dm.failed', { why: sent.code })
        acted.push('发送失败：' + (sent.why || sent.code))
        break
      }
      const rowRec = t.guard.reserve('dm', { text: out.text, to: peer, source: out.source })
      t.guard.confirm(rowRec)
      usage.bump('dm.replied', { who: peer })
      appendEvent({ job: 'dm', ok: true, who: peer, incoming: m.text.slice(0, 100), out: out.text.slice(0, 100), source: out.source })
      acted.push('回了：' + out.text)
      t.soul.bumpAffection(peer, 1)
      if (leaned.learned.length) acted.push('学到口味：' + leaned.learned.map((x) => (x.verdict === 'like' ? '+' : '-') + x.tag).join(' '))

      // 顺带记一句关于他的话。
      // 用 extractFacts 而不是原来的 extractMemories：后者把调情话、情绪、以及对插件本身
      // 的讨论都抽成「他表示/他说过…」，实测灌了 600+ 条 promise 级噪音，把真正的
      // 长期记忆挤没了。extractFacts 只留身份/职业/住哪/宠物/喜好/作息这类稳定事实。
      try {
        const facts = await t.brain.extractFacts({ who: peer, lines: msgs.slice(-6) })
        for (const mm of facts) {
          t.soul.remember({ text: mm.text, who: peer, kind: mm.kind || 'fact', importance: mm.importance || 3, evidence: m.text.slice(0, 120) })
        }
        if (facts.length) acted.push(`记下 ${facts.length} 条关于他的事`)
      } catch (e) { t.log('warn', '抽取事实失败：' + (e?.message || e)) }

      if (c.dm.voiceReply) {
        try {
          const v = await voice.speak(out.text, { preset: c.dm.voicePreset || voice.DEFAULT_PRESET })
          if (v.ok) {
            // 抖音私信没法发本地音频文件，只能记一笔等 IM 渠道去发
            usage.bump('voice.sent', { file: v.path })
            appendEvent({ job: 'voice', ok: true, file: v.path, bytes: v.bytes })
            acted.push('语音已合成（' + Math.round(v.bytes / 1024) + 'KB）')
          }
        } catch (e) { t.log('warn', '语音合成失败：' + (e?.message || e)) }
      }
    }
    return { ok: true, acted: acted.length > 0, why: acted.join('；') || '不必回复', sent: acted.join('；') }
  })
}

/** 从消息数组里取出「比上次多出来的、对方说的」部分。 */
function lastIncoming(msgs, seenCount) {
  const list = Array.isArray(msgs) ? msgs : []
  const fresh = list.slice(Math.max(0, Number(seenCount) || 0))
  const incoming = fresh.filter((m) => !m.mine && String(m.text || '').trim())
  // 兜底：有时候消息条数不变（换会话时复用），那就取最后三条里对方的最后一条
  if (!incoming.length && list.length) {
    const tail = list.slice(-3).filter((m) => !m.mine)
    return tail.slice(-1)
  }
  return incoming
}

// ── 评论 ────────────────────────────────────────────────────────────────────

/**
 * 扫「自己作品」下的评论并回。
 * 不依赖上方通知（本号的 /aweme/v1/web/notice/ 恒 status_code:5），直接读作品列表。
 */
export async function commentRound(round, { awemeIds = [], maxWorks = 5, perWork = 10 } = {}) {
  const t = round
  const c = t.cfg.comments || {}
  if (!c.selfWorks && !c.others) return { ok: true, posted: 0, why: '评论回复已关闭' }

  return await onPage(t, async (p) => {
    const mine = await api.myWorks(p, { count: 20 })
    const works = (mine?.aweme_list || []).map(api.pickWork).filter((w) => w.aweme_id)
    const ids = awemeIds.length ? awemeIds : works.slice(0, maxWorks).map((w) => w.aweme_id)
    if (!ids.length) return { ok: false, posted: 0, why: '没读到自己的作品' }

    const selfNick = String(t.cfg.owner || '').trim()
    const skips = c.skipNicks || []
    // 「只回多久以内的评论」跟下面「作品最长多久」是同一件事的两个口径，
    // 不能再单独写死 48 小时 —— 那会让 7 天内的作品只剩最后两天有回复。
    const maxAge = (c.workMaxAgeDays ? Number(c.workMaxAgeDays) : 7) * 24
    let posted = 0
    const notes = []
    const now = Date.now()

    for (const id of ids) {
      const w = works.find((x) => x.aweme_id === id) || { aweme_id: id, desc: '' }
      const ageDays = w.create_time ? (now - w.create_time * 1000) / 86400000 : 0
      // 用 Math.ceil 而不是 Math.round：作品正好 7.4 天时 round 成 7，日志会写成
      // 「太旧（7 天 > 7 天），跳过」这种自相矛盾的话，排查时极具误导性。
      if (c.workMaxAgeDays && ageDays > c.workMaxAgeDays) { notes.push(`${id} 太旧（${ageDays.toFixed(1)} 天 > ${c.workMaxAgeDays} 天），跳过`); continue }
      const lc = await comments.listComments(p, id, { max: perWork, selfNick })
      if (!lc.ok) { notes.push(`${id} 读评论失败`); continue }
      usage.bump('comment.scanned', { aweme: id, n: lc.items.length })
      const cand = comments.pickReplies(
        lc.items.map((x) => ({ ...x, time: x.time })),
        // workMaxAgeDays 为 0/未设时不做时间卡：maxAgeHours 传 0 会被 pickReplies
        // 当成「0 小时 = 全部过期」，所以显式传 Infinity 表示不卡。
        { selfNick, skipNicks: skips, maxAgeHours: maxAge > 0 ? maxAge : Infinity, now, limit: Math.max(1, Number(c.maxPerRound || 3)) },
      )
      for (const it of cand.picked) {
        if (posted >= Number(c.maxPerRound || 3)) break
        const target = `${id}:${it.cid}`
        // 第一次只判目标重复与额度，不传正文：传占位符 'x' 会让「同作品同正文」那一条把
        // 每次回复都判成一模一样（回的内容还没生成呢）。正文类校验留给下面 g2。
        const g = t.guard.checkComment({ awemeId: id, target, source: 'comment' })
        if (!g.ok) { notes.push(`${it.cid} 闸门：${g.why}`); continue }

        const out = await t.brain.replyComment({ awemeDesc: w.desc, author: it.nick, incoming: it.text, isSelfWork: true })
        const g2 = t.guard.checkComment({ awemeId: id, target, text: out.text, source: out.source, reserve: false, skipPending: true })
        if (!g2.ok) { t.guard.markFailed(g.row, g2.why); notes.push(`${it.cid} 内容被拦：${g2.why}`); continue }

        const r = await comments.postComment(p, { awemeId: id, text: out.text, replyId: it.cid })
        if (!r.ok) {
          t.guard.markFailed(g2.row, r.code)
          usage.bump('comment.failed', { aweme: id, code: r.code })
          notes.push(`${it.cid} 发送失败：${r.code}`)
          continue
        }
        t.guard.confirm(g2.row || g.row, { cid: r.cid, text: out.text })
        usage.bump('comment.self', { aweme: id, cid: r.cid })
        appendEvent({ job: 'comment', ok: true, aweme: id, cid: r.cid, to: it.nick, incoming: it.text.slice(0, 80), out: out.text })
        posted++
        notes.push(`回了 ${it.nick}：${out.text}`)
        await sleep(1500)
      }
    }
    return { ok: true, posted, scannedWorks: ids.length, notes, why: notes.join('；') || '没有需要回的评论' }
  })
}

// ── 刷流 / 转发 ─────────────────────────────────────────────────────────────
//
// 诉求：助手要真的看懂视频、真的刷过之后才表态，并且有自己的兴趣取向。
//
// 所以这里不再只是「按关键词打分挑一条」，而是：
//   1. 刷一批 → 粗筛出 3 条候选（feed.pick 仍用关键词做第一道，减少模型调用）；
//   2. 让她**真的看一遍**：analyzeVideo 抽标签 + judgeVideo 凭自己的口味表态；
//   3. 表态写回 soul.learn()，口味随次数累积（这是「有自己的取向」的实现）；
//   4. 按她的表态决定动作：
//        like    → 想分享就分享给账号持有人（受免打扰/频率限制）/ 想评论就在评论区 @ 账号持有人（可选）
//        neutral → 只是看了，不发声
//        dislike → 记下来，什么都不做
//   5. 只有「真的想说」才发声，且主动发声必须过 activeWindow() 这一关。

/** 主动发声前的统一闸门：免打扰时段 + 最小间隔 + 每日上限。 */
// ignoreGap：手动/临时触发（设置页「刷一次并评论」、guarded 单步试跑）不算「主动开口」，
// 否则试一次就把后面 30 分钟的自动行动全挡住了。夜间静音和每日配额仍然算数。
/**
 * 「现在能不能主动开口」——夜间静音 + 每日额度 + 同一类动作的最小间隔。
 *
 * ⚠️ 这里曾经用 dm.quiet.minGapMinutes(30) 去卡**所有**主动动作，而它读的是
 *    soul.state.lastSpeakAt —— 那个字段私信回复也会写。于是「回了他一句私信」
 *    就会把接下来的分享 / @ / 评论全部推后 30 分钟，而轮询间隔只有 90 秒：
 *    线上实测 20 轮里 19 轮的 feed 都停在「距离上次主动开口才 28 分钟（要求间隔 ≥30 分钟）」，
 *    一天真正能分享/@/评论的机会被压到个位数，用户看到的就是「她根本不会分享视频」。
 *
 * 现在拆成两个独立的概念：
 *   - 夜间静音 / 每日主动次数上限：仍然算总账（对端感受得到的那层节奏）；
 *   - 最小间隔：按**动作类型**分别记（feed.proactiveGapMinutes，只看上一次
 *     share / mention / comment 的时间，私信聊天不影响）。
 * 手动触发（t.manual，来自设置页「现在就试一次」）跳过间隔与夜间静音，但每日额度照样生效。
 */
function canSpeakNow(t, { perDay = 8, ignoreGap = false, kind = 'feed' } = {}) {
  const q = { ...(t.cfg.dm?.quiet || {}) }
  const c = t.cfg.feed || {}
  // activeWindow 只管「夜间静音」这一件事。它的 minGapMinutes 原本是给私信聊天用的
  // 防刷屏间隔，这里必须清掉 —— 否则 dm.quiet.minGapMinutes(30) 会继续夹在
  // 「回了一句私信」和「接下来分享视频」之间，实测每轮都停在
  // 「距离上次主动开口才 3 分钟（要求间隔 ≥30 分钟）」，一整天只出得去几次。
  q.minGapMinutes = 0
  if (ignoreGap) q.__lastProactiveAt = 0
  const w = activeWindow({ ...q, __lastProactiveAt: ignoreGap ? 0 : (t.soul.state?.lastSpeakAt || 0) })
  if (!w.ok) return w
  const quota = t.soul.canSpeakFirst({ perDay })
  if (!quota.ok) return quota
  if (!ignoreGap) {
    const gapMin = Number(c.proactiveGapMinutes ?? 12)
    if (gapMin > 0) {
      const last = Number((t.soul.state?.lastProactiveByKind || {})[kind] || 0)
      const passed = (Date.now() - last) / 60000
      if (last && passed < gapMin) {
        return { ok: false, code: 'too_soon', why: '上一次主动' + (kind === 'feed' ? '分享/评论' : '开口') + '才 ' + Math.round(passed) + ' 分钟（要求间隔 ≥' + gapMin + ' 分钟，还要等 ' + Math.ceil(gapMin - passed) + ' 分钟）' }
      }
    }
  }
  return { ok: true, used: quota.used, perDay: quota.perDay }
}

export async function feedRound(round, { count = 0, share: doShare = null, mention: doMention = null, comment: doComment = null } = {}) {
  const t = round
  const c = t.cfg.feed || {}
  if (!c.enabled) return { ok: true, picked: null, why: '刷流已关闭' }

  // 她自己的口味画像（来自 soul.interests + 长期记忆里的「喜欢…」）
  const taste = t.soul.tastePrompt()
  const tasteMem = t.brain.tasteFromMemory ? t.brain.tasteFromMemory(6) : []
  const tasteAll = [taste, tasteMem.length ? tasteMem.join('；') : ''].filter(Boolean).join('｜')
  const watched = t.soul.getInterests().watched || []

  const wantShare = doShare === null ? !!c.shareToPeer : !!doShare
  const wantMention = doMention === null ? !!c.mentionPeer : !!doMention
  const wantComment = doComment === null ? !!c.commentPeers : !!doComment
  // 允许刷几下。以前一轮只刷一次，撞上 dislike/neutral 就整轮什么都没做，
  // 而推荐流一次只回 2~6 条、还总夹着旧视频，所以「一整天什么都不发」很平常。
  const maxBrowses = Math.max(1, Math.min(6, Number(c.browsesPerRound || 3)))
  const out = {
    ok: true,
    picked: null,
    reviews: [],       // 这一轮看过的每一条（含结论）
    share: undefined,
    mention: undefined,
    comment: undefined,
    acted: 0,
  }
  let lastWhy = '没刷到合适的东西'
  let chosenItem = null

  for (let browse = 1; browse <= maxBrowses; browse++) {
    const noActionWanted = !wantShare && !wantMention && !wantComment
    if (noActionWanted) break

    const r = await onPage(t, async (p) => {
      const rr = await feed.pickWithContext(p, {
        // 一次刷多一点：只刷 6 条时，反复刷就会反复抽到同一批（实测同一批里既有 4 月的老视频，
        // 也有已经分享过的同一条），挑来挑去还是那几条，看起来就是「卡住了」。
        count: Number(count || c.count || 10),
        limit: 3,                       // 多拿两条候选让模型挑，别只给一条
        dislike: c.dislike || [],
        like: c.like || [],
        tasteTags: t.soul.getInterests().likes.map((x) => x.tag),
        tasteScore: (tags) => t.soul.tasteScore(tags),
        freshHours: Number(c.freshHours || 0),
        recalled: watched,
        recallHours: Number(c.recallHours || 72),
        // 自己的作品不该被「挑来跟人说」；热评素材也别混进自己的评论
        selfNick: String(t.cfg.owner || '').trim(),
        selfUid: String((t.ownerAt && t.ownerAt.uid) || ''),
      })
      if (!rr.ok) return { rr, cands: [], comments: rr.comments || [] }

      // ── 让她真的看一遍：抽标签 → 凭口味表态 ──
      // pickWithContext 回来的候选列表字段叫 cands（不是 candidates），
      // 兜底也不能拿 null 去 slice —— 先过滤掉空值再切。
      const pool = (Array.isArray(rr.cands) && rr.cands.length ? rr.cands : [rr.picked]).filter(Boolean)
      const reviewed = []
      for (const cand of pool.slice(0, 3)) {
        const an = await t.brain.analyzeVideo({
          desc: cand.desc,
          author: cand.author?.nick || '',
          durationMs: cand.duration,
          comments: cand === rr.picked ? rr.comments : [],
        }).catch(() => ({ ok: false, tags: [] }))
        const jd = await t.brain.judgeVideo({
          summary: an.summary || '',
          tags: an.tags || [],
          desc: cand.desc,
          taste: tasteAll,
        }).catch(() => ({ ok: false, verdict: 'neutral', strength: 1, reaction: '' }))
        // 口味立刻长一点：明显喜欢的记强，明显的 dislike 也记
        try {
          t.soul.learn({
            tags: an.tags || [],
            verdict: jd.verdict === 'like' ? 'like' : jd.verdict === 'dislike' ? 'dislike' : 'neutral',
            strength: jd.strength || 1,
            item: { awemeId: cand.aweme_id, desc: cand.desc },
          })
        } catch (e) { t.log('warn', '更新口味失败：' + (e?.message || e)) }
        reviewed.push({
          cand, an, jd,
          line: {
            job: 'browse', ok: true, aweme: cand.aweme_id,
            summary: String(an.summary || '').slice(0, 60),
            tags: an.tags || [], verdict: jd.verdict, strength: jd.strength || 1,
            reaction: String(jd.reaction || '').slice(0, 40),
          },
        })
        await sleep(900)
      }
      // 「喜欢」的优先；这条视频上没能做出站动作（如评论区加载不出来）就换下一条。
      reviewed.sort((a, b) => (b.jd.verdict === 'like' ? 1 : 0) - (a.jd.verdict === 'like' ? 1 : 0))
      return { rr, cands: reviewed, comments: rr.comments || [] }
    })
    if (!r || !r.rr || !r.rr.ok) {
      lastWhy = (r && r.rr && (r.rr.why || r.rr.code)) || '这轮没有想说的'
      usage.bump('feed.browsed', { ok: 0, why: lastWhy })
      break
    }
    usage.bump('feed.browsed', { ok: 1, n: r.rr.scanned })
    if (!r.cands.length) { lastWhy = '没挑出可看的视频'; break }
    out.reviews.push(...r.cands.map((x) => x.line))

    // 要在别人的视频下 @ 人，得先知道「账号持有人」的 uid —— 昵称不能直接当提及用。
    // 查一次就够（uid 不会变），缓存在 round 上，同一轮里 @ 和评论共用。
    if (wantMention && !t.ownerAt) {
      const owner = String(t.cfg.owner || '').trim()
      if (owner) {
        // 走 social.resolveOwner：先读 state/owner-id.json 缓存（命中就一次接口都不打），
        // 没命中才开页查 —— 先 myWorks 的 author（最准，不会被同名号干扰），
        // 再退到搜索里昵称完全一致的那个，成功后落盘。
        // 早先把这段直接写在 feedRound 里，遇到「新开页还没 warmup 好」就间歇性失败，
        // 线上表现是每隔几轮冒一次「没搜到完全一致的用户，这轮不 @ 人」，@ 就凭空少一轮。
        if (typeof social.cachedOwner === 'function') t.ownerAt = social.cachedOwner(t)
        if (!t.ownerAt) {
          await onPage(t, async (p2) => {
            t.ownerAt = await social.resolveOwner(t, p2)
          }).catch((e) => t.log('warn', '查账号持有人 uid 失败：' + (e?.message || e)))
        }
        if (!t.ownerAt) t.log('warn', '按昵称「' + owner + '」暂时解析不出 uid（页还没就绪？），这轮先不 @ 人')
      }
    }

    const gate = canSpeakNow(t, { perDay: Number(c.proactivePerDay || 8), ignoreGap: !!t.manual, kind: 'feed' })
    if (!gate.ok) { lastWhy = gate.why; break }

    // 这一刷里，按「喜欢优先」逐条试；**每条视频只做一个出站动作**。
    // 实测在同一页面对同一条视频连发两次 comment/publish，第二次会被服务端静默丢掉
    // （HTTP 200 但空 body / 回执没有 cid），所以「又分享又 @ 又评论」做不到。
    for (const item of r.cands) {
      const { cand, an, jd } = item
      if (!chosenItem) chosenItem = item
      if (jd.verdict !== 'like') continue
      let did = ''
      if (wantShare && out.share === undefined) {
        const sr = await onPage(t, (p) => social.shareToPeer(t, p, { cand, summary: an.summary, reaction: jd.reaction, topComments: r.comments, tags: an.tags }))
        out.share = sr
        if (sr && sr.ok) did = 'share'
      }
      if (!did && wantMention && out.mention === undefined) {
        const mr = await onPage(t, (p) => social.mentionOwner(t, p, { cand, summary: an.summary, tags: an.tags, reaction: jd.reaction }))
        out.mention = mr
        if (mr && mr.ok) did = 'mention'
        await social.breathe(1500)
      }
      if (!did && wantComment && out.comment === undefined) {
        const cr = await onPage(t, (p) => social.commentOnVideo(t, p, { cand, summary: an.summary, tags: an.tags, reaction: jd.reaction, topComments: r.comments }))
        out.comment = cr
        if (cr && cr.ok) did = 'comment'
      }
      if (did) {
        out.picked = cand
        out.summary = an.summary
        out.tags = an.tags
        out.verdict = jd.verdict
        out.reaction = jd.reaction
        out.acted += 1
        t.soul.state.lastSpeakAt = Date.now()
        // 按动作类型各记一个时间戳：canSpeakNow 的「最小间隔」只看这一类，
        // 不再让一句私信回复把后面的分享/@ 全堵死。
        t.soul.state.lastProactiveByKind = { ...(t.soul.state.lastProactiveByKind || {}), feed: Date.now() }
        appendEvent({ job: 'feed', ok: true, aweme: cand.aweme_id, desc: String(cand.desc || '').slice(0, 80), verdict: jd.verdict, did })
        break
      }
    }
    // 三种动作都试过了（不管成没成）就收工，否则继续下一刷
    const allTried = (out.share !== undefined || !wantShare) && (out.mention !== undefined || !wantMention) && (out.comment !== undefined || !wantComment)
    if (out.acted > 0 || allTried) break
    await sleep(2000)
  }

  if (!out.picked && chosenItem) {
    out.picked = chosenItem.cand
    out.summary = chosenItem.an?.summary
    out.tags = chosenItem.an?.tags
    out.verdict = chosenItem.jd?.verdict
    out.reaction = chosenItem.jd?.reaction
  }
  if (out.picked) usage.bump('video.picked', { aweme: out.picked.aweme_id })
  out.taste = t.soul.getInterests().likes.slice(0, 5)
  out.why = out.picked
    ? feed.describe(out.picked) + (out.summary ? ' → ' + out.summary : '') + '（' + out.verdict + '）'
    : lastWhy
  if (out.picked && out.acted === 0) appendEvent({ job: 'feed', ok: true, aweme: out.picked.aweme_id, desc: String(out.picked.desc || '').slice(0, 80), verdict: out.verdict, did: 'none' })
  return out
}

// ── 日记 / 日报 ─────────────────────────────────────────────────────────────

export async function diaryRound(round) {
  const t = round
  if (t.soul.hasDiaryToday) return { ok: true, wrote: false, why: '今天已经写过了' }
  const d = report.digestDay()
  const lines = []
  const n = (k) => Number(d?.counts?.[k] || 0)
  if (n('dm.replied')) lines.push(`回了 ${n('dm.replied')} 条私信`)
  if (n('comment.self')) lines.push(`回了 ${n('comment.self')} 条评论`)
  if (n('video.shared')) lines.push(`转发了 ${n('video.shared')} 个视频`)
  if (n('feed.browsed')) lines.push(`刷了 ${n('feed.browsed')} 次推荐`)
  const dayText = lines.length ? lines.join('，') : '今天几乎没怎么动，安静地待着。'
  const w = await t.brain.writeDiary({ dayText, name: t.cfg.peer })
  const text = w.text || dayText
  t.soul.writeDiary(text)
  usage.bump('diary.written', {})
  appendEvent({ job: 'diary', ok: true, text })
  return { ok: true, wrote: true, text, basedOn: dayText, source: w.source }
}

export async function reportRound(round) {
  const r = report.narrate(1, { name: round.cfg.persona?.name || '助手' })
  appendEvent({ job: 'report', ok: true, head: String(r?.text || r || '').slice(0, 200) })
  return { ok: true, report: r }
}

// ── 一轮完整跑 ──────────────────────────────────────────────────────────────

export async function runRound({ cfg, soul, brain, guard, log = () => { }, parts = null } = {}) {
  const want = parts || {
    dm: !!cfg.dm?.enabled,
    comments: !!(cfg.comments?.selfWorks || cfg.comments?.others),
    feed: !!cfg.feed?.enabled,
    diary: true,
  }
  // 开通向导没走完 = 这个插件还不知道「我是谁、该跟谁说话」。
  // 这时候任何对外发送都是替陌生用户去联系真人，所以一律不发：
  // 只留刷流（不对外）与日记（本地）。锁死原因要明确写进结果，别让用户以为插件坏了。
  const locked = outboundLocked(cfg)
  if (locked) log('warn', '开通向导还没走完，已跳过私信/评论/分享/@（设置页 → 抖音自动陪伴 → 首次开通）')
  const round = await makeRound({ cfg, soul, brain, guard, log })
  const out = { at: new Date().toISOString(), locked, parts: {} }
  try {
    if (locked) {
      out.parts.dm = { ok: true, acted: false, why: LOCK_WHY }
      out.parts.comments = { ok: true, posted: 0, why: LOCK_WHY }
    } else {
      if (want.dm) out.parts.dm = await safe('dm', () => dmRound(round), log)
      if (want.comments) out.parts.comments = await safe('comments', () => commentRound(round), log)
    }
    if (want.feed) {
      // 刷流本身不对外，但「分享/评论/@ 人」是出站动作，锁死时必须显式关掉。
      out.parts.feed = await safe('feed', () => (locked
        ? feedRound(round, { share: false, mention: false, comment: false })
        : feedRound(round)), log)
    }
    if (want.diary) out.parts.diary = await safe('diary', () => diaryRound(round), log)
  } finally {
    endRound(round)
  }
  appendEvent({ job: 'round', ok: true, locked, parts: Object.fromEntries(Object.entries(out.parts).map(([k, v]) => [k, v?.ok])) })
  return out
}

const LOCK_WHY = '开通向导未完成，出站已锁（设置页 → 抖音自动陪伴 → 首次开通）'

async function safe(name, fn, log) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { ...r, ms: Date.now() - t0 }
  } catch (e) {
    log('error', `${name} 失败：${e?.message || e}`)
    appendEvent({ job: name, ok: false, error: String(e?.message || e) })
    return { ok: false, error: String(e?.message || e), ms: Date.now() - t0 }
  }
}

export { usage, report, paths }
