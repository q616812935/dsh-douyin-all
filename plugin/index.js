/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
/**
 * dsh-douyin-all —— 抖音自动陪伴（私信 / 评论 / 刷流转发 / 人格记忆 / 语音 / 日报）
 *
 * 设计上只有「一个浏览器、一套人格、一个闸门、一个设置页」：
 *   · 专用 Edge 一个进程（CDP 9334），所有页面操作都经由 loop.mjs 开新页做完即收；
 *   · 人格与长期记忆在 soul/ 目录（persona.json / memories.json / diary.jsonl）；
 *   · 所有对外的话都先过 guard.mjs（长度、禁止词、按目标去重、按小时/按天配额）；
 *   · 模型默认跟随宿主 DSH 设置页选的那个（brain.mjs 的宿主通道），另可配兼容端点兜底。
 *
 * 给 agent 的工具：
 *   douyin_status / douyin_watch / douyin_dm / douyin_comment / douyin_share / douyin_remember / douyin_recall
 * 给用户的入口：设置 → 刷抖音（页面由 client 侧提供，API 在本文件里的 /api/douyin-all/*）
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stateRoot, setStateRoot, paths, ensureEdge, connect, healthCheck } from './edge.mjs'
import { loadConfig, saveConfig, mergeDefaults, readState, writeState, readEvents, runOnce, appendEvent } from './state.mjs'
import { Soul, normalizePersona } from './soul.mjs'
import { Brain } from './brain.mjs'
import { Guard } from './guard.mjs'
import * as loop from './loop.mjs'
import * as report from './report.mjs'
import * as voice from './voice.mjs'
import * as usage from './usage.mjs'
import * as api from './api.mjs'

export const name = 'douyin-all'
export const inject = ['tools', 'systemPrompt', 'llm', 'webServer']
const SECTION_ORDER = 264
const PREFIX = '/api/douyin-all'

// ── 进程内单例（插件被重载时由 dispose 收掉） ────────────────────────────────
let S = null
function singleton(config) {
  if (S) return S
  const cfgBase = config || {}
  // cordis 里写死的 home 必须先落地，否则 config.json / 浏览器 profile 会落到别处
  if (cfgBase.home) setStateRoot(cfgBase.home)
  const load = () => mergeDefaults({ ...loadConfig(), ...pickCfg(cfgBase) })
  const soul = new Soul()
  // ⚠️ 必须调用：paths.ledger 是函数，漏了 () 就等于台账文件名为空 → 永不落盘 → 去重失效
  const guard = new Guard({ file: paths.ledger(), policy: guardPolicy(load()) })
  const brain = new Brain({ getConfig: load, llm: S?.ctx?.llm || null, log: (lvl, m) => log(lvl, m) })
  const auto = { timer: null, next: 0, running: false, runningSince: 0, lastAt: null, lastResult: null, startedAt: new Date().toISOString() }
  S = { ctx: null, config: cfgBase, soul, guard, brain, auto, load }
  return S
}
/** cordis.patch.yml 里配的字段（端口/状态目录/浏览器路径/模型）优先于 config.json。 */
function pickCfg(c) {
  const o = {}
  if (c.port) o.port = Number(c.port)
  if (c.home) o.home = String(c.home)
  if (c.headless !== undefined) o.headless = !!c.headless
  if (c.browserPath) o.browserPath = String(c.browserPath)
  if (c.model) o.model = c.model
  return o
}
function guardPolicy(cfg) {
  const c = cfg.comments || {}
  return {
    maxChars: Number(c.maxChars || 60),
    perHour: Number(c.perHour || 6),
    perDay: Number(c.perDay || 30),
    dedupeHours: Number(c.dedupeHours || 168),
    dmPerHour: 20,
    dmPerDay: 100,
    minGapMs: 8000,
    bannedWords: c.bannedWords || [],
    allowOutsideLink: false,
  }
}

function log(level, msg) {
  try { console.log(`[dsh-douyin-all] ${level}: ${msg}`) } catch { /* ignore */ }
}

