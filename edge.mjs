/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / edge.mjs — 单一边缘管理器
// 目标：整个插件只拉起一个 Edge、一份登录态、一个 CDP 端口。
// 取代：browser-local 的 browser-host(9227) + watch 的 chrome.mjs(9334) + fish-soul 的 douyin-browse(自起)。
//
// 设计要点（都是从三套老代码里踩出来的）：
//  1. 无头 UA 必须覆写成非 HeadlessChrome，否则抖音 /aweme/ 接口返回 200 但非 JSON。
//  2. CDP 端口只在 127.0.0.1 上，且 --remote-debugging-address 显式绑 loopback。
//  3. 窗口最小化是「后台态」——9227 那套插件把「visible + hasFocus」当作「用户在用」而拒绝自动操作，
//     所以最小化是对的，千万不能自作主张拉回前台。（dyheal.mjs 当年就栽在这。）
//  4. 绝不直写 profile 里的 Cookies sqlite（DPAPI 加密 + 锁冲突会让 Edge 直接退出）。
//     换登录态一律走 CDP Network.setCookie。
//  5. 崩溃/退出要能自愈：外部 watchdog 只问「9334 活着吗」，这里负责把状态落盘。

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 路径 ────────────────────────────────────────────────────────────────────
// DSH 以 SYSTEM 计划任务跑时，DSH_HOME 未必传进子进程，所以给一个明确默认值。
// 顺序：显式设置（插件配置里的 home）> DOUYIN_ALL_HOME > DSH_HOME/douyin-all > ~/douyin-all
// 注意：这里**不猜任何具体机器的路径**。曾经有过 `if (win32 && existsSync('C:/dsh'))`
// 的兜底，结果别人机器上只要有同名目录就会把状态写错地方。
let OVERRIDE_ROOT = ''
/** 由 index.js 按插件配置里的 home 写死；传空串撤销。 */
export function setStateRoot(p) {
  OVERRIDE_ROOT = String(p || '').trim()
  return stateRoot()
}
export function stateRoot() {
  if (OVERRIDE_ROOT) return OVERRIDE_ROOT
  if (process.env.DOUYIN_ALL_HOME) return process.env.DOUYIN_ALL_HOME
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'douyin-all')
  return join(homedir(), 'douyin-all')
}

export function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }) } catch { /* ignore */ }
  return p
}

export const paths = (() => {
  const root = () => stateRoot()
  return {
    root,
    profile: () => join(root(), 'edge-profile'),
    runtime: () => join(root(), 'runtime.json'),
    edgeLog: () => join(root(), 'edge.log'),
    cookieJar: () => join(root(), 'cookie-jar.json'),
    ledger: () => join(root(), 'comment-ledger.jsonl'),
    peer: () => join(root(), 'peer.json'),
    myWorks: () => join(root(), 'my-works.json'),
    known: () => join(root(), 'known.json'),
    usage: () => join(root(), 'usage'),
  }
})()

// ── 找浏览器 ────────────────────────────────────────────────────────────────
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
]

export function findBrowser(custom = '') {
  if (custom && existsSync(custom)) return custom
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p
  throw new Error('找不到 Microsoft Edge，也没配自定义路径')
}

// ── CDP 最小客户端（零依赖，只用内置 WebSocket）──────────────────────────────
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) {
          const e = new Error(`${method || 'CDP'} → ${msg.error.message || JSON.stringify(msg.error)}`)
          e.code = msg.error.code
          e.cdpMethod = method
          reject(e)
        }
        else resolve(msg.result)
        return
      }
      if (msg.method) {
        const hs = this.handlers.get(msg.method)
        if (hs) for (const h of hs) { try { h(msg.params) } catch { /* ignore */ } }
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败')) }, { once: true })
    })
    return new Cdp(ws)
  }

  /**
   * 发一条 CDP 命令。
   * flatten 模式下，页面级命令的 sessionId 必须放在**消息顶层**（不是 params 里），
   * 否则根会话会报 "'Page.enable' wasn't found" —— 这是最容易踩的一脚。
   */
  send(method, params = {}, timeoutMs = 30000, sessionId = null) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs) : null
      this.pending.set(id, {
        method,
        resolve: (v) => { if (t) clearTimeout(t); resolve(v) },
        reject: (e) => { if (t) clearTimeout(t); reject(e) },
      })
      const msg = { id, method, params }
      if (sessionId) msg.sessionId = sessionId
      try { this.ws.send(JSON.stringify(msg)) } catch (e) {
        if (t) clearTimeout(t)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method).add(fn)
    return () => this.handlers.get(method)?.delete(fn)
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

