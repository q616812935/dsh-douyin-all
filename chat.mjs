/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / chat.mjs — 私信链路
//
// 这里刻意没有照搬 browser-local 的 chat-service.mjs（104KB，含授权/资格/回执/
// supersede 四套状态机）。那些机制解决的问题是「多个联系人同时来信时怎么排队」，
// 对一个只需要「盯一个人、回他的话」的场景是过度设计。保留的只有两个被实测验证
// 过的关键点：
//
//   1. 后台判定 —— 页面 visibilityState==='visible' && document.hasFocus() 为真时，
//      说明专用浏览器正在前台，此时操作会打扰人也更容易被风控。必须先让窗口后台化。
//      实测矩阵：最小化(hidden/false)=可操作；有别的窗口在前面(visible/false)=可操作；
//      Edge 自己在最前(visible/true)=不可操作。
//
//   2. 会话点开方式 —— 左栏会话行要点 React 的监听器，document.elementFromPoint 后
//      派发完整 pointer 序列才生效（单发 click 会被吞）。点开后右栏 messageMessageBox
//      从 0 变成 N 条即视为成功。
//
// 发送走「真实 DOM 输入 + 点发送」，不是接口 —— 抖音私信没有可用的公开发信接口，
// 这是唯一稳的路。

import { evaluateAsync, sleep } from './edge.mjs'

/**
 * 统一解析出底层 send 函数。
 * chat.mjs 里的函数既接受 openPageSession 返回的会话对象，也接受裸 send 函数，
 * 免得调用方记混（我自己就在这里踩过一次）。
 */
function resolveSend(pageSend) {
  if (typeof pageSend === 'function') return pageSend
  if (pageSend && typeof pageSend.send === 'function') return pageSend.send.bind(pageSend)
  throw new Error('需要一个 CDP 会话对象或 send 函数')
}

// 页面内的探针：把 DOM 状态一次性读出来，省得来回 evaluate。
const PROBE = `(() => {
  const vis = document.visibilityState
  const focus = document.hasFocus()
  const rows = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
  const list = rows.map((el) => {
    const lines = [...el.querySelectorAll('div,span,p')].map(n => (n.textContent||'').trim()).filter(Boolean)
    return {
      text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200),
      lines: [...new Set(lines)].slice(0,6),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })(),
    }
  })
  const boxes = document.querySelectorAll('[class*="messageMessageBox"]').length
  const unread = document.querySelectorAll('[class*="conversationItemUnread"],[class*="badge"]').length
  return { vis, focus, convCount: rows.length, list, boxes, unread, href: location.href }
})()`

/**
 * 后台化：如果专用浏览器抢着前台，就把它最小化。这是让自动回复能工作的前提。
 *
 * 同步返回 { check(pageSend), windowId, targetId } —— 故意不写成 async，
 * 免得调用方忘了 await 拿到一个 Promise 再去找 .check。
 */
export function parkWindowIfForeground(cdp, { targetId, onNote } = {}) {
  let windowId = null
  let resolved = false

  function ensureWindowId() {
    if (resolved || !targetId) return
    // Browser.getWindowForTarget 走根会话，targetId 必须显式给，不给会报 "Invalid parameters"。
    cdp.send('Browser.getWindowForTarget', { targetId }).then((r) => {
      windowId = (r && r.windowId) || null
    }).catch((e) => {
      onNote && onNote('window:no-window-id:' + (e && e.message))
      resolved = true
    })
    // 兜底定标：1 秒内不管成没成都算解析过
    setTimeout(() => { resolved = true }, 1000)
  }

  return {
    get windowId() { return windowId },
    async check(pageSend) {
      ensureWindowId()
      const st = await evaluateAsync(pageSend, `({vis:document.visibilityState,focus:document.hasFocus()})`, 8000)
      if (st && st.focus === true && windowId) {
        try {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
          onNote && onNote('window:forced-minimized')
          await sleep(600)
          return { parked: true, ...st }
        } catch (e) {
          onNote && onNote('window:park-failed:' + (e && e.message))
        }
      }
      return { parked: false, ...st }
    },
  }
}

