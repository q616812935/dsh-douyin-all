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
// 默认原则：能不说话就不说话。除了「谁来信就回谁」，其他全关。
export const DEFAULTS = {
  // 浏览器
  port: 9334,
  headless: true,
  browserPath: '',
  // 主人：你的抖音昵称（用来判断「这是自己」）与你要她盯的那个对端
  owner: '蓝毛小女仆',
  peer: '爱睡觉的kevin',
  // 人格
  persona: {
    name: '大肥鱼',
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
    speakFirst: true,         // 允许她主动开口
    perDay: 40,               // 主动开口每天上限
    replyDelayMs: 4000,       // 收到后故意等一会儿再回，别像机器人秒回
    voiceReply: false,        // 回完文字再补一条语音
    voicePreset: '萝莉',
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
    skipNicks: ['豆包', '抖音求真'],
  },
  // 刷流 / 转发
  feed: {
    enabled: true,
    count: 6,
    shareToPeer: false,       // 挑到好玩的视频要不要转发给对端（默认关）
    like: [],                 // 加分关键词
    dislike: ['游戏直播', '带货'], // 减分关键词
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