// ── HTTP：找 CDP target ─────────────────────────────────────────────────────
export async function cdpAlive(port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch { return false }
}

export async function listPages(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`/json/list ${r.status}`)
  return (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
}

/** 在已有页面里挑一个 douyin 的；没有就开一个。 */
export async function getDouyinPage(cdp, port, url = 'https://www.douyin.com/') {
  let pages = await listPages(port)
  let page = pages.find((p) => /douyin\.com/.test(p.url))
  if (!page) {
    const { targetId } = await cdp.send('Target.createTarget', { url })
    await sleep(800)
    pages = await listPages(port)
    page = pages.find((p) => p.id === targetId) || pages.find((p) => /douyin\.com/.test(p.url))
  }
  if (!page) throw new Error('没能打开抖音页面')
  return page
}

/**
 * 打开一个页面级 CDP 会话，并**先把 UA 覆写掉**。
 * 这一步是所有 /aweme/ 接口能不能拿到 JSON 的生死线。
 */
export async function openPageSession(cdp, page, { navigate = null } = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
  const s = {
    sessionId,
    // sessionId 放进消息顶层（见 Cdp.send 注释）
    send: (method, params = {}, timeoutMs) => cdp.send(method, params, timeoutMs, sessionId),
  }

  await s.send('Page.enable')
  await s.send('Network.enable')
  await normalizeUserAgent(s, cdp)

  if (navigate) {
    // navigate 可以是 true（沿用当前页 URL 重新加载）或一个具体 URL 字符串。
    // 传 true 时不能直接丢给 Page.navigate —— 它的 url 参数类型是 string，
    // 传布尔会得到一句毫无线索的 "Invalid parameters"。
    let url = typeof navigate === 'string' ? navigate : ''
    if (!url) {
      const cur = await s.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      url = cur?.result?.value || 'https://www.douyin.com/'
    }
    if (/^https?:/i.test(url)) {
      await s.send('Page.navigate', { url })
      await waitReady(s, 20000)
    }
  }
  return s
}

/** 把 HeadlessChrome 换成 Chrome —— 不做这一步，抖音接口一律返回非 JSON。 */
export async function normalizeUserAgent(pageSend, cdp) {
  let ua = ''
  try {
    const r = await pageSend.send('Runtime.evaluate', {
      expression: 'navigator.userAgent', returnByValue: true,
    })
    ua = String(r?.result?.value || '')
  } catch { /* ignore */ }
  if (!ua) ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'
  const fixed = ua.replace(/HeadlessChrome\/[\d.]+/g, 'Chrome/156.0.0.0').replace(/\s*Headless\b/g, '')
  try {
    await pageSend.send('Emulation.setUserAgentOverride', {
      userAgent: fixed,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Win32',
    })
  } catch { /* 老版本 Edge 没有这个域就用 Network 那条 */ }
  return fixed
}

export async function waitReady(pageSend, maxMs = 20000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await sleep(300)
    try {
      const r = await pageSend.send('Runtime.evaluate', {
        expression: `JSON.stringify({href:String(location.href||''),rs:document.readyState,len:document.body?document.body.innerText.length:0})`,
        returnByValue: true,
      }, 6000)
      const v = JSON.parse(r?.result?.value || '{}')
      // 不能只看 readyState —— 导航前的 about:blank 也是 complete（见 openFreshPage 注释）
      if (/^https:\/\/([a-z0-9-]+\.)?douyin\.com\//i.test(v.href || '') &&
        (v.rs === 'interactive' || v.rs === 'complete') && Number(v.len || 0) > 0) return true
    } catch { /* 还在导航 */ }
  }
  return false
}

