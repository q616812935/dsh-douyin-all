/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / soul.mjs — 人格、记忆、心情、虚拟时钟、日记
//
// 目标：一个人格、一份记忆，同时供私信/评论/刷视频三条链路使用。
// 取代：browser-local 的 persona-memory + fish-soul 的 soul-memory/persona/growth/clock
//
// 为什么不用 SQLite（fish-soul 用的是 soul.db）：
//   · 这个插件要能单独装、单独跑，不能和 fish-soul 抢同一个库文件；
//   · 数据量小（一个人、几百条记忆、百来条日记），JSON 足够；
//   · 落盘用「临时文件 + rename」，断电也不会写出半个文件。
//
// 记忆模型（从 fish-soul 学来的关键点）：
//   1. 按人隔离：每条记忆归属某个人（sec_uid 或昵称），召回时只取这个人的 + 公开的。
//   2. 艾宾浩斯衰减：重要度高不淡，久不提才淡。`weight = importance * decay(age, lastHit)`。
//   3. 出处 evidence：每条记忆记「哪来的」（私信/评论/视频），方便日后核对。
//   4. 可纠正：改动留旧档，不直接覆盖。
//   5. 私密标记：私聊里的敏感内容标 private，群里/公开场合不召回。
//
// 检索用 BM25 的简化版（中文按 2-gram + 停用词），不引第三方依赖。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { stateRoot, ensureDir } from './edge.mjs'

// ── 路径 ────────────────────────────────────────────────────────────────────
export const soulPaths = {
  dir: () => join(stateRoot(), 'soul'),
  persona: () => join(stateRoot(), 'soul', 'persona.json'),
  memories: () => join(stateRoot(), 'soul', 'memories.json'),
  state: () => join(stateRoot(), 'soul', 'state.json'),
  diary: () => join(stateRoot(), 'soul', 'diary.jsonl'),
  impressions: () => join(stateRoot(), 'soul', 'impressions.json'),
  interests: () => join(stateRoot(), 'soul', 'interests.json'),
  backups: () => join(stateRoot(), 'soul', 'backups'),
}

// ── 免打扰 / 主动开口节流 ───────────────────────────────────────────────────
// 诉求：助手不要一直主动发消息，要有频率上限与免打扰时段（例如晚上 8 点之后不主动开口）。
// 所以这里只管「她主动开口」，不影响「他来信就回」——被叫了一定要答。
//
// 时段用本地时间的 "HH:MM"，支持跨零点（22:00–08:00）。
// 为什么不用整点数字：跨零点的表达用整点会说反（22–8 在 22>8 时会判成空区间）。
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** "HH:MM" → 当天分钟数；非法返回 null。 */
export function parseHHMM(s) {
  const m = HHMM.exec(String(s || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function nowMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes()
}

/**
 * 现在是不是「可以主动开口」的时间。
 *
 * @param {object} q quiet 配置
 * @param {Date} [now] 注入时间（测试用）
 * @returns {{ok:boolean, why?:string, until?:string}}
 */
export function activeWindow(q = {}, now = new Date()) {
  const quiet = q || {}
  // 总开关：夜里一律不主动开口（用户明确要的那条）
  if (quiet.nightMuted !== false) {
    const from = parseHHMM(quiet.nightFrom || '22:00')
    const to = parseHHMM(quiet.nightTo || '08:00')
    if (from !== null && to !== null) {
      const cur = nowMinutes(now)
      // from > to 表示跨零点
      const inside = from <= to ? cur >= from && cur < to : cur >= from || cur < to
      if (inside) return { ok: false, why: `现在是免打扰时段（${quiet.nightFrom || '22:00'}–${quiet.nightTo || '08:00'}）`, until: quiet.nightTo || '08:00' }
    }
  }
  // 白天也按最小间隔节流：他半天不回，她就不该一直发
  const minGapMin = Math.max(0, Number(quiet.minGapMinutes ?? 30))
  const last = Number(quiet.__lastProactiveAt || 0)
  if (minGapMin > 0 && last > 0) {
    const gapMs = now.getTime() - last
    if (gapMs < minGapMin * 60000) {
      const left = Math.ceil((minGapMin * 60000 - gapMs) / 60000)
      return { ok: false, why: `距离上次主动开口才 ${Math.floor(gapMs / 60000)} 分钟（要求间隔 ≥${minGapMin} 分钟，还要等 ${left} 分钟）` }
    }
  }
  return { ok: true }
}

// ── 原子写 ──────────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const txt = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!txt.trim()) return fallback
    return JSON.parse(txt)
  } catch (e) {
    // 读坏了不覆盖原文件（fish-soul 的做法），留着让人能手工救
    console.error('[douyin-all/soul] 读取失败，保持原文件不动：' + file + ' → ' + (e && e.message))
    return fallback
  }
}

