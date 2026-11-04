/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
/**
 * share.mjs —— 把视频/图文发给主人
 * ============================================================================
 * 设计原则（照抄 dsh-douyin-watch 的实战结论，别改）：
 *
 *  ① **没有「发卡片给我」的干净接口**。分享卡片（aweType 800 / MessageItemShareAweme）
 *     是前端把结构化消息交给服务端生成的，纯文本 + URL 做不出卡片；而文本链接在抖音里点不开。
 *
 *  ② 卡片链路 = 视频页 → **真实 hover** 分享图标 → 面板展开 → 点「<昵称>」那一行的「分享」。
 *     分享图标没有 onClick，是 onMouseEnter/onFocus 的 hover 弹窗，
 *     `el.click()` 打不开，`Input.dispatchMouseEvent` 也不可靠 ——
 *     必须**在页面里对元素派发** pointerover/pointerenter/mouseover/mouseenter/mousemove
 *     （elementFromPoint 拿不到时退回图标本体，不依赖坐标落在视口内）。
 *
 *  ③ **送达永远无法验证**：卡片和私信同走 IM 通道，被风控时会静默丢弃
 *     （本地看着像成功、对方收不到）。所以本模块一律返回 `deliveryUnverified: true`，
 *     **绝不谎报「已送达」**。要确认必须让主人自己在手机上看一眼。
 *
 *  ③' **2026-11-03 实测：本号的分享卡片确实被吞了。**
 *      执行 `shareCard({awemeId:'7702337516510340745', peer:'爱睡觉的kevin'})` 返回
 *      `ok:true executed:true at:[693,415]`（点中的就是那个 68×32 的真按钮，
 *      `rowText:"爱睡觉的kevin\n分享"`），但 20 秒后回查：
 *        - 左栏会话行仍是「爱睡觉的kevin **32分钟前** 整合版第二条 abc def」（时间没刷新）
 *        - 点开会话，右栏 51 条气泡里最后几条还是「在的，怎么了？ / 在吗」
 *        - `[class*="shareCard"] / [class*="awemeCard"] / img[class*="cover"]` 命中数 **0**
 *      → 结论：**点击动作是真的成功了，卡片被服务端静默丢弃**。
 *      所以 `shareCard()` 默认只当「试一试」，**真正转发请用 `shareLink()`**（走普通私信，
 *      送达判据是左栏会话行的时间变成「刚刚」且末条变成这条链接）。
 *
 *  ④ 因此这里提供两条路径，调用方（模型）自己选：
 *     - `shareCard()`  好看但可能被吞（返回 deliveryUnverified）
 *     - `shareLink()`  丑但能确认（走 sendMessage，送达判据 = 左栏会话列表）
 *
 *  ⑤ 5 秒内不重复发同一个视频（防模型一轮里连发）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stateRoot, evaluateAsync, sleep } from './edge.mjs'
import { workUrl } from './api.mjs'
import { sendMessage } from './chat.mjs'
import { videoDetail } from './feed.mjs'

// ── 状态：最近分享过的视频（防连发） ────────────────────────────────────────
const lastFile = () => `${stateRoot()}/share-last.json`

function readLast() {
  try {
    return JSON.parse(readFileSync(lastFile(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeLast(obj) {
  try {
    mkdirSync(dirname(lastFile()), { recursive: true })
    writeFileSync(lastFile(), JSON.stringify(obj), 'utf8')
  } catch { /* 记不下来不影响主流程 */ }
}

const DUP_WINDOW_MS = 5 * 60 * 1000 // 同一个视频 5 分钟内不重复发

function tooSoon(awemeId, now = Date.now()) {
  const m = readLast()
  const at = Number(m[awemeId] || 0)
  if (!at) return 0
  const left = DUP_WINDOW_MS - (now - at)
  return left > 0 ? left : 0
}

// ── 页面脚本：hover 分享图标，把面板结构读出来 ──────────────────────────────
const HOVER_SHARE = `(function(){
  var ic = document.querySelector('[data-e2e="video-share-icon-container"]');
  if (!ic) return JSON.stringify({ ok:false, why:'no-icon' });
  var r = ic.getBoundingClientRect();
  var x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  var tgt = document.elementFromPoint(x, y) || ic;
  var opt = { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y };
  ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(t){
    try {
      var E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
      tgt.dispatchEvent(new E(t, opt));
      ic.dispatchEvent(new E(t, opt));
    } catch(e){}
  });
  return JSON.stringify({ ok:true, x:x, y:y, inView: r.top >= 0 && r.bottom <= innerHeight });
})()`

