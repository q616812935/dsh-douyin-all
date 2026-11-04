/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
/**
 * comments.mjs —— 评论读取 / 回复 / 删除
 *
 * 设计取舍（与老插件不同的地方，都踩过坑）：
 * - **不再为了刷接口而导航页面**：老 work-comments.mjs 会 Page.navigate('https://www.douyin.com/')
 *   再串行打多个作品，触发风控滑块后整轮 verify_required 放弃。这里只在当前页（默认 /chat 或任意
 *   douyin 页）里发 fetch —— 它在验证码弹窗挂着时依然返回 200 真 JSON。
 * - **零评论不是错误**：抖音对无评论作品返回 `comments: null`（不是空数组），老代码当失败处理。
 * - 子回复 `/aweme/v1/web/comment/list/reply/` 在部分账号下会**无限挂起**，一律 8 秒硬超时并降级。
 * - 判重、字数、禁止词、站外引导、时/日额度全部交给 guard.mjs，本文件只管「取数」和「发」。
 */
import * as api from './api.mjs'
import { sleep } from './edge.mjs'

/** 抖音对零评论作品返回 comments:null —— 归一成空数组。 */
export function normalizeComments(r) {
  if (!r || (r.status_code != null && Number(r.status_code) !== 0)) return null
  const list = Array.isArray(r.comments) ? r.comments : []
  return {
    list,
    hasMore: !!r.has_more || Number(r.cursor || 0) === 1,
    cursor: Number(r.cursor || 0),
    total: Number(r.total || 0),
  }
}

/**
 * 读一个作品的顶层评论（可翻页）。
 * @returns {Promise<{ok,awemeId,total,items,error?}>}
 */
export async function listComments(p, awemeId, { max = 20, cursor = 0, count = 20 } = {}) {
  const items = []
  let cur = cursor
  let total = 0
  let guardPage = 0
  while (items.length < max && guardPage < 10) {
    guardPage++
    const r = await api.commentList(p, awemeId, { cursor: cur, count })
    const norm = normalizeComments(r)
    if (!norm) {
      return { ok: false, awemeId, error: r && (r.__head || r.__err || ('status_code=' + r.status_code)) }
    }
    total = norm.total || total
    for (const c of norm.list) {
      const one = api.pickComment(c)
      if (one) items.push(one)
    }
    if (!norm.hasMore || !norm.list.length) break
    cur = norm.cursor
    await sleep(220)
  }
  return { ok: true, awemeId, total, items: items.slice(0, max) }
}

/**
 * 读某个评论下的子回复。超时不抛异常，返回 `{ok:false, timeout:true}`。
 * 已知问题：部分账号下这个接口无限挂起，所以超时是常态而非故障。
 */
export async function listReplies(p, { awemeId, commentId, cursor = 0, count = 20, timeoutMs = 8000 } = {}) {
  const r = await api.commentReplies(p, { itemId: awemeId, commentId, cursor, count }, { timeoutMs })
  if (r && r.__timeout) return { ok: false, timeout: true, items: [] }
  const norm = normalizeComments(r)
  if (!norm) return { ok: false, error: (r && (r.__head || r.__err)) || 'bad-response', items: [] }
  return { ok: true, items: norm.list.map(api.pickComment).filter(Boolean), hasMore: norm.hasMore, cursor: norm.cursor }
}

/**
 * 判断「这条评论我是不是已经回过了」—— 靠服务端字段，不靠本地台账。
 * 服务端读不到时（子回复超时）返回 `null`，调用方必须当成「未知」，交给 guard 的台账兜底。
 */
export async function answeredByMe(p, { awemeId, commentId, timeoutMs = 8000 } = {}) {
  const r = await listReplies(p, { awemeId, commentId, timeoutMs })
  if (!r.ok) return null
  return r.items.some(x => x.is_author)
}

/**
 * 拉一批「值得回」的评论（自己作品 + 指定作品），不做筛选判断，只做取数与去重标记。
 * @param {object} p 页面 send
 * @param {string[]} awemeIds
 * @param {object} o {perWork=10, scanDm=false, skipMine=true}
 */
export async function scanWorks(p, awemeIds = [], { perWork = 10 } = {}) {
  const out = []
  const errors = []
  for (const awemeId of awemeIds.slice(0, 5)) {
    const r = await listComments(p, awemeId, { max: perWork })
    if (!r.ok) { errors.push({ awemeId, error: r.error }); continue }
    for (const c of r.items) {
      // 自己发的评论不回
      if (c.is_author) continue
      out.push({ ...c, awemeId })
    }
    await sleep(200)
  }
  return { ok: true, items: out, errors }
}

