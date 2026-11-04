/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / api.mjs — 抖音 Web 接口的统一封装
//
// 为什么要有这一层：三套老代码各写了一遍 fetch + 参数拼装 + 错误码判断，
// 结果同一件事有三种失败表现。这里收成一处，行为才一致。
//
// 全是「在已登录页面的上下文里发同源 fetch」，不签名、不走外网代理
// （所有 /aweme/v1/web/* 带 cookie 就能打，不需要 a_bogus）。
//
// 已踩过的坑，都在注释里标了：

import { evaluateAsync, sleep } from './edge.mjs'


// 公共参数：抖音 Web 端所有接口都认这套
export function commonQs(extra = {}) {
  return {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '190500',
    version_name: '19.5.0',
    cookie_enabled: 'true',
    screen_width: '1440',
    screen_height: '900',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Edge',
    browser_version: '156.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '156.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    cpu_core_num: '8',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '50',
    ...extra,
  }
}

/**
 * 在页面上下文里打一条 GET 接口，返回解析后的 JSON。
 * 约定：抖音的成败看 status_code（0 = 成功），不是 HTTP 码。
 *
 * 血泪：页面内的 fetch 会被抖音的防护脚本接管，**风控时无限挂起且 AbortController 掐不断**。
 * 一旦 await 它，整条 CDP 连接连同后续所有 Runtime.evaluate 一起卡死。
 * 所以这里改成两步式：先 fire（不 await）把 Promise 结果写进 window.__dya[tag]，
 * 再用「非 awaitPromise」的短 evaluate 轮询问状态。这样卡住的是页面，不是我们。
 * 停在 pending 超过 timeoutMs 即判定接口挂起，交给调用方决定是否 reload 自愈。
 */
const TAG_SEQ = { n: 0 }

function makeTag(prefix) {
  TAG_SEQ.n += 1
  return `${prefix}_${Date.now().toString(36)}_${TAG_SEQ.n}`
}

/** 两步式执行一个页面内异步表达式：fire 到 window.__dya[tag]，再轮询读回。 */
export async function fireAndPoll(pageSend, expression, { tag, timeoutMs = 20000, pollMs = 250 } = {}) {
  const key = tag || makeTag('q')
  await evaluateAsync(pageSend, `(() => {
    window.__dya = window.__dya || {}
    if (window.__dya[${JSON.stringify(key)}]) return 'exists'
    window.__dya[${JSON.stringify(key)}] = { s: 'pending', t0: Date.now() }
    const done = (v) => { window.__dya[${JSON.stringify(key)}] = v }
    try {
      Promise.resolve(${expression}).then(
        (v) => done({ s: 'ok', v, ms: Date.now() - window.__dya[${JSON.stringify(key)}].t0 }),
        (e) => done({ s: 'err', v: String(e && e.message || e), ms: Date.now() - window.__dya[${JSON.stringify(key)}].t0 })
      )
    } catch (e) { done({ s: 'err', v: String(e && e.message || e), ms: 0 }) }
    return 'fired'
  })()`, 8000)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    let st
    try {
      st = await evaluateAsync(pageSend, `(() => { const x = window.__dya && window.__dya[${JSON.stringify(key)}]; return x ? JSON.stringify({ s: x.s, ms: x.ms }) : 'null' })()`, 6000)
    } catch (e) {
      // 连读状态都超时 —— 页面整体卡死，直接返回让上层 reload
      return { __hung: true, __tag: key, why: '页面读不回来：' + e.message }
    }
    let meta
    try { meta = JSON.parse(st) } catch { meta = null }
    if (!meta) continue
    if (meta.s === 'pending') continue
    const val = await evaluateAsync(pageSend, `(() => { const x = window.__dya[${JSON.stringify(key)}]; return JSON.stringify(x) })()`, 8000)
    try { return JSON.parse(val) } catch { return { s: 'err', v: 'bad-result' } }
  }
  return { __timeout: true, __tag: key }
}

/**
 * 页面内 GET（默认路线）。返回 `{__timeout:true}` 表示接口挂起，调用方应 reload 后重试一次。
 */
