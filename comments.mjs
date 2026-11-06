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
export async function listComments(p, awemeId, { max = 20, cursor = 0, count = 20, byMe = false } = {}) {
  const items = []
  let cur = cursor
  let total = 0
  let guardPage = 0
  while (items.length < max && guardPage < 10) {
    guardPage++
    const r = await api.commentList(p, awemeId, { cursor: cur, count })
    const norm = normalizeComments(r)
    if (!norm) {
      // 刚发布完的几秒里，服务端会先回 HTTP 200 + 空 body（不是真挂），当成空列表继续
      if (items.length === 0) return { ok: false, awemeId, error: r && (r.__head || r.__err || ('status_code=' + r.status_code)) }
      break
    }
    total = norm.total || total
    for (const c of norm.list) {
      const one = api.pickComment(c)
      if (one && byMe && !isMineComment(one, selfNick)) continue
      if (one) items.push(one)
    }
    if (!norm.hasMore || !norm.list.length) break
    cur = norm.cursor
    await sleep(220)
  }
  return { ok: true, awemeId, total, items: items.slice(0, max) }
}

/**
 * 「这条评论是不是我自己发的」的可靠判据。
 *
 * **不要用服务端给的 is_author**：线上实测，我在别人的视频下发的那条评论
 * （cid 7704959119916761856）在 comment/list 里回来时 is_author 不是 1、uid 还经常缺，
 * 于是「只回别人的评论」会把自己的评论当成别人的再回一遍。
 * 唯一稳定的是 user.nickname —— 本号昵称由调用方（config.owner）传进来。
 *
 * @param {object} c pickComment 出来的评论
 * @param {string} selfNick 本号昵称
 */