/**
 * 发一条评论或楼中楼回复。
 * 楼中楼走 publishComment 的 reply_id（服务端参数），**不是 UI 上点 @**。
 * @param {object} p
 * @param {object} o {awemeId, text, replyId}
 */
export async function postComment(p, { awemeId, text, replyId = '' } = {}) {
  const body = String(text || '').trim()
  if (!awemeId || !body) return { ok: false, code: 'bad-args' }
  const r = await api.publishComment(p, { awemeId, text: body, replyId })
  if (!r || (r.status_code != null && Number(r.status_code) !== 0)) {
    return { ok: false, code: 'api-fail', status_code: r && r.status_code, raw: (r && (r.__head || r.__err)) || '' }
  }
  const c = r.comment || (Array.isArray(r.comments) ? r.comments[0] : null)
  const cid = c && (c.cid || c.comment_id)
  if (!cid) return { ok: false, code: 'no-cid', raw: r }
  return {
    ok: true,
    cid: String(cid),
    text: (c.text || body),
    label: c.label_text || '',
    replyId: c.reply_id || replyId || '',
  }
}

/** 删一条自己发的评论。 */
export async function removeComment(p, { awemeId, cid } = {}) {
  if (!awemeId || !cid) return { ok: false, code: 'bad-args' }
  const r = await api.deleteComment(p, { awemeId, cid })
  const ok = !!r && (Number(r.status_code || 0) === 0 || r.msg === 'success')
  return { ok, raw: r }
}

/**
 * 从通知里捞「别人评论我/回复我」的候选（type 31 = 评论，35/46 = 作品相关）。
 * 通知接口本身会返回 status_code 5（部分账号不可用），这里一律容错。
 */
export async function noticeComments(p, { count = 20 } = {}) {
  const r = await api.notice(p, { count })
  if (!r || Number(r.status_code || 0) !== 0) {
    return { ok: false, code: 'notice-unavailable', status_code: r && r.status_code, items: [] }
  }
  const items = []
  for (const n of (r.notice_list || [])) {
    const t = Number(n.type || 0)
    if (t !== 31) continue
    const c = n.comment || {}
    const a = n.aweme || {}
    const cid = c.cid || c.comment_id
    if (!cid || !a.aweme_id) continue
    items.push({
      awemeId: String(a.aweme_id),
      cid: String(cid),
      nick: (c.user && (c.user.nickname || c.user.nick_name)) || n.from_user_name || '',
      text: String(c.text || '').slice(0, 300),
      time: Number(n.create_time || 0),
      replyTo: String(c.reply_comment_id || ''),
    })
  }
  return { ok: true, items: items.slice(0, count) }
}

/** 只挑「值得回」的：非自己的、非机器人的、有内容的、不太旧。 */
export function pickReplies(items = [], { selfNick = '', skipNicks = [], maxAgeHours = 48, now = Date.now(), limit = 3 } = {}) {
  const skip = new Set([...(skipNicks || []), '豆包', '抖音求真'].filter(Boolean))
  const self = String(selfNick || '').trim()
  const picked = []
  const skipped = []
  const seen = new Set()
  for (const raw of items) {
    // 兼容两种来源：api.pickComment 的 {cid,...} 和 notice 的 {cid,...}；
    // 也容忍上游塞进来的是原始抖音对象（字段叫 comment_id）。
    const it = raw ? {
      ...raw,
      cid: String(raw.cid || raw.comment_id || ''),
      text: raw.text != null ? raw.text : String(raw.comment_text || ''),
      nick: raw.nick || (raw.user && (raw.user.nickname || raw.user.nick_name)) || '',
    } : null
    const why = (() => {
      if (!it || !it.cid) return '没有 cid'
      if (seen.has(it.cid)) return '同一批里重复'
      if (!String(it.text || '').trim()) return '正文为空'
      // ⚠️ 不能靠昵称判「自己」：账号在抖音上显示的是昵称（蓝毛小女仆），设置页里写的是
      // 角色名（大肥鱼），两者永远不相等。只有服务端给的 is_author 可信。
      if (it.is_author) return '是我自己'
      if (skip.has(String(it.nick || '').trim())) return '在名单里'
      // api.pickComment 给的是秒级 create_time；noticeComments 也是秒级
      if (it.time && now - Number(it.time) * 1000 > maxAgeHours * 3600e3) return '太旧了'
      return ''
    })()
    if (why) { skipped.push({ cid: it && it.cid, nick: it && it.nick, why }); continue }
    seen.add(it.cid)
    picked.push(it)
    if (picked.length >= limit) break
  }
  return { picked, skipped }
}