export async function apiGet(pageSend, path, params = {}, { timeoutMs = 20000, retries = 1 } = {}) {
  const qs = new URLSearchParams(Object.entries(commonQs(params)).map(([k, v]) => [k, String(v)]))
  const url = `${path}?${qs.toString()}`
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fireAndPoll(pageSend, `(async () => {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      return { http: res.status, bytes: text.length, json, head: json ? '' : text.slice(0, 120) }
    })()`, { timeoutMs, tag: makeTag('get') })

    if (r.__timeout || r.__hung) {
      lastErr = Object.assign(new Error('接口挂起：' + path), { hung: !!r.__hung, timeout: true })
      continue
    }
    const payload = r.v
    if (r.s === 'err' || !payload) { lastErr = new Error('页面 fetch 失败：' + (r.v || 'unknown')); continue }
    if (!payload.json) {
      lastErr = new Error(`接口返回非 JSON（HTTP ${payload.http}，${payload.bytes} 字节）：${payload.head}`)
      continue
    }
    return { ...payload.json, __http: payload.http, __bytes: payload.bytes, __path: path }
  }
  throw lastErr || new Error('apiGet 失败')
}

/** POST 表单接口（发评论、删评论都是这个形态）。 */
export async function apiPost(pageSend, path, body = {}, { timeoutMs = 20000 } = {}) {
  const qs = new URLSearchParams(Object.entries(commonQs({})).map(([k, v]) => [k, String(v)]))
  const url = `${path}?${qs.toString()}`
  const payload = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v ?? '')])).toString()
  // 与 apiGet 同理：写操作也必须两步式，否则一次挂起就把整条连接拖死
  const r = await fireAndPoll(pageSend, `(async () => {
    const res = await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.douyin.com/' },
      body: ${JSON.stringify(payload)},
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { http: res.status, bytes: text.length, json, head: json ? '' : text.slice(0, 200) }
  })()`, { timeoutMs, tag: makeTag('post') })
  if (r.__timeout || r.__hung) {
    throw Object.assign(new Error('POST 挂起：' + path), { hung: !!r.__hung, timeout: true })
  }
  const v = r.v
  if (r.s === 'err' || !v) throw new Error('页面 POST 失败：' + (r.v || 'unknown'))
  if (!v.json) throw new Error(`POST 非 JSON（HTTP ${v.http}）：${v.head}`)
  return { ...v.json, __http: v.http, __bytes: v.bytes, __path: path }
}

// ── 具体端点 ────────────────────────────────────────────────────────────────

/**
 * 推荐流。count 别太大，抖音会降质量。
 *
 * ⚠️ 这是个「被风控专盯」的端点：同一页面里 comment/list 531ms、aweme/post 1193ms 都好好的，
 *    唯独 tab/feed 直接挂死（12–20 秒不返回）。Node 侧直连反而通（200/16 万字节）。
 *    所以：超时给短、绝不重试，挂起就返回 `{__timeout:true}` 让调用方跳过刷流，别拖垮整轮。
 */
export async function feed(p, count = 6, { timeoutMs = 8000 } = {}) {
  try {
    return await apiGet(p, '/aweme/v1/web/tab/feed/', { count }, { timeoutMs, retries: 0 })
  } catch (e) {
    return { __timeout: true, __error: String(e?.message || e), aweme_list: [] }
  }
}

/**
 * 我的作品列表。
 * 技巧：sec_user_id 直接传 'self' 就能列自己 —— 不用先查 uid。
 * （/aweme/v1/web/user/profile/other/?sec_user_id=self 会报 UserId不合法，别用那条。）
 */
export const myWorks = (p, { maxCursor = 0, count = 20 } = {}) =>
  apiGet(p, '/aweme/v1/web/aweme/post/', { sec_user_id: 'self', max_cursor: maxCursor, count })

/**
 * 某个作品的顶层评论。
 * ⚠️ 零评论作品返回 comments:null（不是空数组），这不是错误 —— 判 status_code 才准。
 */
export const commentList = (p, awemeId, { cursor = 0, count = 20 } = {}) =>
  apiGet(p, '/aweme/v1/web/comment/list/', { aweme_id: awemeId, cursor, count, item_type: '0' })

/**
 * 子回复列表。
 * ⚠️ 这条接口在本号登录态下会「无限挂起」（22 秒都不返回），必须给硬超时，
 *    超时就当没这回事继续走 —— 老代码就是在这里把整轮扫描拖死的。
 */
export async function commentReplies(p, { itemId, commentId, cursor = 0, count = 20 }, { timeoutMs = 8000 } = {}) {
  try {
    return await apiGet(p, '/aweme/v1/web/comment/list/reply/', {
      item_id: itemId, comment_id: commentId, cursor, count, item_type: '0',
    }, { timeoutMs, retries: 0 })
  } catch (e) {
    return { __timeout: true, __error: String(e?.message || e), comments: [] }
  }
}

