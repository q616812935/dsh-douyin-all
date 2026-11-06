/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / setup.mjs — 首次开通向导
//
// 为什么需要它：插件自己拉起的是一个**无头** Edge，用户看不见那个窗口，也就没法扫码登录；
// 而 owner / peer 两个字段只要填错，插件要么判断不出「哪些是自己的作品」，
// 要么把消息发给错的真人。所以把「登录 → 认出自己是谁 → 选对端」做成一个显式的状态机，
// 每一步都能被接口探测到底做没做到，而不是靠用户猜。
//
// 状态机（config.setup.step）：
//   login    —— 还没登录：宿主会以有头模式拉起浏览器，用户在那个窗口里扫码
//   identify —— 登录了但还不知道自己是哪个账号：把名字填进 owner
//   peer     —— 知道是谁了，但还没选对端：从会话列表里挑一个人
//   done     —— 全部就绪，出站解锁
//
// 为什么每一步都带 verify()：用户可能手动改 config.json，也可能在两台机器之间拷了配置。
// 推进状态之前一律以「现在真的做得到吗」为准，而不是以「上次我们以为推进到哪了」为准。

import * as chat from './chat.mjs'
import * as api from './api.mjs'
import { readState, writeState } from './state.mjs'

export const STEPS = ['login', 'identify', 'peer', 'done']

/** step 的规范化：不认识的（含老版本没有 setup 字段时的 undefined）一律从 login 开始。 */
export function normalizeStep(v) {
  const s = String(v || '').trim()
  return STEPS.includes(s) ? s : 'login'
}

/** 向导没走完之前，所有对外发送都必须锁死。 */
export function outboundLocked(cfg) {
  return normalizeStep(cfg?.setup?.step) !== 'done'
}

/**
 * 只把 UI 表单字段里「空着的」补回默认值；引擎字段（setup / home / port / model …）不动。
 *
 * 为什么需要它：0.1.x 的设置页保存时把 mergeDefaults 之后的全量写进了 config.json，
 * 于是「改默认值」对老用户完全无效。用户在界面上把输入框清空时，本意就是「回到默认」。
 *
 * @param {object} cur 当前（已与 DEFAULTS 合并过的）配置
 * @param {object} base DEFAULTS
 */
export function restoreDocumentedDefaults(cur, base) {
  const out = JSON.parse(JSON.stringify(cur || {}))
  const emptyToken = (v) => v === undefined || v === null || v === ''
  const emptyList = (v) => !Array.isArray(v) || v.length === 0
  const put = (path, keep) => {
    const [a, b] = path
    const target = out[a]
    if (!target || typeof target !== 'object') return
    if (keep(target[b])) target[b] = JSON.parse(JSON.stringify(base[a][b]))
  }
  // 人格：名字空着 = 用内置中性人格卡
  if (!out.persona || typeof out.persona !== 'object') out.persona = {}
  if (emptyToken(out.persona.name)) {
    out.persona.name = base.persona.name
    if (out.persona.preset !== 'custom') out.persona.preset = base.persona.preset
    if (emptyToken(out.persona.card)) out.persona.card = base.persona.card
  }
  // 口味关键词：清空 = 回到「不预设任何偏好」
  put(['feed', 'like'], emptyList)
  put(['feed', 'dislike'], emptyList)
  put(['comments', 'skipNicks'], emptyList)
  // 音色：不选 = 用模块默认
  put(['dm', 'voicePreset'], emptyToken)
  return out
}

// ── 每一步的探测 ────────────────────────────────────────────────────────────

/**
 * 左栏会话列表（登录与否、对端在不在，都看它）。
 *
 * ⚠️ 这里收到的 p 是 `loop.onPage` 交出来的**新页 send 通道**（`r.s`），
 * 而不是 round 对象本身 —— 早期版本把页面当成 round 传下去，导致
 * `conversationRows` 等满 15 秒超时后稳定返回空数组，于是「登录了但零会话」
 * 与「根本没登录」永远分不开。
 */
async function leftRows(p, waitMs = 15000) {
  try {
    const rows = await chat.conversationRows(p, { waitMs })
    return Array.isArray(rows) ? rows : []
  } catch { return [] }
}

/**
 * 在一个干净页上真的读一遍抖音，给调用方一个现成的 onPage 工厂。
 * loop.mjs 已有 makeRound/onPage，这里只负责「拿到页面后做什么」。
 */

/**
 * 走一次探测，返回可以原样喂给设置页的状态。
 *
 * @param {object} t
 * @param {(p:any)=>Promise<any>} t.onPage 在当前这一轮里开一个干净页并执行
 * @param {(p:any)=>string} [t.detect] 页面看不出登录态时（比如 cookie 被拦）用的外部判据，返回'ok'|'login'|''
 * @param {object} t.cfg 当前配置
 * @param {boolean} [t.deep] 是否连「自己的昵称」一起查（要打接口，慢几百毫秒）
 * @param {number} [t.waitMs] 等左栏渲染的上限（默认 15 秒；测试里给 0 免得干等）
 */