export function isMineComment(c, selfNick = '') {
  const want = String(selfNick || '').trim()
  if (!want) return !!(c && c.is_author)   // 没给昵称就只能退回服务端字段
  const nick = String((c && (c.nick || c.author?.nick || c.user?.nickname)) || '').trim()
  if (nick) return nick === want
  return !!(c && c.is_author)
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
export async function answeredByMe(p, { awemeId, commentId, timeoutMs = 8000, selfNick = '' } = {}) {
  const r = await listReplies(p, { awemeId, commentId, timeoutMs })
  if (!r.ok) return null
  return r.items.some(x => isMineComment(x, selfNick))
}

/**
 * 拉一批「值得回」的评论（自己作品 + 指定作品），不做筛选判断，只做取数与去重标记。
 * @param {object} p 页面 send
 * @param {string[]} awemeIds
 * @param {object} o {perWork=10, scanDm=false, skipMine=true}
 */
export async function scanWorks(p, awemeIds = [], { perWork = 10, selfNick = '' } = {}) {
  const out = []
  const errors = []
  for (const awemeId of awemeIds.slice(0, 5)) {
    const r = await listComments(p, awemeId, { max: perWork })
    if (!r.ok) { errors.push({ awemeId, error: r.error }); continue }
    for (const c of r.items) {
      // 自己发的评论不回（按昵称判，is_author 实测不可信）
      if (isMineComment(c, selfNick)) continue
      out.push({ ...c, awemeId })
    }
    await sleep(200)
  }
  return { ok: true, items: out, errors }
}

/**
 * 把「正文里的 @昵称」翻译成服务端认的提及。
 *
 * 实测：正文写 `@某人` 只是文本，服务端不会认为你提及了谁；必须同时给 text_extra 里的
 * user_id（见 api.cleanTextExtra 的注释）。这里只处理正文开头（或第一个 @）的那一个，
 * 多个 @ 的情况故意不支持 —— 我们每次只会叫人一个。
 *
 * @param {string} text 要发的正文
 * @param {{nick:string, uid:string}|null} who 被 @ 的人
 * @returns {{text:string, extra:Array, at:{nick,start,end}|null}}
 */
export function buildAt(text, who) {
  const body = String(text || '')
  // who 可以是 {nick, uid}，也可以直接给昵称 —— 调用方常常只有昵称没有 uid，
  // 这时退化成「纯文本 @」，服务端会自己识别成提及（实测：没带 text_extra 也能被标成 @）。
  const nick = String(who?.nick || (typeof who === 'string' ? who : '') || '').trim()
  if (!nick) return { text: body, extra: [], at: null }
  // 昵称里可能有正则元字符（.、φ、emoji 之外还有全角），一律用 indexOf 定位
  const start = body.indexOf('@' + nick)
  if (start < 0) return { text: body, extra: [], at: null }
  const end = start + 1 + nick.length
  if (!who?.uid) return { text: body, extra: [], at: { nick, start, end, textOnly: true } }
  return {
    text: body,
    extra: [{ start, end, user_id: String(who.uid), type: 0 }],
    at: { nick, start, end },
  }
}

/**
 * 发一条评论或楼中楼回复。
 * 楼中楼走 publishComment 的 reply_id（服务端参数），**不是 UI 上点 @**。
 * @param {object} p
 * @param {object} o {awemeId, text, replyId, at:{nick,uid}}
 */
export async function postComment(p, { awemeId, text, replyId = '', at = null } = {}) {
  const body = String(text || '').trim()
  if (!awemeId || !body) return { ok: false, code: 'bad-args' }
  const built = buildAt(body, at)
  const r = await api.publishComment(p, { awemeId, text: body, replyId, textExtra: built.extra })
  const code = r && (r.status_code != null ? Number(r.status_code) : 0)
  if (!r || code !== 0) {
    // 2053 = 抖音认为「你还没在这个作品的评论区里待过」。实测同一页先读一次 listComments
    // （total>0 就算进过场）再发就 0 了；total=0 的视频则会一直 2053，那就别硬发。
    if (code === 2053) return { ok: false, code: 'need-watch-comments', status_code: code }
    return { ok: false, code: 'api-fail', status_code: r && r.status_code, raw: (r && (r.__head || r.__err)) || '' }
  }
  const c = r.comment || (Array.isArray(r.comments) ? r.comments[0] : null)
  const cid = c && (c.cid || c.comment_id)
  if (!cid) return { ok: false, code: 'no-cid', raw: r }
  // 发布回执里的 text_extra 常常是空数组 —— 那不代表没 @ 上，只代表回执省了字段。
  // 真正作数的是「作品评论区里能读回这条评论」。读回要等几秒（新评论不是立刻可见），
  // 所以这里做两轮轻量回读，只在这条作品下确认自己那条的存在。
  let verified = null
  for (let i = 0; i < 2 && !verified; i++) {
    await sleep(i === 0 ? 2500 : 5000)
    try {
      const rd = await listComments(p, awemeId, { max: 20, count: 20, byMe: true })
      if (!rd.ok) continue
      const mine = (rd.items || []).find((x) => String(x.cid) === String(cid))
      if (mine) verified = mine
    } catch (e) { /* 回读失败不影响「已发出」这个事实 */ }
  }
  const back = Array.isArray(c.text_extra) && c.text_extra.length ? c.text_extra : (verified && Array.isArray(verified.text_extra) ? verified.text_extra : [])
  return {
    ok: true,
    cid: String(cid),
    text: (c.text || body),
    label: c.label_text || '',
    replyId: c.reply_id || replyId || '',
    // 服务端回执里带回来的提及（这就是「真的 @ 上了」的证据，而不是我们猜的）
    mentionedUid: String((back.find((e) => e && e.user_id) || {}).user_id || ''),
    atRequested: !!built.at,
    // 评论区回读确认（null = 还没读回来，不代表没发出去）
    verified: !!verified,
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
  // 机器号名单：抖音官方小助手之类的号回了也没意义。用户自己的 skipNicks 追加在后面。
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
      // 判「自己」按昵称（selfNick = config.owner）。服务端 is_author 实测不可信：
      // 自己在别人视频下的评论回来时 is_author 不是 1，会被当成别人再回一遍。
      if (isMineComment(it, selfNick)) return '是我自己'
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