/** 读左栏会话列表 + 当前右栏状态。 */
export async function readInbox(pageSend) {
  const st = await evaluateAsync(pageSend, PROBE, 12000)
  if (!st) throw new Error('读不到页面状态')
  return st
}

/**
 * 等左栏会话列表渲染出来。
 * ⚠️ 2026-11-03 实测：`/chat` 页刚打开时 `[data-e2e="conversation-item"]` 是 **0 个**，
 * 会再过 1–3 秒才异步填进来。所以任何"读会话列表"的动作之前都得先等这一步，
 * 否则会稳定地读到空数组、并把"没会话"当成"未登录"。
 * @returns {Promise<number>} 等到时的会话数（超时返回最后一次读到的数，可能是 0）
 */
export async function waitConversationList(pageSend, { maxMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + maxMs
  let n = 0
  while (Date.now() < deadline) {
    n = Number(await evaluateAsync(
      pageSend,
      `document.querySelectorAll('[data-e2e="conversation-item"]').length`,
      6000,
    ).catch(() => 0)) || 0
    if (n > 0) return n
    await sleep(intervalMs)
  }
  return n
}

/** 左栏会话列表的文案数组（唯一可信的服务端送达镜像）。 */
export async function conversationRows(pageSend, { waitMs = 15000 } = {}) {
  if (waitMs > 0) await waitConversationList(pageSend, { maxMs: waitMs })
  const rows = await evaluateAsync(pageSend, `(() => {
    const only = (n) => [...(n.childNodes || [])]
      .map(c => (c.nodeType === 3 ? c.textContent : (c.nodeType === 1 ? c.textContent : '')))
      .join('').replace(/\\s+/g, ' ').trim()
    return [...document.querySelectorAll('[data-e2e="conversation-item"]')]
      .map(x => ({
        text: (x.innerText || '').replace(/\\s+/g, ' ').trim(),
        parts: [...x.querySelectorAll('*')].filter(n => n.children.length === 0).map(only).filter(s => s && s.length <= 40),
      }))
      .filter(x => x.text)
  })()`, 10000).catch(() => [])
  return Array.isArray(rows) ? rows : []
}

/** 输入框此刻是否存在（页面加载后私信面板常常没渲染，必须先点开会话）。 */
export async function editorExists(pageSend) {
  return !!(await evaluateAsync(pageSend, `!!(${EDITOR_JS})`, 8000).catch(() => false))
}


/**
 * 点开某个联系人的会话。
 * 匹配顺序：完整文本包含昵称 → 首行等于昵称。都不中就用序号（第 n 个会话）。
 */
export function rowMatchesNick(row, nick) {
  const want = String(nick || '').trim()
  if (!want || !row) return false
  if (String(row.text || '').includes(want)) return true
  return Array.isArray(row.parts) && row.parts.some((s) => String(s || '').trim() === want)
}

// 找到对端所在的那一行；找不到返回 null。
export function findConversationRow(rows, nick) {
  return (rows || []).find((r) => rowMatchesNick(r, nick)) || null
}

export async function openConversation(pageSend, { nick, index = 0, waitMs = 15000 } = {}) {
  // 左栏是异步加载的，先等它出来，否则会误报 'no-list'
  if (waitMs > 0) await waitConversationList(pageSend, { maxMs: waitMs })
  const pick = JSON.stringify({ nick: String(nick || ''), index })
  const r = await evaluateAsync(pageSend, `(() => {
    const w = ${pick}
    const rows = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
    if (!rows.length) return { ok: false, code: 'no-list', why: '左栏没有会话（可能未登录或没加载出来）' }
    let el = null
    if (w.nick) {
      el = rows.find(r => (r.textContent||'').includes(w.nick))
      if (!el) el = rows.find(r => [...r.querySelectorAll('*')].some(n => n.children.length === 0 && (n.textContent||'').trim() === w.nick))
      if (!el) el = rows.find(r => {
        const first = [...r.querySelectorAll('div,span,p')].map(n => (n.textContent||'').trim()).filter(Boolean)[0] || ''
        return first === w.nick
      })
    }
    if (!el) el = rows[Math.min(w.index, rows.length - 1)]
    if (!el) return { ok: false, code: 'not-found', why: '没找到这个联系人' }

    const target = el.querySelector('div,span,img') || el
    const rect = target.getBoundingClientRect()
    const x = rect.x + Math.min(rect.width / 2, 40)
    const y = rect.y + rect.height / 2
    const hit = document.elementFromPoint(x, y) || target
    const opt = { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y }
    for (const type of ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click']) {
      try {
        const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent
        hit.dispatchEvent(new Ev(type, opt))
      } catch {}
    }
    return { ok: true, clicked: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60), hit: hit.tagName + '.' + String(hit.className||'').slice(0,50) }
  })()`, 12000)

  if (!r || !r.ok) return r || { ok: false, code: 'eval-failed' }

  // 等右栏渲染出来
  for (let i = 0; i < 20; i++) {
    const boxes = await evaluateAsync(pageSend, `document.querySelectorAll('[class*="messageMessageBox"]').length`, 6000).catch(() => 0)
    if (Number(boxes) > 0) return { ...r, ok: true, boxes: Number(boxes) }
    await sleep(250)
  }
  return { ...r, ok: false, code: 'panel-empty', why: '点了但右栏没渲染出来' }
}

/** 读当前会话的消息（自己发的 / 对方发的）。 */
export async function readMessages(pageSend) {
  return await evaluateAsync(pageSend, `(() => {
    const boxes = [...document.querySelectorAll('[class*="messageMessageBox"]')]
    const out = []
    for (const b of boxes) {
      const text = (b.textContent||'').replace(/\\s+/g,' ').trim()
      if (!text) continue
      // 判断归属：自己的消息容器通常靠右，对方靠左。用容器 x 与父容器中线比。
      const r = b.getBoundingClientRect()
      const p = b.parentElement ? b.parentElement.getBoundingClientRect() : r
      const mine = r.x + r.width / 2 > p.x + p.width / 2
      out.push({ text: text.slice(0, 500), mine, y: Math.round(r.y) })
    }
    return out
  })()`, 15000)
}

const EDITOR_JS = `document.querySelector('[data-e2e="msg-input"] [contenteditable="true"], [contenteditable="true"]')`

/** 读输入框纯文本（去掉零宽空格）。输入框不存在返回 null。 */
export async function editorText(pageSend) {
  const send = resolveSend(pageSend)
  return await evaluateAsync(send, `(() => {
    const ed = ${EDITOR_JS}
    return ed ? (ed.innerText || '').replace(/\\u200b/g, '').trim() : null
  })()`, 8000).catch(() => null)
}

/**
 * 清空输入框。
 * ⚠️ 实测：这个编辑器（Draft 系富文本，ace-line）里 execCommand('selectAll')+('delete')
 * 不生效，必须发真正的 Backspace 键事件。踩过，别改回去。
 */
export async function clearEditor(pageSend, { tries = 40 } = {}) {
  const send = resolveSend(pageSend)
  for (let i = 0; i < tries; i++) {
    const t = await evaluateAsync(send, `(() => {
      const ed = ${EDITOR_JS}
      if (!ed) return null
      ed.focus()
      return (ed.innerText || '').replace(/\\u200b/g, '').trim()
    })()`, 8000).catch(() => null)
    if (t === null) return false          // 没有输入框
    if (t === '') return true             // 已经干净
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    }, 6000)
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    }, 6000)
    await sleep(60)
  }
  return false
}

