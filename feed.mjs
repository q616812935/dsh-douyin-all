/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / feed.mjs — 刷推荐流、挑视频、看视频详情
//
// 目标：空闲时真的在刷抖音（拿推荐流、看视频详情、热评），挑一条想跟人说的。
// 取代：browser-local 的 autonomous-watch / video-storyboard / video-forward + fish-soul 的 browse/douyin-browse
//
// 踩过的坑（别回退）：
//  1. /aweme/v1/web/tab/feed/ 被风控专盯：同一页面里 comment/list 500ms 通、feed 能挂 12–20 秒。
//     所以 feed 必须短超时 + 绝不重试，挂了就当「今天没刷到新东西」，不能拖垮整轮。
//  2. 老页面（同一个 target 被反复 reload）会进入「半死」状态：DOM 正常、fetch 全挂。
//     解法是开新 tab（edge.openFreshPage），不是 reload。
//  3. Node 侧直连 feed 是通的（200/真 JSON），但 /aweme/v1/web/* 的写操作必须走页面内同源 fetch
//     （页面才会带 uifid + x-secsdk-csrf-token 签名头）。feed 读也统一走页面，保持一致。

import { feed as apiFeed, apiGet, pickWork, commentList, pickComment } from './api.mjs'

// ── 视频详情：比 feed 里的摘要更全（时长、作者、音乐、封面）──
export async function videoDetail(p, awemeId, { timeoutMs = 15000 } = {}) {
  try {
    const r = await apiGet(p, '/aweme/v1/web/aweme/detail/', { aweme_id: awemeId }, { timeoutMs, retries: 0 })
    const w = r?.aweme_detail
    if (!w) return { ok: false, why: '详情为空', status_code: r?.status_code }
    return {
      ok: true,
      work: pickWork(w),
      author: {
        nick: String(w.author?.nickname || ''),
        sec_uid: String(w.author?.sec_uid || ''),
        uid: String(w.author?.uid || ''),
      },
      duration: Number(w.video?.duration || w.duration || 0),   // 毫秒
      music: String(w.music?.title || ''),
      cover: String(w.video?.cover?.url_list?.[0] || w.video?.origin_cover?.url_list?.[0] || ''),
      isMine: String(w.author?.uid || '') === String(p.__uid || ''),
    }
  } catch (e) {
    return { ok: false, why: String(e?.message || e) }
  }
}

/**
 * 刷一轮推荐流。
 * feed 挂了也返回 ok:false 而不是抛 —— 上层据此决定「这轮跳过」。
 */
export async function browse(p, { count = 6, timeoutMs = 8000, selfNick = '', selfUid = '' } = {}) {
  const t0 = Date.now()
  const r = await apiFeed(p, count, { timeoutMs })
  if (r?.__timeout) {
    return { ok: false, code: 'feed-timeout', why: '推荐流被风控挂起（这是常态，不要重试）', tookMs: Date.now() - t0, items: [] }
  }
  const list = Array.isArray(r?.aweme_list) ? r.aweme_list : []
  const items = list.map((w) => ({
    ...pickWork(w),
    author: {
      nick: String(w.author?.nickname || ''),
      sec_uid: String(w.author?.sec_uid || ''),
      uid: String(w.author?.uid || ''),
    },
    duration: Number(w.video?.duration || 0),
    // 推荐流里也会夹着自己的作品（尤其自己刚发/刚评过的）。
    // 老实现写死 isMine:false，于是「挑一条来跟人说」可能挑到自己发的视频。
    // 判据：uid 相同（最准），拿不到 uid 就退到昵称。
    isMine: (selfUid && String(w.author?.uid || '') === String(selfUid))
      || (!!selfNick && String(w.author?.nickname || '').trim() === String(selfNick).trim()),
  }))
  return {
    ok: items.length > 0,
    tookMs: Date.now() - t0,
    status_code: Number(r?.status_code ?? 0),
    hasMore: !!r?.has_more,
    items,
  }
}