/** 在页面里执行一段异步脚本并等它完成；超时会 reject（别让一个挂死的 fetch 拖死整轮）。 */
export async function evaluateAsync(pageSend, expression, timeoutMs = 25000) {
  // 两种调用形态都支持：
  //   evaluateAsync(session, ...)         —— openPageSession 返回的会话对象
  //   evaluateAsync(session.send, ...)    —— 直接给底层的 send 函数
  const send = typeof pageSend === 'function'
    ? pageSend
    : (pageSend && typeof pageSend.send === 'function' ? pageSend.send.bind(pageSend) : null)
  if (!send) throw new Error('evaluateAsync 需要一个 CDP 会话对象或 send 函数')
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (r?.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本异常')
  }
  return r?.result?.value
}

/** 判断页面是不是被风控/验证码拦了。实测「弹窗挂着」并不挡接口，所以只当信号，不当否决。 */
export async function pageSignals(pageSend) {
  try {
    return await evaluateAsync(pageSend, `(() => {
      const ifr = [...document.querySelectorAll('iframe')]
        .filter(f => /verifycenter|captcha|rmc\./i.test(f.src || ''))
        .map(f => ({ src: (f.src||'').slice(0,120), r: f.getBoundingClientRect(), display: getComputedStyle(f).display }))
      const real = ifr.filter(f => f.r.width > 40 && f.r.height > 40 && f.display !== 'none')
      return {
        href: location.href,
        vis: document.visibilityState,
        focus: document.hasFocus(),
        verify: real.length > 0,
        verifyCount: real.length,
      }
    })()`, 8000)
  } catch (e) {
    return { href: '', vis: '', focus: false, verify: false, err: String(e.message || e) }
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────
function buildArgs({ port, profile, headless, url }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--lang=zh-CN',
    // 反自动化检测：这四条是 9227 那套跑通过的
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--autoplay-policy=no-user-gesture-required',
    // 无头/服务器环境稳定性：这四条是 9334 秒退排查时补上的
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-breakpad',
    `--crash-dumps-dir=${join(profile, 'crash')}`,
  ]
  if (headless) args.push('--headless=new')
  // 服务器上以 SYSTEM 跑，没有桌面也会失败；--no-sandbox 在容器/服务账户里必需
  if (process.platform === 'win32') args.push('--no-sandbox')
  args.push(url || 'https://www.douyin.com/')
  return args
}

export function readRuntime() {
  try { return JSON.parse(readFileSync(paths.runtime(), 'utf8')) } catch { return null }
}

export function writeRuntime(obj) {
  try {
    ensureDir(dirname(paths.runtime()))
    writeFileSync(paths.runtime(), JSON.stringify({ ...obj, at: new Date().toISOString() }, null, 2))
  } catch { /* ignore */ }
}

/**
 * 确保有一个活着的 Edge。已经在跑就直接复用，不重复拉起。
 * @returns {{port:number, pid:number|null, reused:boolean, mode:string}}
 */
export async function ensureEdge({ port = 9334, headless = true, url = 'https://www.douyin.com/', browserPath = '' } = {}) {
  const root = ensureDir(paths.root())
  const profile = ensureDir(paths.profile())

  // 1) 端口上已经有活的 CDP → 直接复用
  if (await cdpAlive(port)) {
    const rt = readRuntime() || {}
    const out = { port, pid: rt.pid ?? null, reused: true, mode: rt.headless === false ? 'headed' : 'headless' }
    writeRuntime({ ...out, reused: true })
    return out
  }

  // 2) 之前记录的端口活着（端口可能被换过）
  const rt = readRuntime()
  if (rt && rt.port && rt.port !== port && await cdpAlive(rt.port)) {
    return { port: rt.port, pid: rt.pid ?? null, reused: true, mode: rt.headless === false ? 'headed' : 'headless' }
  }

  // 3) 拉起新实例
  const exe = findBrowser(browserPath)
  const args = buildArgs({ port, profile, headless, url })
  const logFd = openSync(paths.edgeLog(), 'a')
  const child = spawn(exe, args, { detached: true, stdio: ['ignore', 'ignore', logFd] })
  child.unref()

  // 4) 探活：60 × 500ms
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    if (await cdpAlive(port)) {
      const out = { port, pid: child.pid ?? null, reused: false, mode: headless ? 'headless' : 'headed' }
      writeRuntime({ ...out, exe, args })
      return out
    }
    // 进程已经退出就别傻等满 30 秒
    if (child.exitCode !== null && child.exitCode !== undefined) {
      break
    }
  }
  throw new Error(`Edge 起来了但 ${port} 上连不上 CDP（30 秒超时）。看日志 ${paths.edgeLog()}`)
}