const ENTER_DOWN = { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
const ENTER_UP = { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }

/**
 * 按 y 坐标取最下面几条气泡（DOM 顺序不等于时间顺序，实测过）。
 * 返回 [{text, y, mine}] 从下往上。软件的发送校验就靠这个。
 */
export async function latestBubbles(pageSend, n = 3) {
  const send = resolveSend(pageSend)
  return await evaluateAsync(send, `(() => {
    const boxes = [...document.querySelectorAll('[class*="messageMessageBox"]')]
    const seen = new Set(); const list = []
    for (const b of boxes) {
      const t = (b.innerText || '').replace(/\\s+/g, ' ').trim()
      if (!t) continue
      const r = b.getBoundingClientRect()
      if (r.height < 8) continue
      // 自己发的消息：祖先链任一层带 isFromMe 即算。
      // 实测 class 名形如 messageMessageBoxcontentBox messageMessageBoxisFromMe
      let mine = false
      for (let n = b; n && n !== document.body; n = n.parentElement) {
        if (/isFromMe/i.test(String(n.className || ''))) { mine = true; break }
      }
      const k = Math.round(r.y) + '|' + t.slice(0, 20)
      if (seen.has(k)) continue
      seen.add(k)
      list.push({ text: t.slice(0, 120), y: Math.round(r.y), mine })
    }
    list.sort((a, b) => a.y - b.y)
    return list.slice(-${Math.max(1, Number(n) || 3)})
  })()`, 15000).catch(() => [])
}

/**
 * 向输入框内写入文本（会被 React 认可，发送按钮随之变可用）。
 *
 * ⚠️ 实测（踩过，别改回去）：
 *   1. `Input.insertText` 能让文字上屏，但**不激活**抖音的发送按钮（一直 opacity 0.3），
 *      后面无论点按钮还是回车都发不出去。
 *   2. `Input.dispatchKeyEvent` 的 `text` 参数**不能同时含中文和 emoji**：
 *      `abc` / `你好` / `🐟` 单独都行，`你好🐟` 直接报 `Invalid 'text' parameter`。
 *      所以按「ASCII / 中文 / emoji」切成若干段分别发送。
 *   3. 传 `key` 时也不要放 emoji，会报同一个错。
 */
export async function typeText(pageSend, text) {
  const send = resolveSend(pageSend)
  const body = String(text || '')
  if (!body) return { ok: true, typed: '' }
  const probe = body.slice(0, Math.min(4, body.length))

  const focus = () => evaluateAsync(send, `(() => {
    const ed = ${EDITOR_JS}
    if (ed) ed.focus()
    return true
  })()`, 8000)

  const chunk = (s) => {
    const out = []
    for (const ch of s) {
      const kind = /\p{Script=Han}/u.test(ch) || /[\u3000-\u303f\uff00-\uffef]/u.test(ch) ? 'zh'
        : /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u.test(ch) ? 'emo'
          : 'ascii'
      const last = out[out.length - 1]
      if (last && last.kind === kind) last.s += ch
      else out.push({ kind, s: ch })
    }
    return out
  }

  const segments = chunk(body)
  for (const seg of segments) {
    await focus()
    const s = String(seg.s)
    // CDP 的 text 不接受「中文+emoji」混在一段里，纯中文字符串也可能因为代理/长度被判非法
    // → 逐字符发最稳（实测 ascii / 单字中文 / 单 emoji 都能过）
    const parts = /\p{Script=Han}/u.test(s) && s.length > 1 ? [...s] : [s]
    for (const part of parts) {
      if (!part) continue
      try {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: part, unmodifiedText: part }, 8000)
        await send('Input.dispatchKeyEvent', { type: 'keyUp' }, 8000)
      } catch (e) {
        // 单个字符仍旧非法 → 退回 insertText（能上屏，按钮靠后面补空格激活）
        await send('Input.insertText', { text: part }, 8000)
      }
      await sleep(60)
    }
    await sleep(120)
  }
  await sleep(250)

  let now = await editorText(send)
  if (!now || !now.includes(probe)) {
    // 兜底：insertText 补（能上屏但可能不激活按钮，所以之后再补救）
    await focus()
    await send('Input.insertText', { text: body }, 10000)
    await sleep(300)
    now = await editorText(send)
  }

  // 仍不激活按钮时，补一个空格再退格（keyboard 事件能唤醒 React 的受控状态）
  let btn = await sendButtonReady(send)
  if (!btn.ready) {
    for (let i = 0; i < 2 && !btn.ready; i++) {
      await focus()
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', unmodifiedText: ' ' }, 6000)
      await send('Input.dispatchKeyEvent', { type: 'keyUp' }, 6000)
      await sleep(200)
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, 6000)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, 6000)
      await sleep(250)
      btn = await sendButtonReady(send)
    }
    now = await editorText(send)
  }

  return { ok: !!now && now.includes(probe), typed: now, segments: segments.length }
}