// ── 自动调度 ────────────────────────────────────────────────────────────────
// 为什么不是 setInterval：一轮可能跑 1–3 分钟，setInterval 会叠加。
// 这里用「跑完再安排下一次」的单链 setTimeout，进程死掉也不留 zombie。
function scheduleNext(s, delayMs) {
  if (s.auto.timer) clearTimeout(s.auto.timer)
  s.auto.timer = null
  const cfg = s.load()
  if (!cfg.enabled) { s.auto.next = 0; return }
  const gap = Math.max(60000, Number(delayMs ?? (cfg.intervalSeconds || 90) * 1000))
  s.auto.next = Date.now() + gap
  s.auto.timer = setTimeout(() => { void tick(s) }, gap)
  if (typeof s.auto.timer.unref === 'function') s.auto.timer.unref()
}

// 一轮最长按 15 分钟算：超时说明标志位被卡住了（异常路径或进程被打断），
// 不能让它永久挡住后续轮询 —— 线上出现过 running 卡在 true、自动巡检彻底停摆。
const STALE_RUN_MS = 15 * 60 * 1000
function stuck(s) {
  return !!(s.auto.running && s.auto.runningSince && Date.now() - s.auto.runningSince > STALE_RUN_MS)
}

async function tick(s) {
  if (s.auto.running && !stuck(s)) return
  if (stuck(s)) log('warn', '上一轮已卡住超过 15 分钟，强制开始新的轮询')
  s.auto.running = true
  s.auto.runningSince = Date.now()
  try {
    const cfg = s.load()
    const r = await runOnce('round', () => loop.runRound({
      cfg, soul: s.soul, brain: s.brain, guard: s.guard, log, parts: null,
    }))
    s.auto.lastAt = new Date().toISOString()
    s.auto.lastResult = r
  } catch (e) {
    log('error', '一轮失败：' + (e?.message || e))
    appendEvent({ job: 'tick', ok: false, error: String(e?.message || e) })
  } finally {
    s.auto.running = false
    s.auto.runningSince = 0
    try { scheduleNext(s) } catch { /* ignore */ }
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const text = (t) => [{ type: 'text', text: t }]

function statusSnapshot(s) {
  const cfg = s.load()
  const snap = s.soul.snapshot()
  const hc = stateRoot()
  const auto = {
    enabled: !!cfg.enabled,
    running: s.auto.running,
    nextAt: s.auto.next ? new Date(s.auto.next).toISOString() : null,
    lastAt: s.auto.lastAt,
    lastResult: s.auto.lastResult,
  }
  return {
    ok: true,
    text: [
      `大肥鱼抖音助手：${cfg.enabled ? '已开启' : '已暂停'}`,
      `抖音号：${cfg.owner || '未设置'}；对端：${cfg.peer || '未设置'}`,
      `人格：${snap.persona?.name || '?'}（记忆 ${snap.memories?.length ?? 0} 条，好感 ${snap.affection?.[cfg.peer] ?? '-'}）`,
      `模型：${cfg.model?.provider ? cfg.model.provider + '/' + cfg.model.model : '跟随宿主设置'}`,
      `自动轮询：${auto.running ? '正在跑一轮' : auto.nextAt ? '下次 ' + auto.nextAt : '未启动'}`,
      `状态目录：${hc}`,
    ].join('\n'),
    config: cfg,
    soul: { persona: snap.persona?.name, memories: snap.memories?.length ?? 0, diaryToday: s.soul.hasDiaryToday },
    auto,
  }
}

function toolStatus() {
  return defineTool({
    name: 'douyin_status',
    description: '看抖音助手现在的状态：开关、抖音号/对端、人格与记忆条数、模型、自动轮询是否在跑、状态目录。排查任何问题时先调它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          config: { type: 'object', additionalProperties: true },
          soul: { type: 'object', additionalProperties: true },
          auto: { type: 'object', additionalProperties: true },
        },
      },
      render: (_a, v) => text(v.text),
    },
    async execute() { return statusSnapshot(singleton()) },
  })
}