export async function probe({ onPage, cfg, deep = true, detect = null, waitMs = 15000 }) {
  const c = cfg || {}
  const step = normalizeStep(c.setup?.step)
  const out = {
    step,
    locked: step !== 'done',
    at: Number(c.setup?.at || 0),
    owner: String(c.owner || '').trim(),
    peer: String(c.peer || '').trim(),
    loggedIn: false,
    rows: [],
    me: '',
    suggested: '',
    can: { login: false, identify: false, peer: false, done: false },
    hint: '',
  }

  const scan = await onPage(async (p) => {
    const rows = await leftRows(p, waitMs)
    const me = deep ? await recognizeMe(p, c) : null
    return { rows, me, pageSend: p }
  }).catch((e) => ({ error: String(e?.message || e) }))
  if (scan?.error) {
    out.hint = '打不开抖音页面：' + scan.error
    return out
  }

  out.rows = (scan.rows || []).map(toRow)
  // 会话列表为空有两种可能：没登录，或者登录了但一个会话都没有。
  // 只凭「左栏空」就判没登录会把老用户误关在门外，所以再要一个外部判据。
  let verdict = out.rows.length > 0 ? 'ok' : ''
  if (!verdict && typeof detect === 'function') {
    try { verdict = String((await detect(scan.pageSend)) || '') } catch { verdict = '' }
  }
  out.loggedIn = verdict === 'ok' || out.rows.length > 0

  if (!out.loggedIn) {
    out.me = ''
    out.step = 'login'
    out.locked = true
    out.can.login = true
    out.hint = '浏览器里的抖音还没登录：点「打开浏览器登录」在弹出的窗口里扫码，登好了回来点「我已登录」。'
    return out
  }

  out.me = scan.me?.nick || ''

  if (!out.owner) {
    // 有昵称就直接用；没有就让用户在界面上填
    out.step = 'identify'
    out.locked = true
    out.can.identify = true
    // 「这是我」这个按钮只在真的识别到昵称时才有意义；同时把识别结果带回去，
    // 让界面能一键填入，而不是让用户对着一个 slug 自己猜自己的昵称。
    out.suggested = scan.me?.nick || ''
    out.hint = out.me
      ? `已经登录（识别到 @${out.me}），点「这是我」把它设成账号持有人。`
      : '已经登录，但没识别出你的昵称：请在设置页填上你自己的抖音昵称。'
    return out
  }

  if (!out.peer) {
    out.step = 'peer'
    out.locked = true
    out.can.peer = out.rows.length > 0
    out.hint = out.rows.length
      ? '从下面对话里挑一个人作为对端（它只会回这个人，也只会跟这个人说话）。'
      : '左栏一个会话都没有：先在抖音里跟平时聊天的人说一句话，再刷新。'
    return out
  }

  const hasPeer = out.rows.some((r) => r.nick === out.peer)
  if (!hasPeer) {
    out.step = 'peer'
    out.locked = true
    out.can.peer = true
    out.hint = `左栏里暂时找不到「${out.peer}」——它可能在折叠区，或昵称改过。确认一次仍可以继续。`
    return out
  }

  out.step = 'done'
  out.locked = false
  out.can.done = true
  out.hint = `已就绪：以 @${out.owner} 的身份陪着「${out.peer}」。`
  return out
}

/**
 * 把 `chat.conversationRows` 的一行整理成向导用的形状。
 *
 * ⚠️ conversationRows 给的是 `{text, parts}`，**没有 nick 字段**。
 * text 形如「爱睡觉的kevin 刚刚 哈喽」，用空格切首段在昵称本身带空格时会被切坏，
 * 所以优先用 parts[0]（页面上第一段叶子文本，恰好就是昵称）。
 */
function toRow(r) {
  const text = String(r.text || '')
  const parts = Array.isArray(r.parts) ? r.parts.map((s) => String(s || '').trim()).filter(Boolean) : []
  const nick = String(r.nick || '').trim()
    || parts[0]
    || text.split(/\s+/)[0]
    || ''
  return { nick, text: text.slice(0, 120), unread: Array.isArray(r.unread) ? r.unread.length : 0 }
}

/**
 * 认出「现在登录的是谁」。
 *
 * 顺序有讲究：/im/user/info/ 最准但偶尔拿不到 nickname，作品列表只认一个判据
 * （它是自己的作品，作者昵称就是自己），会话列表最后兜底。
 * 全都认不出就返回 null —— 让用户手填，绝不猜一个名字写进 owner。
 */
export async function recognizeMe(p, cfg) {
  const wm = readState('setup-probe.json', {}) || {}
  try {
    const info = await api.whoAmI(p)
    const nick = String(info?.data?.user?.nickname || info?.data?.nickname || info?.user?.nickname || '').trim()
    if (nick) {
      writeState('setup-probe.json', { ...wm, me: nick, at: Date.now(), via: 'im' })
      return { nick, via: 'im' }
    }
  } catch { /* 继续下一个判据 */ }

  try {
    const mine = await api.myWorks(p, { count: 1 })
    const first = (mine?.aweme_list || [])[0]
    const nick = String(first?.author?.nickname || '').trim()
    if (nick) {
      writeState('setup-probe.json', { ...wm, me: nick, at: Date.now(), via: 'works' })
      return { nick, via: 'works' }
    }
  } catch { /* 继续 */ }

  return cfg?.owner ? { nick: String(cfg.owner).trim(), via: 'config' } : null
}

/**
 * 用一轮已经建好的上下文跑探测（loop.mjs 的 makeRound 返回值直接可用）。
 *
 * @param {object} round 含 {cfg, onPage}
 * @param {object} [extra] 透传给 probe 的其余参数（deep / detect）
 */
export async function probeOnRound(round, extra = {}) {
  return probe({
    ...extra,
    cfg: round.cfg,
    onPage: (fn) => round.onPage(fn),
  })
}