/** 发评论 / 回评论。replyId 有值就是回某条（楼中楼）。 */
export const publishComment = (p, { awemeId, text, replyId = '' }) =>
  apiPost(p, '/aweme/v1/web/comment/publish/', {
    aweme_id: awemeId,
    text,
    text_extra: '[]',
    aweme_type: '0',
    channel_id: '0',
    city: '',
    sticker_id: '',
    is_fold: '0',
    reply_id: replyId,
    reply_to_reply_id: '',
  })

export const deleteComment = (p, { awemeId, cid }) =>
  apiPost(p, '/aweme/v1/web/comment/delete/', { aweme_id: awemeId, cid, channel_id: '0', city: '' })

/** 互动通知。注意：本号实测 /aweme/v1/web/notice/ 返回 status_code:5，不一定可用，调用方要容错。 */
export const notice = (p, { count = 20, cursor = 0 } = {}) =>
  apiGet(p, '/aweme/v1/web/notice/', { count, cursor, is_new_notice: '1' })

/** 当前登录账号。cookie 里 type=im 的页面能拿到；失败就返回 null 而不是抛。 */
export async function whoAmI(p) {
  try {
    const r = await apiGet(p, '/aweme/v1/web/im/user/info/', {}, { timeoutMs: 10000 })
    return r
  } catch { return null }
}

// ── 结果归一 ────────────────────────────────────────────────────────────────

/** status_code 不是 0 就抛，带上服务端原话。 */
export function assertOk(r, what) {
  const sc = Number(r?.status_code ?? 0)
  if (sc !== 0) {
    throw new Error(`${what} 失败 status_code=${sc}${r?.status_msg ? '：' + r.status_msg : ''}`)
  }
  return r
}

/**
 * 拿到一个「接口可用」的页面。
 *
 * 为什么工具层需要它：`withDouyinPage` 开出来的新页虽然 URL 对、DOM 也画好了，
 * 但签名头（uifid / x-secsdk-csrf-token）是在页面自身脚本里生成的，得等它跑完；
 * 太早打 `/aweme/v1/web/*` 会拿到 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`。
 * 这里用最便宜的一个真实接口（作品列表 count=1）当探针，通了才交给业务代码。
 *
 * @returns {Promise<{ok:boolean, tries:number, head?:string}>}
 */
export async function warmup(p, { tries = 8, gapMs = 700 } = {}) {
  let head = ''
  for (let i = 0; i < tries; i++) {
    try {
      const r = await apiGet(p, '/aweme/v1/web/aweme/post/', { sec_user_id: 'self', max_cursor: 0, count: 1 }, { timeoutMs: 12000, retries: 0 })
      if (r && !r.__err && (r.status_code == null || Number(r.status_code) === 0)) {
        return { ok: true, tries: i + 1 }
      }
      head = String(r?.__head || r?.__err || ('status_code=' + r?.status_code)).slice(0, 120)
    } catch (e) {
      head = String(e?.message || e).slice(0, 120)
    }
    await sleep(gapMs)
  }
  return { ok: false, tries, head }
}

/** 从作品对象里抽我们要的字段。 */
export function pickWork(w) {
  return {
    aweme_id: String(w.aweme_id || ''),
    desc: String(w.desc || ''),
    create_time: Number(w.create_time || 0),
    statistics: {
      comment: Number(w.statistics?.comment_count || 0),
      digg: Number(w.statistics?.digg_count || 0),
      play: Number(w.statistics?.play_count || 0),
      share: Number(w.statistics?.share_count || 0),
    },
  }
}

/** 从评论对象里抽我们要的字段。 */
export function pickComment(c) {
  return {
    cid: String(c.cid || ''),
    text: String(c.text || ''),
    nick: String(c.user?.nickname || ''),
    uid: String(c.user?.uid || ''),
    sec_uid: String(c.user?.sec_uid || ''),
    time: Number(c.create_time || 0),
    reply_total: Number(c.reply_comment_total || 0),
    digg: Number(c.digg_count || 0),
    // 作者标识——只回别人、不回自己
    is_author: Number(c.user?.is_author || 0) === 1,
  }
}

/** 作品链接（回评时要带上下文）。 */
export const workUrl = (awemeId) => `https://www.douyin.com/video/${awemeId}`