function toolWatch() {
  return defineTool({
    name: 'douyin_watch',
    description: '手动跑一轮抖音巡检（私信 → 自己作品评论 → 刷推荐流）。默认三段都跑；可用 only 只跑某一段。跑完会返回每段的结果。这一轮可能要 1–3 分钟。',
    parameters: {
      only: { type: 'string', description: '只跑这一段：dm / comments / feed / diary。不填就是全部。' },
      force: { type: 'boolean', description: 'dm 段用：即使没有新消息也点开会话看一眼。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          parts: { type: 'object', additionalProperties: true },
        },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const s = singleton()
      const cfg = s.load()
      const only = String(args.only || '').trim()
      const parts = only
        ? { dm: only === 'dm', comments: only === 'comments', feed: only === 'feed', diary: only === 'diary' }
        : null
      const r = await runOnce('round', () => loop.runRound({ cfg, soul: s.soul, brain: s.brain, guard: s.guard, log, parts }))
      const lines = [only ? `只跑了 ${only}` : '跑了一整轮']
      for (const [k, v] of Object.entries(r.parts || {})) {
        lines.push(`· ${k}：${v?.ok ? 'ok' : '失败'} ${v?.why || ''}${v?.posted ? ` 发了 ${v.posted} 条` : ''}${v?.ms ? `（${v.ms}ms）` : ''}`)
      }
      return { ok: true, text: lines.join('\n'), parts: r.parts }
    },
  })
}

function toolDm() {
  return defineTool({
    name: 'douyin_dm',
    description: '看跟对端的私信，或者发一条私信过去。action=read 读最近的几条；action=send 发一条（必须给 text）。',
    parameters: {
      action: { type: 'string', description: 'read 或 send。' },
      text: { type: 'string', description: 'action=send 时要发的内容。' },
      nick: { type: 'string', description: '可选：发给谁，默认用设置里的对端。' },
      count: { type: 'number', description: 'action=read 时读几条，默认 10。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          messages: { type: 'array' },
        },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const s = singleton()
      const cfg = s.load()
      const nick = String(args.nick || cfg.peer || '').trim()
      if (!nick) return { ok: false, text: '没有对端昵称：先去设置里填「对端昵称」。' }
      const action = String(args.action || 'read').trim()
      const round = await loop.makeRound({ cfg, soul: s.soul, brain: s.brain, guard: s.guard, log })
      try {
        return await loop.onPage(round, async (pg) => {
          const oc = await chatOpen(pg, nick)
          if (!oc.ok) return { ok: false, text: '打不开会话：' + (oc.why || oc.code), messages: [] }
          if (action === 'read') {
            const msgs = await readN(pg, Number(args.count || 10))
            return {
              ok: true,
              messages: msgs,
              text: msgs.length ? msgs.map((m) => `${m.mine ? '我' : nick}：${m.text}`).join('\n') : '（这个会话没有消息）',
            }
          }
          const body = String(args.text || '').trim()
          if (!body) return { ok: false, text: 'action=send 需要 text。', messages: [] }
          const g = s.guard.checkDm({ text: body, to: nick })
          if (!g.ok) return { ok: false, text: '闸门拦下了：' + g.why, messages: [] }
          const r = await sendDm(pg, body, nick)
          if (!r.ok) return { ok: false, text: '发送失败：' + (r.why || r.code), messages: [] }
          const rec = s.guard.reserve('dm', { text: body, to: nick, source: 'agent' })
          s.guard.confirm(rec)
          usage.bump('dm.sent', { who: nick })
          return { ok: true, text: `已发给 ${nick}：${body}`, messages: [] }
        })
      } finally { loop.endRound(round) }
    },
  })
}