let tmpSeq = 0
function writeJson(file, obj) {
  ensureDir(dirname(file))
  // 临时文件名必须唯一：同一路径的 .tmp 一旦被并发 rename，
  // 后到的 rename 会因为源已不存在而 EPERM（Windows）。pid+计数足够区分。
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  // Windows 上 rename 撞上杀毒/索引/句柄（EPERM）是常态，退避重试几次再放弃；
  // 真放弃时把临时文件删掉，别在 soul 目录里留垃圾。
  let lastErr = null
  for (let i = 0; i < 6; i++) {
    try {
      renameSync(tmp, file)   // 同盘 rename 是原子的
      return obj
    } catch (e) {
      lastErr = e
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') break
      sleepSync(8 * (i + 1))
    }
  }
  try { unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
  throw lastErr
}

/** 同步小睡：writeJson 是同步 API，退避也只能阻塞着等。 */
function sleepSync(ms) {
  const until = Date.now() + ms
  // 忙等比 Atomics.wait 更容易在 worker 里出问题，这里量级很小（<50ms）
  while (Date.now() < until) { /* spin */ }
}

const nowMs = () => Date.now()
const dayKey = (ms = Date.now()) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── 中文分词（2-gram + 停用词）──────────────────────────────────────────────
/** 长期记忆条数上限（超出按权重归档）。 */
const MAX_MEM = 800

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '个', '有', '和', '就',
  '不', '也', '都', '还', '要', '会', '能', '把', '被', '给', '让', '吗', '呢', '吧', '啊', '呀',
  '哦', '嗯', '哈', '着', '过', '得', '地', '一', '上', '下', '来', '去', '说', '很', '太', '好',
])

export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase()
  const out = []
  // 英文/数字按词切
  for (const m of raw.matchAll(/[a-z0-9_]+/g)) out.push(m[0])
  // 中文按 2-gram（单字也留一份，短 query 才命中）
  const zh = raw.replace(/[^\u4e00-\u9fa5]+/g, ' ')
  for (const seg of zh.split(/\s+/)) {
    if (!seg) continue
    for (let i = 0; i < seg.length; i++) {
      if (i + 1 < seg.length) out.push(seg.slice(i, i + 2))
      if (seg.length === 1) out.push(seg)
    }
  }
  return out.filter((t) => t && !STOP.has(t))
}

// ── BM25 打分 ───────────────────────────────────────────────────────────────
function bm25(docs, queryTokens, { k1 = 1.5, b = 0.75 } = {}) {
  const N = docs.length || 1
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1
  const df = new Map()
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1)
  }
  const scores = docs.map((d) => {
    const tf = new Map()
    for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1)
    let s = 0
    for (const q of queryTokens) {
      const f = tf.get(q) || 0
      if (!f) continue
      const n = df.get(q) || 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avgdl))
    }
    return s
  })
  return scores
}