/**
 * 打开一个**全新的**抖音页面会话（新 tab），并覆写 UA。
 *
 * 为什么需要它：同一个页面在几十轮实验里被反复 reload 之后会进入「半死」状态 ——
 * DOM 正常、`document.readyState` 也是 complete，但页面内 fetch 一律挂死；
 * 而**新开的 tab 连跑 9 个接口全部正常**（myWorks 570ms / commentList 518ms / listComments 510ms …）。
 * 所以自愈手段就是「扔掉旧页、换一个新页」，比 reload 可靠得多。
 *
 * ⚠️ 2026-11-03 实测的硬约束：**入口 url 必须是 `https://www.douyin.com/chat`**。
 * 用首页 `https://www.douyin.com/` 进，页面的签名头（uifid / x-secsdk-csrf-token）不会被生成，
 * 之后所有 `/aweme/v1/web/*` 请求一律 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`，
 * 而且连等 6 次 warmup 也救不回来（不是时序问题，是入口页面不对）。
 *
 * ⚠️ 2026-11-04 实测：**不能拿 `document.readyState === 'complete'` 当就绪判据**，
 * 它有两个假阳性（两条实测时间线一致）：
 *   0–370ms `about:blank` 就已经是 complete 了（导航还没开始）；
 *   2.3s 时 `/chat` 也是 complete，但 body 只有 14 个字、`[data-e2e="conversation-item"]` 还是 0；
 *   真正的会话项要到 **5.2–6.5s** 才出现。
 * 所以判据改成「URL 落在 douyin.com + readyState 不是 loading + 页面里渲染出了真实节点」。
 */
export async function openFreshPage(cdp, port, url = 'https://www.douyin.com/chat', { readyMs = 25000, waitSelector = '' } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url }, 20000)
  const deadline = Date.now() + readyMs
  // 默认判据：抖音页面 + 骨架渲染完（body 有内容），会话/视频列表另行轮询
  const sel = waitSelector || ''
  const PROBE = `JSON.stringify({
    href: String(location.href || ''),
    rs: document.readyState,
    len: document.body ? document.body.innerText.length : 0,
    hit: ${sel ? `document.querySelectorAll(${JSON.stringify(sel)}).length` : '0'},
  })`
  while (Date.now() < deadline) {
    await sleep(300)
    let page
    try { page = (await listPages(port)).find((p) => p.id === targetId) } catch { continue }
    if (!page) continue
    let s
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, 8000)
      s = { sessionId, targetId, send: (m, p = {}, t) => cdp.send(m, p, t, sessionId) }
      await normalizeUserAgent(s, cdp)
      const r = await s.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, 6000)
      const v = JSON.parse(r?.result?.value || '{}')
      const onSite = /^https:\/\/([a-z0-9-]+\.)?douyin\.com\//i.test(v.href || '')
      const loaded = v.rs === 'interactive' || v.rs === 'complete'
      const painted = Number(v.len || 0) > 0
      const hitOk = sel ? Number(v.hit || 0) > 0 : true
      if (onSite && loaded && painted && hitOk) {
        await s.send('Page.enable').catch(() => { })
        await s.send('Network.enable').catch(() => { })
        return { s, page, targetId, state: v }
      }
    } catch { /* 页面还在加载，重试 */ }
  }
  // ⚠️ 失败也要把建出来的 target 收掉，否则每失败一次就在 profile 里多漏一个页面。
  // （2026-11-04 实测过这个泄漏：反复 openFreshPage 之后 getTargets 里堆了一串 about:blank）
  await closePage(cdp, targetId).catch(() => { })
  throw new Error('新页面没能就绪（' + url + '）')
}