/** 发送按钮此刻能不能点（opacity ≥ 0.9 且有尺寸）。 */
export async function sendButtonReady(pageSend) {
  const send = resolveSend(pageSend)
  const r = await evaluateAsync(send, `(() => {
    const b = document.querySelector('.e2e-send-msg-btn, [data-e2e="send-msg-btn"]')
    if (!b) return { exists: false }
    const q = b.getBoundingClientRect()
    return { exists: true, op: Number(getComputedStyle(b).opacity), x: Math.round(q.x + q.width/2), y: Math.round(q.y + q.height/2), w: Math.round(q.width) }
  })()`, 8000).catch(() => ({ exists: false }))
  return { ...r, ready: !!r.exists && r.op >= 0.9 && r.w > 0 }
}

/** 点发送键（真实鼠标事件序列）。 */
export async function clickSend(pageSend) {
  const send = resolveSend(pageSend)
  const b = await sendButtonReady(send)
  if (!b.ready) return { ok: false, code: 'button-disabled', btn: b }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, buttons: 0 }, 8000)
  await sleep(180)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 }, 8000)
  await sleep(100)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 }, 8000)
  return { ok: true, at: [b.x, b.y] }
}

/**
 * 发一条私信：清残留 → 打字（keyDown 分段，按钮必须从 0.3 变 1）→ 回车 → 用左栏会话列表（服务端真相）校验。
 *
 * 实测血泪（别推翻）：
 * - 页面加载后私信面板**不会自动渲染**，必须先 openConversation 点开会话；否则输入框/按钮都不存在。
 * - Input.insertText 能上屏但不会让发送键从 opacity 0.3 变 1（不触发 React 受控状态）→ 发不出去。
 * - CDP 鼠标点发送键会被无 class 的透明层吃掉（elementFromPoint 命不中按钮）；页面内派发事件同样无效。
 * - **回车（rawKeyDown + keyUp，带 virtualKeyCode 13）是唯一稳定的发送方式。**
 * - 编辑器被清空 ≠ 发送成功（实测多次），唯一可信判据是左栏会话行里出现这条文字。
 */