// ── 页面脚本：面板里找「昵称那一行」并点它的「分享」 ────────────────────────
const CLICK_PEER = (nick) => `(function(){
  var NICK = ${JSON.stringify(nick)};

  // 面板真实结构（2026-11-03 实测）：
  //   DIV "爱睡觉的kevin 分享"          ← 行容器 300x58
  //     IMG 头像
  //     DIV.UdhPuYKz "爱睡觉的kevin"     ← 昵称（精确等于昵称）
  //     DIV.xu0OjnsQ.wv0hD3qc.uiL5gOiW "分享"  ← 真正能点的 68x32 按钮
  // 注意：整页还有 SPAN.sB3y0d3B "分享"（底部工具栏那个），点了没用，别选它。
  var boxes = Array.prototype.slice.call(document.querySelectorAll('div,span,button'));
  var nickEl = null;
  for (var i = 0; i < boxes.length; i++) {
    var el = boxes[i];
    if ((el.innerText || '').trim() !== NICK) continue;
    var r0 = el.getBoundingClientRect();
    if (r0.width <= 0 || r0.width > 250) continue;      // 昵称文本不会很宽
    if (el.children.length > 0) continue;                // 要叶子节点
    nickEl = el; break;
  }
  if (!nickEl) return JSON.stringify({ ok:false, why:'no-peer-nick', nick:NICK });

  // 从昵称往上找最多 4 层，在其中找「分享」且尺寸像按钮的（宽>50）
  var btn = null, row = nickEl;
  for (var up = 0; up < 4 && !btn; up++) {
    if (!row.parentElement) break;
    row = row.parentElement;
    var kids = row.querySelectorAll('div,span,button');
    for (var j = 0; j < kids.length; j++) {
      var k = kids[j];
      if ((k.innerText || '').trim() !== '分享') continue;
      var kr = k.getBoundingClientRect();
      if (kr.width > 50 && kr.height > 20) { btn = k; break; }
    }
  }
  if (!btn) return JSON.stringify({ ok:false, why:'no-share-btn', nick:NICK });

  var hit = { row: row, btn: btn };
  var b = hit.btn, br = b.getBoundingClientRect();
  var x = Math.round(br.x + br.width/2), y = Math.round(br.y + br.height/2);
  var opt = { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y, button:0 };
  ['pointerover','pointerenter','mouseover','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
    try {
      var E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
      b.dispatchEvent(new E(t, opt));
    } catch(e){}
  });
  return JSON.stringify({ ok:true, at:[x,y], rowText: hit.row ? (hit.row.innerText||'').slice(0,40) : '' });
})()`

// ── 主函数：发卡片（好看，但送达不可验证） ──────────────────────────────────
/**
 * @param {object} pageSend  CDP 页面会话（withDouyinPage 给的那个）
 * @param {object} o
 * @param {string} o.awemeId
 * @param {string} o.peer        好友昵称，空则不点（只展开面板，便于排查）
 * @param {boolean} o.dry        只展开面板，不点分享
 * @returns {Promise<{ok:boolean, deliveryUnverified?:boolean, executed?:boolean,
 *                    dry?:boolean, why?:string, detail?:string, at?:number[],
 *                    rowText?:string, hover?:object, click?:object}>}
 */
export async function shareCard(pageSend, o = {}) {
  const awemeId = String(o.awemeId || '').trim()
  const peer = String(o.peer || '').trim()
  const dry = !!o.dry
  if (!awemeId) return { ok: false, why: 'empty' }

  const left = tooSoon(awemeId)
  if (left > 0 && !dry) {
    return { ok: false, why: 'too-soon', detail: `这个视频 ${Math.ceil(left / 1000)} 秒前刚发过，先别再发了` }
  }

  // 1) 站到视频页（只有视频页才有分享图标）
  const cur = await evaluateAsync(pageSend, 'location.href').catch(() => '')
  if (!String(cur).includes(`/video/${awemeId}`)) {
    const r = await evaluateAsync(pageSend, `(function(){ location.href = ${JSON.stringify(workUrl(awemeId))}; return 1 })()`).catch(() => null)
    if (r === null) return { ok: false, why: 'nav-failed' }
    // 等页面把分享图标渲染出来（最多 12 秒）
    let ready = false
    for (let i = 0; i < 24; i++) {
      await sleep(500)
      const has = await evaluateAsync(pageSend, `!!document.querySelector('[data-e2e="video-share-icon-container"]')`).catch(() => false)
      if (has) { ready = true; break }
    }
    if (!ready) return { ok: false, why: 'no-share-icon', detail: '视频页没渲染出分享图标（可能被验证码拦住）' }
    await sleep(600)
  }

  // 2) hover 分享图标 → 面板展开
  const hover = JSON.parse(await evaluateAsync(pageSend, HOVER_SHARE))
  if (!hover.ok) return { ok: false, why: hover.why, hover }
  await sleep(900)

  if (dry || !peer) {
    return { ok: true, dry: true, hover, detail: dry ? '已展开分享面板（dry）' : '已展开分享面板（没给昵称，未点分享）' }
  }

  // 3) 点「昵称那一行」的「分享」
  const click = JSON.parse(await evaluateAsync(pageSend, CLICK_PEER(peer)))
  if (!click.ok) return { ok: false, why: click.why, hover, click, detail: `分享面板里没找到「${peer}」` }

  // 4) 记账（防连发）+ 如实标注送达未验证
  const m = readLast()
  m[awemeId] = Date.now()
  writeLast(m)

  return {
    ok: true,
    executed: true,
    deliveryUnverified: true,
    at: click.at,
    rowText: click.rowText,
    hover,
    click,
    detail: '已执行分享动作。⚠️ 抖音的分享卡片走 IM 通道，被风控时会静默丢弃 —— 送没送到必须让主人自己在手机上看一眼。',
  }
}