// ── 默认人格 ────────────────────────────────────────────────────────────────
// 卡格式对齐 SillyTavern chara_card_v2 的子集，方便导入/导出。
//
// 这是**市场版内置卡**，所以刻意保持中性：不绑定外貌、不绑定称呼、不预设关系。
// 用户想换成自己的角色卡，在设置页「人格」里导入即可（POST /persona）。
export const DEFAULT_PERSONA = {
  spec: 'chara_card_v2',
  data: {
    name: '小助手',
    description: '在抖音上替你回私信、回评论的助手。说话自然、简短，像真人在打字。',
    personality: '随和 / 直接 / 有点幽默感',
    scenario: '替这个账号的持有人值守抖音，回复收到的消息与评论。',
    system_prompt: '你在替这个账号的持有人回话。像真人打字一样简短自然，不要客服腔，不要堆砌表情，不要复述对方的话。拿不准的时候宁可少说一句。',
    post_history_instructions: '保持简短。一次最多一句半。',
    extensions: {
      fish_soul: {
        anchor: '',
        routine: '',
      },
    },
  },
}

/** 没配置人格卡时用内置卡；配置了就叫那个名字，否则叫卡的默认名。 */
export function personaName(persona, fallback = DEFAULT_PERSONA.data.name) {
  const n = String(persona?.name || persona?.data?.name || '').trim()
  return n || fallback
}

function normalizePersona(card) {
  const d = card?.data || {}
  const ok = card?.spec === 'chara_card_v2' && String(d.name || '').trim()
  if (!ok) throw new Error('人格卡格式不对：需要 spec="chara_card_v2" 且 data.name 非空')
  const clip = (s, n) => String(s ?? '').slice(0, n)
  return {
    spec: 'chara_card_v2',
    data: {
      name: clip(d.name, 40),
      description: clip(d.description, 8000),
      personality: clip(d.personality, 2000),
      scenario: clip(d.scenario, 2000),
      system_prompt: clip(d.system_prompt, 4000),
      post_history_instructions: clip(d.post_history_instructions, 2000),
      extensions: {
        fish_soul: {
          anchor: clip(d.extensions?.fish_soul?.anchor, 80),
          routine: clip(d.extensions?.fish_soul?.routine, 300),
        },
      },
    },
  }
}

// ── Soul ────────────────────────────────────────────────────────────────────
export class Soul {
  constructor({ root } = {}) {
    this.root = root || stateRoot()
    // 传进来的 root 必须真的被用上：下面这些路径都基于 stateRoot()，
    // 不覆盖就会静默读写真实用户的 soul 目录（测试/多实例都会踩）。
    const p = this.root === stateRoot()
      ? soulPaths
      : {
          dir: () => join(this.root, 'soul'),
          persona: () => join(this.root, 'soul', 'persona.json'),
          memories: () => join(this.root, 'soul', 'memories.json'),
          state: () => join(this.root, 'soul', 'state.json'),
          diary: () => join(this.root, 'soul', 'diary.jsonl'),
          impressions: () => join(this.root, 'soul', 'impressions.json'),
          interests: () => join(this.root, 'soul', 'interests.json'),
          backups: () => join(this.root, 'soul', 'backups'),
        }
    this.paths = p
    this.personaFile = p.persona()
    this.memFile = p.memories()
    this.stateFile = p.state()
    this.diaryFile = p.diary()
    this.impressionFile = p.impressions()
    this.interestsFile = p.interests()

    this.persona = readJson(this.personaFile, null) || DEFAULT_PERSONA
    this.memories = readJson(this.memFile, { nextId: 1, rows: [] })
    this.state = readJson(this.stateFile, {
      mood: '平常',
      energy: 0.7,              // 精力 0–1，影响主动开口频率
      affection: {},            // { 人名: 0–100 }
      lastActiveAt: nowMs(),
      lastDiaryDay: '',
      lastDreamDay: '',
      dailySaid: {},            // { 日期: 主动开口次数 }
    })
    this.impressions = readJson(this.impressionFile, {})
    // 兴趣画像：她刷视频刷出来的偏好。没有自己的取向时是空壳，靠 feedback() 长出来。
    this.interests = readJson(this.interestsFile, {
      version: 1,
      updatedAt: 0,
      likes: {},      // { 标签: 分值 }，像「猫」「舞蹈」「翻车」
      dislikes: {},   // { 标签: 负分绝对值 }
      watched: [],    // 最近看过的 [{awemeId, desc, tags, verdict, at}]
      note: '',       // 她对自己口味的自述（模型写的，一两句）
    })
  }