function toolComment() {
  return defineTool({
    name: 'douyin_comment',
    description: '读抖音评论，或者在评论区回一句。action=read 读某条作品（不给 aweme_id 就是自己最近的）的评论；action=reply 回某条评论（必须给 aweme_id 和 cid 与 text）；action=auto 按规则自动回一批新评论（走闸门）。',
    parameters: {
      action: { type: 'string', description: 'read / reply / auto。' },
      aweme_id: { type: 'string', description: '作品 id（从链接 /video/<id> 里取）。' },
      cid: { type: 'string', description: 'action=reply 时要回的那条评论 id。' },
      text: { type: 'string', description: 'action=reply 时要回的内容（≤60 字）。' },
      count: { type: 'number', description: 'action=read 读几条，默认 20。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          comments: { type: 'array' },
        },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const s = singleton()
      const cfg = s.load()
      const action = String(args.action || 'read').trim()
      const round = await loop.makeRound({ cfg, soul: s.soul, brain: s.brain, guard: s.guard, log })
      try {
        if (action === 'auto') {
          const r = await loop.commentRound(round, {})
          return { ok: !!r.ok, text: `自动评论：${r.posted || 0} 条。${r.why || ''}`, comments: [] }
        }
        return await loop.onPage(round, async (pg) => {
          let id = String(args.aweme_id || '').trim()
          if (!id) {
            const mine = await api.myWorks(pg, { count: 1 })
            const w = (mine?.aweme_list || [])[0]
            id = w?.aweme_id ? String(w.aweme_id) : ''
            if (!id) return { ok: false, text: '没读到你的作品。', comments: [] }
          }
          if (action === 'read') {
            const lc = await commentsList(pg, id, Number(args.count || 20))
            const items = lc.items || []
            return {
              ok: !!lc.ok,
              comments: items.map((c) => ({ cid: c.cid, nick: c.nick, text: c.text, time: c.time })),
              text: items.length
                ? `作品 ${id} 的 ${items.length} 条评论：\n` + items.map((c) => `· ${c.nick}（${c.cid}）：${c.text}`).join('\n')
                : `作品 ${id} 还没有评论。`,
            }
          }
          // reply
          const cid = String(args.cid || '').trim()
          const body = String(args.text || '').trim()
          if (!cid || !body) return { ok: false, text: 'action=reply 需要 cid 和 text。', comments: [] }
          const target = `${id}:${cid}`
          const g = s.guard.checkComment({ awemeId: id, target, text: body, source: 'agent' })
          if (!g.ok) return { ok: false, text: '闸门拦下了：' + g.why, comments: [] }
          const r = await postComment(pg, id, body, cid)
          if (!r.ok) { s.guard.markFailed(g.row, r.code); return { ok: false, text: '发送失败：' + r.code, comments: [] } }
          s.guard.confirm(g.row, { cid: r.cid })
          usage.bump('comment.posted', { aweme: id, cid: r.cid })
          return { ok: true, text: `已回评论（cid ${r.cid}）：${body}`, comments: [] }
        })
      } finally { loop.endRound(round) }
    },
  })
}