// ── 主函数：发链接（丑，但能确认送达） ──────────────────────────────────────
/**
 * 用普通私信把视频链接发过去。送达判据 = 左栏会话列表出现这条消息（chat.sendMessage 已实现）。
 * @returns {Promise<{ok:boolean, via:'link', deliveryUnverified:false, conv?:string, detail?:string, why?:string}>}
 */
export async function shareLink(pageSend, o = {}) {
  const awemeId = String(o.awemeId || '').trim()
  const peer = String(o.peer || '').trim()
  if (!awemeId) return { ok: false, why: 'empty' }

  let text = String(o.text || '').trim()
  if (!text) {
    // 没给文案就自己写一句：拿一句视频描述当引子
    let desc = ''
    try {
      const d = await videoDetail(pageSend, awemeId, { timeoutMs: 12000 })
      if (d && d.ok && d.work) desc = String(d.work.desc || '').slice(0, 30)
    } catch { /* 读不到就发裸链接 */ }
    text = desc ? `${desc}\n${workUrl(awemeId)}` : workUrl(awemeId)
  }

  const r = await sendMessage(pageSend, text, { timeoutMs: 20000, nick: peer })
  if (!r.ok) return { ok: false, via: 'link', deliveryUnverified: false, why: r.code || 'not-sent', detail: r.detail }

  return {
    ok: true,
    via: 'link',
    deliveryUnverified: false,
    conv: r.conv,
    detail: `已作为普通私信发出去，送达已确认（会话列表显示：${r.conv}）`,
  }
}

// ── 给模型看的一句话摘要 ────────────────────────────────────────────────────
export function describeShare(r) {
  if (!r) return '分享没有结果'
  if (!r.ok) return `分享失败（${r.why}）${r.detail ? '：' + r.detail : ''}`
  if (r.via === 'link') return r.detail || '已发链接（送达已确认）'
  return r.detail || '已执行分享（送达未验证）'
}

/**
 * 默认转发入口：**先试卡片，但以链接为准**。
 * 实测卡片会被吞，所以这里直接走 shareLink（能确认送达），
 * 想赌一把卡片就显式传 `{ card: true }`。
 */
export async function share(pageSend, o = {}) {
  if (o.card) return shareCard(pageSend, o)
  return shareLink(pageSend, o)
}

// ── 面板探查（排查用，不点任何东西） ────────────────────────────────────────
export async function peekSharePanel(pageSend, awemeId) {
  const cur = await evaluateAsync(pageSend, 'location.href').catch(() => '')
  if (!String(cur).includes(`/video/${awemeId}`)) {
    await evaluateAsync(pageSend, `(function(){ location.href = ${JSON.stringify(workUrl(awemeId))}; return 1 })()`).catch(() => null)
    for (let i = 0; i < 24; i++) {
      await sleep(500)
      const has = await evaluateAsync(pageSend, `!!document.querySelector('[data-e2e="video-share-icon-container"]')`).catch(() => false)
      if (has) break
    }
  }
  const hover = JSON.parse(await evaluateAsync(pageSend, HOVER_SHARE))
  if (!hover.ok) return { ok: false, why: hover.why }
  await sleep(900)
  const panel = JSON.parse(
    await evaluateAsync(
      pageSend,
      `(function(){
        var out = [];
        var all = Array.prototype.slice.call(document.querySelectorAll('div,span,button'));
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var t = (el.innerText || '').trim();
          if (!t || t.length > 30) continue;
          if (t.indexOf('分享') !== 0) continue;              // 只看「分享…」开头的按钮
          var r = el.getBoundingClientRect();
          if (r.width <= 0) continue;
          out.push({ text: t, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) });
          if (out.length >= 12) break;
        }
        return JSON.stringify({ ok: true, buttons: out });
      })()`
    )
  )
  return { ok: true, hover, panel }
}

export default { share, shareCard, shareLink, describeShare, peekSharePanel }