export async function sendMessage(pageSend, text, { timeoutMs = 20000, nick = '' } = {}) {
  const send = resolveSend(pageSend)
  const body = String(text || '').trim()
  if (!body) return { ok: false, code: 'empty', why: '内容为空' }
  const probe = body.slice(0, Math.min(8, body.length))

  // 0) 面板没渲染时先把会话点开（这是所有失败的共同前置原因）
  if (!(await editorExists(send))) {
    const oc = await openConversation(send, { nick }).catch(e => ({ ok: false, why: e.message }))
    if (!oc.ok) return { ok: false, code: 'no-conversation', why: '打不开会话（面板没渲染）', open: oc }
    await sleep(600)
  }

  // 1) 清残留，否则会把上次没发出去的内容拼一起发出去（editorText 会去掉 \u200b）
  await clearEditor(send)
  if (await editorText(send)) return { ok: false, code: 'dirty-editor', why: '输入框清不干净' }

  // 2) 打字：按钮必须变成 ready，否则回车也发不出去
  const typed = await typeText(send, body)
  if (!typed.ok) return { ok: false, code: 'typing-failed', why: '打不进输入框', typed }
  const b = await sendButtonReady(send)
  if (!b.ready) return { ok: false, code: 'button-disabled', why: '发送键仍是禁用态（React 没收到输入）', btn: b, typed }

  // 3) 记录发送前会话列表文案（服务端真相的本地镜像）
  const before = await conversationRows(send).catch(() => [])
  const beforeTexts = new Set((before || []).map(x => x.text))

  // 4) 回车发送（唯一稳定手段）
  await send('Input.dispatchKeyEvent', ENTER_DOWN, 8000)
  await send('Input.dispatchKeyEvent', ENTER_UP, 8000)

  // 5) 校验：会话列表里出现一条含这段文字、且发送前不存在的新文案
  const deadline = Date.now() + Math.max(6000, Math.min(timeoutMs, 30000))
  let conv = []
  while (Date.now() < deadline) {
    await sleep(700)
    conv = await conversationRows(send).catch(() => [])
    const hit = (conv || []).find(x => !beforeTexts.has(x.text) && x.text.includes(probe))
    if (hit) {
      const left = await editorText(send)
      if (left) await clearEditor(send)
      return { ok: true, via: 'enter', confirmed: 'conversation-list', conv: hit.text, before, after: conv }
    }
  }
  const left = await editorText(send)
  if (left) await clearEditor(send)
  return { ok: false, code: 'not-sent', why: '发送后左栏会话列表没更新（服务端未收到）', editorLeft: left, before, after: conv }
}

