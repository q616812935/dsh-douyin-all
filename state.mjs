/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / state.mjs — 配置与本地状态
//
// 配置的唯一真源是 `config.json`（DshWeb 是 SYSTEM 进程，改环境变量不现实）。
// 设置页改完立刻落盘，进程重启不丢；`status` 之类的手动写入只当建议值看。

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { stateRoot, ensureDir, sleep } from './edge.mjs'

export function configFile() { return join(stateRoot(), 'config.json') }
export function statusFile() { return join(stateRoot(), 'status.json') }

export function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const t = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!t.trim()) return fallback
    return JSON.parse(t)
  } catch (e) {
    console.error('[dsh-douyin-all] 读取失败，保留原文件不动：' + file + ' → ' + (e && e.message))
    return fallback
  }
}

export function writeJson(file, obj) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, file) // 同盘 rename 是原子的，崩在半路也不会留半个 JSON
}

// ── 默认配置 ────────────────────────────────────────────────────────────────
// 默认原则：装上之后什么都不做。
//
// 这个插件是给陌生人用的，不是给某一个人用的，所以这里**不允许出现任何具体账号、
// 昵称、口味偏好**。owner / peer 默认为空：为空时私信段、分享、@ 账号持有人全部早退，
// 不会替用户去联系任何人。用户必须走完开通向导（setup.step === 'done'）才解锁出站。
export const DEFAULTS = {
  // 浏览器
  port: 9334,
  headless: true,
  browserPath: '',
  // 开通向导：login（扫码登录）→ identify（识别自己的昵称）→ peer（选对端）→ done
  setup: {
    step: 'login',
    at: 0,                    // 最后一次推进的时间
  },
  // 账号持有人：用户自己的抖音昵称（只用来判断「这是自己的作品」与 @ 谁）；未配置则为空
  owner: '',
  // 对端：用户想让她盯的那个人；未配置则私信/分享/@ 全部不动
  peer: '',
  // 人格
  persona: {
    name: '',                 // 空 = 用内置中性人格卡
    preset: 'builtin',        // builtin | custom
    card: '',                 // 自定义人格正文（preset=custom 时生效）
  },
  // 用哪个模型说话。空 = 跟宿主 DSH 设置页选的那个模型走（推荐）。
  model: { provider: '', model: '' },
  // 备用 OpenAI 兼容端点（宿主模型不可用时才用）
  llm: { baseUrl: '', apiKey: '', model: '' },
  // 私信
  dm: {
    enabled: true,
    autoReply: true,
    speakFirst: true,         // 允许她主动开口（需先配好对端）
    perDay: 40,               // 主动开口每天上限
    replyDelayMs: 4000,       // 收到后故意等一会儿再回，别像机器人秒回
    voiceReply: false,        // 回完文字再补一条语音
    voicePreset: '',          // 空 = 用语音模块的默认音色
    // 出站额度与节奏（安全默认：宁可少发。被限了会在事件里说原因，不会静默丢消息）
    maxPerHour: 30,           // 一小时内最多发几条私信
    maxPerDay: 120,           // 一天最多发几条私信（含自动回复与主动开口）
    minGapSeconds: 8,         // 两条私信之间至少隔几秒，避免刷屏节奏
    // 主动开口的频率与免打扰（只管「她主动找你」，不影响「你来了就回」）
    quiet: {
      nightMuted: true,       // 夜间一律不主动发消息
      nightFrom: '22:00',     // 从几点开始安静
      nightTo: '08:00',       // 到几点结束（支持跨零点）
      minGapMinutes: 30,      // 两次主动开口之间至少隔多久
      maxPerDay: 8,           // 每天最多主动开口几次
    },
  },
  // 评论
  comments: {
    selfWorks: true,          // 回自己作品下的评论
    others: false,            // 回别人作品下的评论（默认关，容易惹事）
    scanMinutes: 10,
    maxPerRound: 3,
    maxChars: 60,
    perHour: 6,
    perDay: 30,
    dedupeHours: 168,
    workMaxAgeDays: 7,
    skipNicks: [],            // 不回哪些昵称的评论；默认不设，由用户自己加
    bannedWords: [],          // 额外的禁止词；代码里另有一份内置的站外引导/广告拦截
    allowOutsideLink: false,  // 是否允许回复里带站外链接（默认否）
    strict: true,             // 严格模式：连客服腔/机器人腔也拦（关掉只提示不拦）
  },
  // 刷流 / 转发
  feed: {
    enabled: false,           // 默认关：每轮要看若干条视频并逐条调模型，费额度
    count: 6,
    shareToPeer: false,       // 挑到好玩的视频要不要转发给对端（默认关）
    mentionPeer: false,       // 在自己喜欢的别人作品下 @ 账号持有人（公开评论，默认关）
    tasteLearning: true,      // 每刷一条都用模型看懂并更新自己的口味
    like: [],                 // 加分关键词；默认空，让口味从实际观看里长出来
    dislike: [],              // 减分关键词；默认空
  },
  // 日报
  report: {
    enabled: true,
    hour: 22,                 // 每天几点生成
  },
  // 总开关
  enabled: true,
}

function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v) }