function toolShare() {
  return defineTool({
    name: 'douyin_share',
    description: '把一条作品发给对端（通过私信发「一句话 + 链接」，这是实测唯一送达可验证的方式；站点原生分享卡片会被服务端吞掉）。',
    parameters: {
      aweme_id: { type: 'string', description: '作品 id。' },
      nick: { type: 'string', description: '可选：发给谁，默认对端。' },
      text: { type: 'string', description: '可选：附一句自己的话。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true }, url: { type: 'string' } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const s = singleton()
      const cfg = s.load()
      const id = String(args.aweme_id || '').trim()
      if (!id) return { ok: false, text: '需要 aweme_id。' }
      const nick = String(args.nick || cfg.peer || '').trim()
      if (!nick) return { ok: false, text: '没有对端昵称。' }
      const round = await loop.makeRound({ cfg, soul: s.soul, brain: s.brain, guard: s.guard, log })
      try {
        return await loop.onPage(round, async (pg) => {
          const r = await shareSend(pg, { awemeId: id, peer: nick, text: String(args.text || '').trim() || undefined })
          if (r.ok) usage.bump('video.shared', { aweme: id })
          return { ok: !!r.ok, text: r.ok ? `已发给 ${nick}：${r.conv || ''}` : '发送失败：' + (r.why || r.code), url: api.workUrl(id) }
        })
      } finally { loop.endRound(round) }
    },
  })
}

function toolRemember() {
  return defineTool({
    name: 'douyin_remember',
    description: '让她记住一件事（写进长期记忆，以后聊天时会被召回）。比如「对端喜欢猫，讨厌香菜」。',
    parameters: {
      text: { type: 'string', description: '要记的事，一句话。' },
      who: { type: 'string', description: '关于谁（默认对端昵称）。' },
      kind: { type: 'string', description: 'fact / preference / event / promise，默认 fact。' },
      importance: { type: 'number', description: '重要程度 1–5，默认 3。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const s = singleton()
      const cfg = s.load()
      const body = String(args.text || '').trim()
      if (!body) return { ok: false, text: 'text 不能为空。' }
      const m = s.soul.remember({
        text: body,
        who: String(args.who || cfg.peer || '').trim(),
        kind: String(args.kind || 'fact'),
        importance: Number(args.importance || 3),
        evidence: 'agent',
      })
      return { ok: true, text: `记住了（${m?.id || 'ok'}）：${body}` }
    },
  })
}

function toolRecall() {
  return defineTool({
    name: 'douyin_recall',
    description: '按关键词搜索她的长期记忆与日记，返回最相关的几条。',
    parameters: {
      query: { type: 'string', description: '关键词。' },
      who: { type: 'string', description: '可选：只看关于谁的。' },
      limit: { type: 'number', description: '条数，默认 8。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true }, items: { type: 'array' } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const s = singleton()
      const cfg = s.load()
      const q = String(args.query || '').trim()
      const items = s.soul.recall(q, { who: String(args.who || '').trim() || undefined, limit: Number(args.limit || 8) })
      return {
        ok: true,
        items: items.map((x) => ({ text: x.text, who: x.who, kind: x.kind })),
        text: items.length ? items.map((x) => `· [${x.kind || 'fact'}] ${x.text}`).join('\n') : `（没有关于「${q}」的记忆）`,
      }
    },
  })
}

// 轻量包装，避免在工具定义里直接 import 一堆同名函数造成读代码时看不清
async function chatOpen(pg, nick) {
  const m = await import('./chat.mjs')
  return m.openConversation(pg, { nick })
}
async function readN(pg, n) {
  const m = await import('./chat.mjs')
  const all = await m.readMessages(pg)
  return all.slice(-Math.max(1, n))
}
async function sendDm(pg, body, nick) {
  const m = await import('./chat.mjs')
  return m.sendMessage(pg, body, { nick, timeoutMs: 25000 })
}
async function commentsList(pg, id, n) {
  const m = await import('./comments.mjs')
  return m.listComments(pg, id, { max: n })
}
async function postComment(pg, id, body, cid) {
  const m = await import('./comments.mjs')
  return m.postComment(pg, { awemeId: id, text: body, replyId: cid })
}
async function shareSend(pg, o) {
  const m = await import('./share.mjs')
  return m.shareLink(pg, o)
}

const TOOLS = [toolStatus, toolWatch, toolDm, toolComment, toolShare, toolRemember, toolRecall]

function guidanceText() {
  return [
    '本机装有 dsh-douyin-all（抖音自动陪伴）：一个专用 Edge 里跑着「大肥鱼」的抖音号，能收发私信、回评论、刷推荐流并转发视频。',
    '- 想知道她现在什么状态、为什么没动作：先 `douyin_status`，再看 `<stateRoot>/events.jsonl`。',
    '- 要她立刻动一次：`douyin_watch`（可只跑一段）。一轮 1–3 分钟，别连点。',
    '- 要她记住关于对端的事：`douyin_remember`；查她记得什么：`douyin_recall`。',
    '- 她所有对外的话（私信、评论）都会过闸门（≤60 字、禁止词、按目标去重、按小时/天配额），被拦时工具会明说原因，别绕过。',
    '- 不要直接用 CDP 或 node 脚本去操作抖音页面 —— 页面操作全部经由本插件，绕过它就会撞上风控与重复回复。',
  ].join('\n')
}

function visibleToolText(tools, names, value) {
  if (tools === undefined) return () => value
  return (context) => {
    for (const n of names) {
      try { if (tools.get(n, context.scope) !== undefined) return value } catch { return value }
    }
    return ''
  }
}

export function apply(ctx, config) {
  const names = ['douyin_status', 'douyin_watch']
  const tools = TOOLS.map((f) => f())
  let disposeTools
  let disposeSection
  const s = singleton(config)
  s.ctx = ctx
  // 宿主模型挂在 ctx.llm 上；插件加载顺序不保证它已经在，所以每次 apply 都重挂一遍
  try { s.brain.llm = ctx.llm || null } catch { /* ignore */ }

  const disposeAll = () => {
    if (disposeTools !== undefined) { const d = disposeTools; disposeTools = undefined; d() }
    if (disposeSection !== undefined) { const d = disposeSection; disposeSection = undefined; d() }
  }

  const sync = () => {
    const nextTools = tools.map((t) => ctx.tools.register(t))
    const nextSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-douyin-all',
      order: SECTION_ORDER,
      text: visibleToolText(ctx.tools, names, guidanceText()),
    })
    disposeAll()
    disposeTools = ctx.effect(() => () => { for (const d of nextTools) d() }, 'dsh-douyin-all: tools')
    disposeSection = nextSection
  }

  ctx.on('loader/volatile-update', () => {
    try { s.brain.llm = ctx.llm || null; sync() } catch (e) { log('error', 'sync 失败：' + (e?.message || e)) }
  })

  // 自动轮询：插件加载后延迟 20 秒起第一轮（别和 DSH 启动抢资源）
  try { scheduleNext(s, 20000) } catch (e) { log('error', '调度启动失败：' + (e?.message || e)) }

  // ── 设置页 API（前缀 /api/douyin-all） ──
  installApi(ctx, s)

  sync()

  return () => {
    if (s.auto.timer) { clearTimeout(s.auto.timer); s.auto.timer = null }
    disposeAll()
  }
}

// ── HTTP API ────────────────────────────────────────────────────────────────
// DSH 的 HTTP 服务是 `ctx.webServer.register({ kind:'prefix', path, handler })`，
// 返回 disposer。整块用 ctx.effect 挂上，插件卸载/热重载时自动摘掉。
// 安全：读 GET 放开；**写 POST 必须来自本机回环**（DshWeb 经 ssh -L 或局域网暴露时，
// 别人翻开关就是灾难），并且拒跨站 origin（挡 CSRF）。这条规则沿用老 watch 的做法。
/**
 * 设置页只给「名字 + 一大段人设文字」，这里翻成 chara_card_v2。
 * 传进来的如果是原生卡（spec=chara_card_v2）就原样用，方便高级用户直接贴卡。
 */
function personaFromFriendly(b, cur) {
  if (b && b.spec === 'chara_card_v2') return normalizePersona(b)
  const name = String(b?.name ?? cur?.name ?? '大肥鱼').trim().slice(0, 40) || '大肥鱼'
  const card = String(b?.card ?? b?.description ?? cur?.description ?? '')
  const personality = String(b?.personality ?? cur?.personality ?? '')
  const sys = String(b?.systemPrompt ?? cur?.systemPrompt ?? '')
  return normalizePersona({
    spec: 'chara_card_v2',
    data: {
      name,
      description: card,
      personality,
      system_prompt: sys,
      scenario: '',
      post_history_instructions: '',
      extensions: { fish_soul: { anchor: '', routine: '' } },
    },
  })
}

function installApi(ctx, s) {
  const ws = ctx.webServer
  if (!ws || typeof ws.register !== 'function') {
    log('warn', '没有 ctx.webServer，设置页拿不到配置（插件功能不受影响）')
    return
  }

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const t = Buffer.concat(chunks).toString('utf8')
    return t ? JSON.parse(t) : {}
  }
  const denied = (req) => {
    const ra = String(req.socket?.remoteAddress || '')
    const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
    const origin = String(req.headers?.origin || '')
    let sameOrigin = true
    if (origin) {
      try { sameOrigin = new URL(origin).host === String(req.headers?.host || '') } catch { sameOrigin = false }
    }
    if (!sameOrigin) return '跨站请求被拒'
    if (req.method === 'POST' && !loopback) return '改设置必须在本机操作（当前来源 ' + (ra || '?') + '）'
    return ''
  }

  const stateView = async () => {
    const cfg = s.load()
    const snap = s.soul.snapshot()
    const models = await s.brain.listModels().catch(() => [])
    let deps = null
    try { deps = voice.checkDeps() } catch { deps = null }
    return {
      ok: true,
      config: cfg,
      soul: {
        persona: snap.persona,
        memories: snap.memories,   // { total, archived, private, people } —— 设置页按 total 显示
        hasDiaryToday: s.soul.hasDiaryToday,
        affection: snap.affection,
        mood: snap.mood,
      },
      models,
      modelConfigured: !!(cfg.model?.provider && cfg.model?.model),
      auto: { enabled: !!cfg.enabled, running: s.auto.running, nextAt: s.auto.next || null, lastAt: s.auto.lastAt, lastResult: s.auto.lastResult },
      stateRoot: stateRoot(),
      voice: { presets: Object.keys(voice.PRESETS || {}), deps },
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/api\/douyin-all/, '') || '/'
    const why = denied(req)
    if (why) return sendJson(res, 403, { ok: false, error: 'forbidden: ' + why })
    try {
      if (path === '/state' && req.method === 'GET') return sendJson(res, 200, await stateView())
      if (path === '/config' && req.method === 'POST') {
        const patch = await readBody(req)
        const next = mergeDefaults({ ...s.load(), ...patch })
        saveConfig(next)
        s.guard.setPolicy(guardPolicy(next))
        if (!next.enabled) {
          if (s.auto.timer) { clearTimeout(s.auto.timer); s.auto.timer = null }
          s.auto.next = 0
        } else scheduleNext(s)
        return sendJson(res, 200, { ok: true, config: next })
      }
      if (path === '/events' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, events: readEvents({ limit: Number(url.searchParams.get('limit') || 50) }) })
      }
      if (path === '/report' && req.method === 'GET') {
        const days = Number(url.searchParams.get('days') || 1)
        return sendJson(res, 200, {
          ok: true,
          report: report.narrate(days, { name: s.load().persona?.name || '大肥鱼' }),
          usage: usage.range(days),
          diary: s.soul.readDiary({ limit: 7 }),
        })
      }
      if (path === '/health' && req.method === 'GET') {
        const cfg = s.load()
        const hc = await healthCheck(Number(cfg.port || 9334)).catch((e) => ({ ok: false, why: String(e?.message || e) }))
        return sendJson(res, 200, { ok: !!hc.ok, browser: hc, stateRoot: stateRoot() })
      }
      if (path === '/run' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}))
        if (s.auto.running && !stuck(s)) return sendJson(res, 429, { ok: false, error: '上一轮还在跑，等它跑完' })
        const only = String(b.only || '').trim()
        const parts = only ? { dm: only === 'dm', comments: only === 'comments', feed: only === 'feed', diary: only === 'diary' } : null
        s.auto.running = true
        s.auto.runningSince = Date.now()
        try {
          const r = await runOnce('round', () => loop.runRound({ cfg: s.load(), soul: s.soul, brain: s.brain, guard: s.guard, log, parts }))
          s.auto.lastAt = new Date().toISOString()
          s.auto.lastResult = r
          return sendJson(res, 200, { ok: true, result: r })
        } finally { s.auto.running = false; s.auto.runningSince = 0 }
      }
      if (path === '/persona' && req.method === 'POST') {
        const b = await readBody(req)
        const patch = personaFromFriendly(b, s.soul.getPersona())
        s.soul.setPersona(patch)
        appendEvent({ job: 'persona', ok: true, note: '人格已更新' })
        return sendJson(res, 200, { ok: true, persona: s.soul.getPersona() })
      }
      return sendJson(res, 404, { ok: false, error: 'no such endpoint: ' + path })
    } catch (e) {
      log('error', `接口 ${path} 失败：${e?.message || e}`)
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) })
    }
  }

  ctx.effect(() => ws.register({ kind: 'prefix', path: PREFIX, handler }), 'dsh-douyin-all: api')
}