// ── 未读状态 ────────────────────────────────────────────────────────────────
//
// 判断「有没有人给我发新私信」只能靠左栏会话行上的未读小红点：
//   · 抖音没有可用的私信收件接口（/aweme/v1/web/im/... 只给当前会话的历史）
//   · `[class*="messageMessageBox"]` 的条数在换会话时会复用，不能当新消息信号
// 所以工具的判据就是「会话行文本变了」+「未读角标 > 0」，两者任一即视为有新消息。

/** 读左栏每行的未读状态。返回 [{idx, text, unread, badge}] */
export async function inboxUnread(pageSend) {
  const send = resolveSend(pageSend)
  const raw = await evaluateAsync(send, `(() => {
    const rows = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
    return JSON.stringify(rows.map((el, i) => {
      // 未读红点：抖音用的是纯数字的小 span/div，类名带 badge 或 unRead 之类；直接按文本兜底
      let badge = 0
      for (const n of el.querySelectorAll('span,div,sup,i')) {
        const t = (n.textContent || '').trim()
        if (/^\\d{1,3}$/.test(t) && n.children.length === 0) {
          const r = n.getBoundingClientRect()
          if (r.width > 0 && r.width < 40 && r.height > 0 && r.height < 30) badge = Math.max(badge, Number(t))
        }
      }
      const cls = [...el.querySelectorAll('*')].some(n => /[Uu]n[Rr]ead|[Bb]adge|[Dd]ot/.test(String(n.className || '')))
      return { idx: i, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200), unread: cls || badge > 0, badge }
    }))
  })()`, 12000).catch(() => '[]')
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

/** 等一条新的对方消息。返回 {messages, newest} 或 null。 */export async function waitForIncoming(pageSend, { since = 0, maxMs = 120000, intervalMs = 3000 } = {}) {
  const started = Date.now()
  let seenCount = Number(since) || 0
  while (Date.now() - started < maxMs) {
    const msgs = await readMessages(pageSend).catch(() => null)
    if (Array.isArray(msgs) && msgs.length > seenCount) {
      const fresh = msgs.slice(seenCount).filter(m => !m.mine)
      if (fresh.length) return { messages: msgs, fresh }
      seenCount = msgs.length
    }
    await sleep(intervalMs)
  }
  return null
}