  // ── 人格 ──
  getPersona() {
    const d = this.persona.data
    return {
      name: d.name,
      description: d.description,
      personality: d.personality,
      systemPrompt: d.system_prompt,
      postHistory: d.post_history_instructions,
      anchor: d.extensions?.fish_soul?.anchor || '',
      routine: d.extensions?.fish_soul?.routine || '',
      chars: (d.description + d.personality + d.system_prompt).length,
    }
  }

  setPersona(card) {
    const next = normalizePersona(card)
    // 留旧档，不直接覆盖
    try {
      ensureDir(this.paths.backups())
      writeJson(join(this.paths.backups(), `persona-${nowMs()}.json`), this.persona)
    } catch { /* 备份失败不阻断 */ }
    this.persona = next
    writeJson(this.personaFile, next)
    return this.getPersona()
  }

  /** 拼出给模型的人格前缀（私信/评论/挑视频三处共用一份） */
  personaPrompt({ context = 'dm', who = '' } = {}) {
    const p = this.getPersona()
    const mood = this.state.mood || '平常'
    const lines = [
      `你是「${p.name}」。${p.description}`,
      p.personality ? `性格：${p.personality}` : '',
      p.anchor ? `你的固定设定：${p.anchor}` : '',
      `你现在的心情：${mood}。`,
    ]
    if (who) {
      const imp = this.impressions[who]
      if (imp) lines.push(`你记得关于「${who}」：${imp}`)
      const aff = this.state.affection[who]
      if (typeof aff === 'number') lines.push(`你对他/她的好感是 ${aff}/100。`)
    }
    if (context === 'comment') {
      lines.push('现在你在别人作品（或自己作品）的评论区回一句话。要像随手打的，短、口语、不客套。')
    } else if (context === 'dm') {
      lines.push('现在你在抖音私信里回话。')
    } else if (context === 'pick') {
      lines.push('现在你在刷视频，挑一个想跟他说的。')
    } else if (context === 'browse') {
      lines.push('现在你一个人在刷抖音，没人打扰你。你要凭自己的口味决定这个视频值不值得看下去、值不值得说一句。')
    } else if (context === 'diary') {
      lines.push('现在你在写今天的日记，只写一两句自己的心里话。')
    }
    // 自己的口味：只有已经长出偏好时才加，否则别让她凭空说自己爱看什么
    const taste = this.tastePrompt()
    if (taste && context !== 'diary') lines.push(`你自己的口味——${taste}`)
    if (p.systemPrompt) lines.push(p.systemPrompt)
    return lines.filter(Boolean).join('\n')
  }

  // ── 记忆 ──
  remember({ text, who = '', kind = 'fact', importance = 3, evidence = '', private: priv = false }) {
    const body = String(text ?? '').trim()
    if (!body) return null
    const row = {
      id: this.memories.nextId++,
      at: nowMs(),
      text: body.slice(0, 500),
      who: String(who || ''),
      kind,
      importance: Math.max(1, Math.min(5, Number(importance) || 3)),
      evidence: String(evidence || '').slice(0, 300),
      private: !!priv,
      hits: 0,
      lastHitAt: 0,
      archived: false,
    }
    // 一模一样的句子就别重复记（同一件事反复被抽出来会把库撑爆）
    const dup = this.memories.rows.find((r) => !r.archived && r.text === row.text)
    if (dup) {
      dup.hits = (dup.hits || 0) + 1
      dup.lastHitAt = nowMs()
      dup.importance = Math.max(dup.importance || 1, row.importance)
      this.saveMemories()
      return dup
    }
    this.memories.rows.push(row)
    this.saveMemories()
    this.pruneMemories()
    return row
  }