// ── 挑一条想说给人听的 ──────────────────────────────────────────────────────
// 目的：不是「挑最火的」，而是「挑她看着好玩、值得跟账号持有人提一句的」。
// 规则先粗筛，再由上层（模型）或这里给个分数决定。
const BORING = [/^(#?)[\d\s]*$/, /^(转发|分享)/, /@[\u4e00-\u9fa5a-zA-Z0-9_]+/]

export function score(item, { dislike = [], like = [], tasteTags = [], tasteScore = null, freshHours = 0, now = Date.now() } = {}) {
  const desc = String(item.desc || '')
  let s = 0
  if (desc.length >= 8) s += 2
  if (desc.length > 60) s += 1
  if (/\?|？/.test(desc)) s += 1             // 有提问，容易接话
  if (/(猫|狗|吃|笑|可爱|好看|海|鱼|唱歌|跳舞)/.test(desc)) s += 2
  for (const w of like) if (desc.includes(w)) s += 3
  for (const w of dislike) if (desc.includes(w)) s -= 5
  // 她自己的口味：文案里对上的标签先给一点分，真正的权值交给上层传进来的 tasteScore。
  // 关键词表是写死的，而「她这两个月迷上手工」这件事只有 soul 里的画像知道。
  const hit = tasteTags.filter((tg) => tg && desc.includes(tg))
  for (let i = 0; i < hit.length; i++) s += 2
  if (typeof tasteScore === 'function' && hit.length) {
    try { s += Number(tasteScore(hit)) || 0 } catch { /* 打分器挂了不影响主流程 */ }
  }
  if (item.statistics?.digg > 10000) s += 1
  if (item.isMine) s -= 10                   // 自己的作品不用「挑来跟人说」
  for (const re of BORING) if (re.test(desc)) s -= 4
  // 新鲜度：推荐流里能刷到几个月前的老视频（实测刷到过 4 月发的），
  // 对老视频说「刚刷到」很出戏，也会让「评论别人视频」变成考古。给了 freshHours 就压旧内容。
  // 时间戳缺失（0）算「不知道」，不惩罚也不奖励。
  if (freshHours > 0 && item.create_time) {
    const ageH = (now - Number(item.create_time) * 1000) / 3600e3
    if (ageH > freshHours * 4) s -= 8
    else if (ageH > freshHours) s -= 3
  }
  return s
}

/**
 * 排序 + 截断。
 * @param {object} opts
 * @param {number} [opts.recallHours] 见过的视频在这么多小时内重新出现视为「又刷到了」，
 *        必须明显强于新候选才保留 —— 否则推荐流抽签一抖，同一批 6 条视频就会反复重复分享。
 */
export function pick(items, opts = {}) {
  const { limit = 3, recalled = [], recallHours = 72, now = Date.now() } = opts
  const seen = new Map()
  for (const r of recalled) if (r && r.awemeId) seen.set(String(r.awemeId), Number(r.at || 0))
  const scored = items.map((it) => {
    let s = score(it, { ...opts, now })
    const at = seen.get(String(it.aweme_id || ''))
    if (at && now - at < recallHours * 3600e3) {
      s -= RECALL_PENALTY
      return { ...it, score: s, recalled: true }
    }
    return { ...it, score: s, recalled: false }
  })
  const fresh = scored.filter((it) => !it.recalled && it.score > 0)
  const again = scored.filter((it) => it.recalled && it.score > 0)
  const out = fresh.sort((a, b) => b.score - a.score).slice(0, limit)
  // 新东西不够时才轮到「又刷到的」，而且要分数真的高
  if (out.length < limit) {
    for (const it of again.sort((a, b) => b.score - a.score)) {
      if (out.length >= limit) break
      if (it.score > RECALL_PENALTY / 2) out.push(it)
    }
  }
  return out
}

/** 见过的视频降多少分（要能压过「猜你喜欢」的大约 +2~+20）。 */
const RECALL_PENALTY = 12

/**
 * 挑几条 + 拉第一条的热评，凑成「她看懂了这条视频」的材料。
 *
 * 一次 browse 只回 2~6 条（实测多的时候 count=10 也只给 2 条），而且里面常夹着
 * 文案很短、全是话题标签、或者有 @ 的老视频 —— 这些按 score 都掉到 0 分以下。
 * 所以「刷一次 → 一条候选都没有」曾经是常态，表现出来就是「一整天什么都不发」。
 * 现在：score>0 一条都没有时，再补刷 `extraBrowses` 轮；仍然没有就退而取「分数最高的那几条」，
 * 让上层（模型）自己判断要不要表态，而不是在打分这一层就把整轮否掉。
 */
export async function pickWithContext(p, opts = {}) {
  const {
    count = 6, limit = 1, topComments = 3, dislike = [], like = [], tasteTags = [],
    tasteScore = null, freshHours = 0, recalled = [], recallHours = 72,
    extraBrowses = 2, minScore = -3, selfNick = '', selfUid = '',
  } = opts
  const t0 = Date.now()
  const all = []
  let scanned = 0
  let tries = 0
  const seenIds = new Set()
  let cands = []
  for (let i = 0; i <= extraBrowses; i++) {
    tries += 1
    const br = await browse(p, { count , selfNick, selfUid })
    if (!br.ok && !all.length) return { ok: false, ...br, picked: null, comments: [] }
    scanned += br.items.length
    for (const it of br.items) {
      const id = String(it.aweme_id || '')
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      all.push(it)
    }
    cands = pick(all, { dislike, like, tasteTags, tasteScore, freshHours, recalled, recallHours, limit: Math.max(limit, 3) })
    if (cands.length >= Math.max(1, Math.min(limit, 3))) break
    if (!br.ok) break
  }
  // 兜底：没有正分的就取分数最高的一批（过掉明显无聊/自己的），交给模型判断
  if (!cands.length) {
    const scored = all
      .map((it) => ({ ...it, score: score(it, { dislike, like, tasteTags, tasteScore, freshHours }) }))
      .filter((it) => !it.isMine && it.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit, 3))
    cands = scored
  }
  if (!cands.length) {
    return { ok: false, code: 'nothing-interesting', why: '这轮没有想说的', items: all.length, scanned, tries, picked: null, comments: [] }
  }
  const top = cands[0]
  let comments = []
  try {
    const cl = await commentList(p, top.aweme_id, { count: 20 })
    const list = Array.isArray(cl?.comments) ? cl.comments : []
    comments = list
      .filter((c) => { const pc = pickComment(c); return !(selfNick ? (String(pc.nick || '').trim() === String(selfNick).trim()) : pc.is_author) })
      .sort((a, b) => Number(b.digg_count || 0) - Number(a.digg_count || 0))
      .slice(0, topComments)
      .map((c) => ({ nick: String(c.user?.nickname || ''), text: String(c.text || ''), digg: Number(c.digg_count || 0) }))
  } catch { /* 热评拿不到不影响挑视频 */ }
  // cands 是数组（候选视频），candidateCount 是数量——名字别只差一个 s，调用方踩过。
  return { ok: true, tookMs: Date.now() - t0, scanned, tries, picked: top, candidateCount: cands.length, cands, comments }
}

/** 把视频转成一句可读的摘要（给日报、给模型当材料） */
export function describe(item) {
  const sec = Math.round(Number(item.duration || 0) / 1000)
  const d = String(item.desc || '').replace(/\s+/g, ' ').trim()
  return `${d || '(无文案)'}${sec ? ` [${sec}s]` : ''}${item.author?.nick ? ` @${item.author.nick}` : ''}`
}