/**
 * 9334 的「空壳」体检。
 *
 * 2026-11-04 实测的真实现象：CDP 端口在监听、`/json/version` 也正常，但
 * `Target.getTargets` 里**一个 page 都没有**（只剩 1 个 service_worker），
 * 于是 watch 的 `pickPort` 认为「浏览器没起来」，每 10 分钟报一次
 * 「读评论失败（试了 3 次）：没有可用的 page target（Chrome 起来了吗？）」。
 * 而这时候 `Target.createTarget` 照样能造页、造出来的页打接口 100% 正常
 * （实测 /aweme/v1/web/aweme/post/ 返回 42963 字节真 JSON，status_code:0）。
 *
 * 所以「活着」的判据不能只是端口监听，必须是「CDP 能连 + 至少有一个 page」。
 * @returns {Promise<{ok:boolean, why?:string, pages?:number, targets?:number}>}
 */
export async function healthCheck(port, { timeoutMs = 8000 } = {}) {
  if (!(await cdpAlive(port))) return { ok: false, why: 'cdp-dead' }
  let cdp
  try {
    cdp = await connect(port)
    const { targetInfos } = await cdp.send('Target.getTargets', {}, timeoutMs)
    const pages = targetInfos.filter((t) => t.type === 'page')
    if (!pages.length) return { ok: false, why: 'no-page-target', pages: 0, targets: targetInfos.length }
    return { ok: true, pages: pages.length, targets: targetInfos.length }
  } catch (e) {
    return { ok: false, why: 'cdp-error:' + String(e?.message || e).slice(0, 80) }
  } finally {
    try { cdp?.close() } catch { }
  }
}

/**
 * 确保 profile 里有一个常驻的 `/chat` 页 —— 「空壳」时用它补一个回去。
 * @returns {Promise<{ok:boolean, created?:boolean, targetId?:string, why?:string}>}
 */
export async function ensureLivePage(port, url = 'https://www.douyin.com/chat', opts = {}) {
  const h = await healthCheck(port)
  if (h.ok) return { ok: true, created: false }
  if (h.why !== 'no-page-target') return { ok: false, why: h.why }
  let cdp
  try {
    cdp = await connect(port)
    const { targetId } = await cdp.send('Target.createTarget', { url }, 20000)
    return { ok: true, created: true, targetId }
  } catch (e) {
    return { ok: false, why: 'create-failed:' + String(e?.message || e).slice(0, 80) }
  } finally {
    try { cdp?.close() } catch { }
  }
}

/** 关掉一个自己开的页面，别在 profile 里越积越多。 */export async function closePage(cdp, targetId) {
  try { await cdp.send('Target.closeTarget', { targetId }, 8000) } catch { /* ignore */ }
}

/**
 * 回收泄漏的 target。
 *
 * 2026-11-04 实测：`Target.createTarget` 造页 → `Target.closeTarget` 关页之后，
 * `Target.getTargets` 的总数并不下降（20 多轮后稳定在 10–12）。自己开的页由
 * `onPage()` 的 finally 负责关，这里只兜底「别人留下的空白页」：
 *   · 只动 `type === 'page'` 且 URL 是 about:blank / 抖音且**不是**当前常驻页的；
 *   · 至少留 1 个 page（不留会让 CDP 变成「空壳」，反而触发 pickPort 误判）；
 *   · 最多关 `max` 个，避免某次异常把在用的页也带走。
 * @returns {Promise<{ok:boolean, closed?:number, pages?:number, kept?:string}>}
 */
export async function pruneTargets(port, { max = 3, keep = '' } = {}) {
  let cdp
  try {
    cdp = await connect(port)
    const { targetInfos } = await cdp.send('Target.getTargets', {}, 10000)
    const pages = targetInfos.filter((t) => t.type === 'page')
    if (pages.length <= 1) return { ok: true, closed: 0, pages: pages.length }
    const spare = pages.filter((t) => {
      if (keep && (t.targetId === keep || String(t.url || '').includes(keep))) return false
      const u = String(t.url || '')
      return !u || u === 'about:blank' || u.startsWith('https://www.douyin.com/')
    })
    // 至少给 profile 留一个页
    const room = Math.max(0, pages.length - 1)
    const victims = spare.slice(0, Math.min(max, room))
    let closed = 0
    for (const v of victims) {
      try { await cdp.send('Target.closeTarget', { targetId: v.targetId }, 8000); closed++ } catch { /* ignore */ }
    }
    return { ok: true, closed, pages: pages.length }
  } catch (e) {
    return { ok: false, why: String(e?.message || e).slice(0, 80) }
  } finally {
    try { cdp?.close() } catch { }
  }
}