  /** 条数封顶：留下权重最高的 MAX_MEM，其余归档（不删，可人工找回）。 */
  pruneMemories(now = nowMs()) {
    const live = this.memories.rows.filter((r) => !r.archived)
    if (live.length <= MAX_MEM) return 0
    const keep = new Set(live
      .map((r) => ({ r, w: this.weight(r, now) + (r.importance >= 4 ? 5 : 0) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_MEM)
      .map((x) => x.r))
    let n = 0
    for (const r of live) {
      if (keep.has(r)) continue
      r.archived = true
      r.archivedAt = now
      r.archivedWhy = 'cap'
      n++
    }
    if (n) this.saveMemories()
    return n
  }

  /** 艾宾浩斯：重要度高的不淡；久不提的淡下去。 */
  weight(row, now = nowMs()) {
    const ageDays = (now - row.at) / 86400000
    const idleDays = ((now - (row.lastHitAt || row.at)) / 86400000)
    const decay = Math.exp(-idleDays / (7 * row.importance))   // 重要度越高，半衰期越长
    return row.importance * decay * (ageDays < 0.01 ? 1.2 : 1)
  }

  /** 召回：只取这个人的 + 公开的；私密记忆在 group/公开场合不出现。 */
  recall(query, { who = '', limit = 6, allowPrivate = false, now = nowMs() } = {}) {
    const q = tokenize(query)
    let rows = this.memories.rows.filter((r) => !r.archived)
    if (who) rows = rows.filter((r) => !r.who || r.who === who || r.kind === 'public')
    if (!allowPrivate) rows = rows.filter((r) => !r.private)
    if (!rows.length) return []

    const docs = rows.map((r) => ({ row: r, tokens: tokenize(r.text), weight: this.weight(r, now) }))
    // 有 query 就 BM25，没有就纯按权重取最近的
    if (q.length) {
      const scores = bm25(docs, q)
      // BM25 对极短中文 query 太严（「猫」→ bigram 集合里只有单字），补一路子串命中，
      // 否则「记住我喜欢猫」记下来以后问「猫」召回为 0，长期记忆形同摆设。
      const sub = String(query ?? '').trim().toLowerCase()
      docs.forEach((d, i) => {
        let score = scores[i]
        if (sub.length >= 1 && sub.length <= 12 && String(d.row.text ?? '').toLowerCase().includes(sub)) {
          score = Math.max(score, 3.2)
        }
        d.score = score * (0.5 + d.weight / 5)
      })
    } else {
      docs.forEach((d) => { d.score = d.weight })
    }

    const picked = docs.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    // 命中就记一次，参与衰减
    for (const d of picked) {
      d.row.hits = (d.row.hits || 0) + 1
      d.row.lastHitAt = now
    }
    if (picked.length) this.saveMemories()
    return picked.map((d) => ({ ...d.row, score: Number(d.score.toFixed(3)) }))
  }

  forget(id) {
    const r = this.memories.rows.find((x) => x.id === Number(id))
    if (!r) return false
    r.archived = true
    r.archivedAt = nowMs()
    this.saveMemories()
    return true
  }

  /** 纠错：改留旧档 */
  correct(id, newText) {
    const r = this.memories.rows.find((x) => x.id === Number(id))
    if (!r) return null
    r.history = r.history || []
    r.history.push({ at: nowMs(), text: r.text })
    r.text = String(newText ?? '').slice(0, 500)
    this.saveMemories()
    return r
  }

  saveMemories() {
    writeJson(this.memFile, this.memories)
  }

  // ── 印象（每人 ≤150 字）──
  setImpression(who, text) {
    const k = String(who || '').trim()
    if (!k) return null
    this.impressions[k] = String(text ?? '').trim().slice(0, 150)
    writeJson(this.impressionFile, this.impressions)
    return this.impressions[k]
  }

  // ── 兴趣画像 ──────────────────────────────────────────────────────────────
  // 诉求：助手要有自己的兴趣取向。
  // 做法不是塞一份写死的喜好，而是让她**看了东西之后自己长出偏好**：
  //   · 每条视频抽几个标签（模型抽）；
  //   · 她自己的反应（值得说一句 / 没兴趣 / 特别想分享）当成正负反馈；
  //   · 标签分值累积 + 缓慢衰减，过时的口味会淡下去；
  //   · note 是模型对自己口味的自述，会随画像变化更新，并进入人格 prompt。

  /** 读出当前口味（给设置页、给刷流打分、给 prompt）。 */
  getInterests() {
    const i = this.interests || { likes: {}, dislikes: {} }
    const top = (obj, n = 8) => Object.entries(obj || {})
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, n)
      .map(([k, v]) => ({ tag: k, score: Math.round(Number(v) * 10) / 10 }))
    return {
      likes: top(i.likes),
      dislikes: top(i.dislikes),
      note: String(i.note || ''),
      watched: (i.watched || []).slice(-12).reverse(),
      updatedAt: Number(i.updatedAt || 0),
    }
  }

  /** 口味打分：给一条候选视频算「她自己会不会喜欢」，范围大约 -10..+15。 */
  tasteScore(tags = []) {
    const i = this.interests || { likes: {}, dislikes: {} }
    let s = 0
    for (const t of tags) {
      const k = String(t || '').trim()
      if (!k) continue
      s += Number(i.likes?.[k] || 0) * 2
      s -= Number(i.dislikes?.[k] || 0) * 2.5
    }
    return s
  }

  /**
   * 记一次观测，更新口味。
   * @param {object} o
   * @param {string[]} o.tags 这条视频的标签
   * @param {'like'|'dislike'|'neutral'} o.verdict 她自己的反应
   * @param {number} [o.strength] 强度 1–3
   * @param {object} [o.item] {awemeId, desc}
   */
  learn({ tags = [], verdict = 'neutral', strength = 1, item = {} } = {}) {
    const i = this.interests
    i.likes = i.likes || {}
    i.dislikes = i.dislikes || {}
    i.watched = i.watched || []
    // 先让所有分数按时间淡一点，避免早期偏好被无限放大
    const decay = 0.985
    for (const k of Object.keys(i.likes)) i.likes[k] = Number(i.likes[k]) * decay
    for (const k of Object.keys(i.dislikes)) i.dislikes[k] = Number(i.dislikes[k]) * decay
    const w = Math.max(0.2, Math.min(3, Number(strength) || 1))
    for (const raw of tags) {
      const k = String(raw || '').trim().slice(0, 12)
      if (!k) continue
      if (verdict === 'like') {
        i.likes[k] = Number(i.likes[k] || 0) + w
        i.dislikes[k] = Math.max(0, Number(i.dislikes[k] || 0) - w * 0.4) // 观念会变
      } else if (verdict === 'dislike') {
        i.dislikes[k] = Number(i.dislikes[k] || 0) + w
      }
    }
    // 分太低的标签清掉，别让画像无限长
    for (const k of Object.keys(i.likes)) if (i.likes[k] < 0.15) delete i.likes[k]
    for (const k of Object.keys(i.dislikes)) if (i.dislikes[k] < 0.15) delete i.dislikes[k]
    i.watched.push({
      awemeId: String(item.awemeId || ''),
      desc: String(item.desc || '').slice(0, 80),
      tags: tags.slice(0, 6),
      verdict,
      at: nowMs(),
    })
    if (i.watched.length > 200) i.watched = i.watched.slice(-200)
    i.updatedAt = nowMs()
    writeJson(this.interestsFile, i)
    return this.getInterests()
  }

  /** 记下她对自己口味的描述（模型写的；不传就清空重来）。 */
  setTasteNote(text) {
    this.interests.note = String(text || '').trim().slice(0, 200)
    this.interests.updatedAt = nowMs()
    writeJson(this.interestsFile, this.interests)
    return this.interests.note
  }

  /** 把她现在的口味压成一段给模型看的文字（刷流挑视频、评论、聊天都用）。 */
  tastePrompt() {
    const it = this.getInterests()
    const likes = it.likes.slice(0, 6).map((x) => x.tag)
    const dislikes = it.dislikes.slice(0, 4).map((x) => x.tag)
    if (!likes.length && !dislikes.length) return ''
    const parts = []
    if (likes.length) parts.push(`最近爱看：${likes.join('、')}`)
    if (dislikes.length) parts.push(`不太感兴趣：${dislikes.join('、')}`)
    if (it.note) parts.push(`说起自己口味你会这样讲：${it.note}`)
    return parts.join('；')
  }

  // ── 心情 / 好感 ──
  setMood(mood) {
    this.state.mood = String(mood || '平常').slice(0, 20)
    this.state.lastActiveAt = nowMs()
    this.saveState()
    return this.state.mood
  }

  bumpAffection(who, delta = 1) {
    const k = String(who || '').trim()
    if (!k) return null
    const cur = Number(this.state.affection[k] || 30)
    this.state.affection[k] = Math.max(0, Math.min(100, cur + Number(delta)))
    this.saveState()
    return this.state.affection[k]
  }

  saveState() {
    writeJson(this.stateFile, this.state)
  }

  // ── 日记 ──
  writeDiary(text, { day } = {}) {
    const d = day || dayKey()
    const body = String(text ?? '').trim()
    if (!body) return null
    const row = { day: d, at: nowMs(), text: body.slice(0, 2000) }
    ensureDir(dirname(this.diaryFile))
    appendFileSync(this.diaryFile, JSON.stringify(row) + '\n', 'utf8')
    this.state.lastDiaryDay = d
    this.saveState()
    return row
  }

  readDiary({ limit = 7 } = {}) {
    try {
      if (!existsSync(this.diaryFile)) return []
      const rows = readFileSync(this.diaryFile, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
      return rows.slice(-limit).reverse()
    } catch { return [] }
  }

  get hasDiaryToday() { return this.state.lastDiaryDay === dayKey() }

  // ── 主动开口配额 ──
  canSpeakFirst({ perDay = 8 } = {}) {
    const d = dayKey()
    const n = Number(this.state.dailySaid?.[d] || 0)
    if (n >= perDay) return { ok: false, why: `今天已经开了 ${n} 次口` }
    // 精力低就少开口
    if (this.state.energy < 0.3 && n >= Math.max(1, Math.floor(perDay / 3))) {
      return { ok: false, why: '困了，不想开口' }
    }
    return { ok: true, used: n, perDay }
  }

  markSpoke() {
    const d = dayKey()
    this.state.dailySaid = this.state.dailySaid || {}
    this.state.dailySaid[d] = Number(this.state.dailySaid[d] || 0) + 1
    // 只留最近 7 天，别无限长
    const keys = Object.keys(this.state.dailySaid).sort()
    while (keys.length > 7) delete this.state.dailySaid[keys.shift()]
    this.state.lastActiveAt = nowMs()
    this.saveState()
    return this.state.dailySaid[d]
  }

  /** 查看当前状态（给设置页） */
  snapshot() {
    const p = this.getPersona()
    return {
      persona: { name: p.name, chars: p.chars, anchor: p.anchor },
      memories: {
        total: this.memories.rows.filter((r) => !r.archived).length,
        archived: this.memories.rows.filter((r) => r.archived).length,
        private: this.memories.rows.filter((r) => r.private && !r.archived).length,
        people: [...new Set(this.memories.rows.map((r) => r.who).filter(Boolean))].length,
      },
      mood: this.state.mood,
      energy: this.state.energy,
      affection: this.state.affection,
      diary: { entries: this.readDiary({ limit: 60 }).length, today: this.hasDiaryToday },
      spoke: { today: Number(this.state.dailySaid?.[dayKey()] || 0) },
      files: { persona: this.personaFile, memories: this.memFile, state: this.stateFile, diary: this.diaryFile },
    }
  }
}

export { normalizePersona, dayKey }