/** 深合并：用 defaults 补全用户配置里缺的键，但不动用户显式写的值。 */
export function mergeDefaults(base, over) {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const k of Object.keys(over)) {
    out[k] = isPlain(base[k]) ? mergeDefaults(base[k], over[k]) : over[k]
  }
  return out
}

export function loadConfig() {
  return mergeDefaults(DEFAULTS, readJsonSafe(configFile(), {}) || {})
}

/** 只写用户显式改过的部分，默认值不落盘（以后改默认值还能生效）。 */
export function saveConfig(cfg) {
  writeJson(configFile(), cfg)
  return cfg
}

// ── 运行时限流状态 ──────────────────────────────────────────────────────────
// 和配置分开：这是「派生的、可以随时删掉」的东西。

export function stateFile(name) { return join(stateRoot(), 'state', name) }

export function readState(name, fallback) {
  return readJsonSafe(stateFile(name), fallback)
}

export function writeState(name, obj) {
  writeJson(stateFile(name), obj)
  return obj
}

// ── 单实例锁 ────────────────────────────────────────────────────────────────
// 插件可能被 DSH 重载（loader/volatile-update）或人工重启，两个循环同时跑会重复回复。
// 老 watch 用的是 watcher.lock 文件；这里用 pid + 心跳，超时就当作上一个进程已经死了。

const LOCK_STALE_MS = 3 * 60 * 1000

export function acquireLock(name = 'main-loop', { force = false } = {}) {
  const f = stateFile('lock-' + name + '.json')
  const cur = readJsonSafe(f, null)
  const now = Date.now()
  if (!force && cur && cur.pid && now - Number(cur.at || 0) < LOCK_STALE_MS) {
    // pid 还活着吗？（同一台机器上可以直接 kill(pid, 0) 探活）
    let alive = false
    try { process.kill(Number(cur.pid), 0); alive = true } catch { alive = false }
    if (alive) return { ok: false, why: `已被 pid ${cur.pid} 持有（${Math.round((now - cur.at) / 1000)} 秒前心跳）`, at: cur.at }
  }
  writeJson(f, { pid: process.pid, at: now })
  return { ok: true, pid: process.pid }
}

export function touchLock(name = 'main-loop') {
  try { writeJson(stateFile('lock-' + name + '.json'), { pid: process.pid, at: Date.now() }) } catch { /* ignore */ }
}

export function releaseLock(name = 'main-loop') {
  const f = stateFile('lock-' + name + '.json')
  const cur = readJsonSafe(f, null)
  if (cur && Number(cur.pid) === process.pid) {
    try { writeFileSync(f, JSON.stringify({ pid: 0, at: 0 }), 'utf8') } catch { /* ignore */ }
  }
}

// ── 后台任务跑一次就退出的模板 ──────────────────────────────────────────────
// 每个后台动作（定向评论扫描、日报、探活）都走这里：
//   抢锁 → 干活 → 释放锁 → 把结果写进 events.jsonl。
// 为什么不用常驻的 setInterval：DSH 的插件进程可能会被重载，
// 而「由 agent 唤醒一次、干完就走」的模型天然幂等，坏了看一眼 events 就知道。

export function appendEvent(ev) {
  const f = stateFile('events.jsonl')
  ensureDir(dirname(f))
  const row = { at: Date.now(), iso: new Date().toISOString(), ...ev }
  try {
    writeFileSync(f, JSON.stringify(row) + '\n', { flag: 'a' })
  } catch (e) {
    console.error('[dsh-douyin-all] 事件写入失败：' + (e && e.message))
  }
  return row
}

export function readEvents({ limit = 50 } = {}) {
  const f = stateFile('events.jsonl')
  try {
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean).slice(-limit).reverse()
  } catch { return [] }
}

/**
 * 跑一个一次性的后台任务，带锁。
 * @param {string} name 锁名（也是事件里的 job 名）
 * @param {(ctx:{note:(s:string)=>void}) => Promise<any>} fn
 */
export async function runOnce(name, fn) {
  const lock = acquireLock(name)
  if (!lock.ok) {
    appendEvent({ job: name, ok: false, skipped: true, why: lock.why })
    return { ok: false, skipped: true, why: lock.why }
  }
  const notes = []
  const note = (s) => { notes.push(String(s)); touchLock(name) }
  const t0 = Date.now()
  try {
    const r = await fn({ note })
    appendEvent({ job: name, ok: true, ms: Date.now() - t0, notes, result: summarize(r) })
    return { ok: true, ms: Date.now() - t0, notes, result: r }
  } catch (e) {
    appendEvent({ job: name, ok: false, ms: Date.now() - t0, notes, error: String(e?.message || e) })
    return { ok: false, ms: Date.now() - t0, notes, error: String(e?.message || e) }
  } finally {
    releaseLock(name)
  }
}

/** 事件日志里不适合塞整个接口响应，截断一下。 */
function summarize(r) {
  if (r == null) return null
  if (typeof r !== 'object') return String(r).slice(0, 300)
  const out = {}
  for (const [k, v] of Object.entries(r)) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, 200)
    else if (Array.isArray(v)) out[k] = `[${v.length}]`
    else out[k] = '{…}'
  }
  return out
}

export { sleep }