/** 连上 CDP 根会话。 */
export async function connect(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`/json/version ${r.status}`)
  const j = await r.json()
  if (!j.webSocketDebuggerUrl) throw new Error('CDP 没给 webSocketDebuggerUrl')
  return Cdp.connect(j.webSocketDebuggerUrl)
}

/**
 * 收掉端口上的那个 Edge。
 *
 * 为什么要它：开通向导需要在同一个 profile 上把无头实例换成有头实例
 * （用户得在那个窗口里扫码），同一个 user-data-dir 不允许两个实例同时活着。
 * 优先走 CDP 的 Browser.close（正常退出、会把 cookie 刷盘）；
 * 连不上就直接按 runtime.json 记的 pid 杀，最后按「命令行里带这个端口的」兜底。
 */
export async function stopEdge(port = 9334, { timeoutMs = 8000 } = {}) {
  const id = Number(port)
  let closed = false
  try {
    const cdp = await connect(id)
    try { await cdp.send('Browser.close', {}, 3000) } catch { /* 有的版本不支持 */ }
    try { cdp.close() } catch { /* ignore */ }
    closed = true
  } catch { /* 端口上本来就没东西 */ }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await cdpAlive(id))) return { ok: true, closed, why: closed ? 'cdp' : 'already-down' }
    await sleep(250)
  }

  // 还活着：按 pid 杀
  const rt = readRuntime() || {}
  const pids = new Set()
  if (Number(rt.port) === id && rt.pid) pids.add(Number(rt.pid))
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${id}' } | ForEach-Object { $_.ProcessId }`,
      ], { encoding: 'utf8', timeout: 15000 })
      for (const line of String(out).split(/\r?\n/)) {
        const n = Number(line.trim())
        if (n) pids.add(n)
      }
    } catch { /* ignore */ }
  }
  for (const pid of pids) {
    try { process.kill(pid) } catch {
      try { execFileSync('C:\\Windows\\System32\\taskkill.exe', ['/F', '/PID', String(pid), '/T'], { timeout: 10000 }) } catch { /* ignore */ }
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!(await cdpAlive(id))) return { ok: true, closed: true, why: 'killed', pids: [...pids] }
    await sleep(250)
  }
  return { ok: false, closed, why: `端口 ${id} 上的 Edge 关不掉`, pids: [...pids] }
}

/**
 * 一步到位：确保 Edge 活着 → 连 CDP → **开一个全新页面** → 覆写 UA → 交给 fn。
 *
 * 注意这里默认 `fresh: true`。老版本复用已有 tab，结果是第二次跑就挂死 ——
 * 抖音页面被反复加载后页面内 fetch 会整体静默挂起，唯一可靠的解法是换新页。
 */
export async function withDouyinPage(fn, opts = {}) {
  const { port = 9334, headless = true, navigate = null, fresh = true, url = 'https://www.douyin.com/chat' } = opts
  const edge = await ensureEdge({ port, headless, url: 'https://www.douyin.com/' })
  const cdp = await connect(edge.port)
  let targetId = null
  try {
    let s, page
    if (fresh) {
      const r = await openFreshPage(cdp, edge.port, navigate || url)
      s = r.s; page = r.page; targetId = r.targetId
      if (navigate) {
        await s.send('Page.navigate', { url: navigate }, 20000)
        await waitReady(s, 20000)
      }
    } else {
      page = await getDouyinPage(cdp, edge.port, navigate || url)
      s = await openPageSession(cdp, page, { navigate })
    }
    return await fn(s, { cdp, edge, page, targetId })
  } finally {
    if (targetId) await closePage(cdp, targetId)
    cdp.close()   // 根会话用完即关，浏览器进程还活着，下次重连即可
  }
}
