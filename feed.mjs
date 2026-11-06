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
export async function browse(p, { count = 6, timeoutMs = 8000 } = {}) {
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
    },
    duration: Number(w.video?.duration || 0),
    isMine: false,
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

export function score(item, { dislike = [], like = [], tasteTags = [], tasteScore = null } = {}) {
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
  return s
}

export function pick(items, opts = {}) {
  const { limit = 3 } = opts
  return items
    .map((it) => ({ ...it, score: score(it, opts) }))
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 挑几条 + 拉第一条的热评，凑成「她看懂了这条视频」的材料。 */
export async function pickWithContext(p, opts = {}) {
  const { count = 6, limit = 1, topComments = 3, dislike = [], like = [], tasteTags = [], tasteScore = null } = opts
  const br = await browse(p, { count })
  if (!br.ok) return { ok: false, ...br, picked: null, comments: [] }
  const cands = pick(br.items, { dislike, like, tasteTags, tasteScore, limit: Math.max(limit, 3) })
  if (!cands.length) return { ok: false, code: 'nothing-interesting', why: '这轮没有想说的', items: br.items.length, picked: null, comments: [] }
  const top = cands[0]
  let comments = []
  try {
    const cl = await commentList(p, top.aweme_id, { count: 20 })
    const list = Array.isArray(cl?.comments) ? cl.comments : []
    comments = list
      .filter((c) => !pickComment(c).is_author)
      .sort((a, b) => Number(b.digg_count || 0) - Number(a.digg_count || 0))
      .slice(0, topComments)
      .map((c) => ({ nick: String(c.user?.nickname || ''), text: String(c.text || ''), digg: Number(c.digg_count || 0) }))
  } catch { /* 热评拿不到不影响挑视频 */ }
  // cands 是数组（候选视频），candidateCount 是数量——名字别只差一个 s，调用方踩过。
  return { ok: true, tookMs: br.tookMs, scanned: br.items.length, picked: top, candidateCount: cands.length, cands, comments }
}

/** 把视频转成一句可读的摘要（给日报、给模型当材料） */
export function describe(item) {
  const sec = Math.round(Number(item.duration || 0) / 1000)
  const d = String(item.desc || '').replace(/\s+/g, ' ').trim()
  return `${d || '(无文案)'}${sec ? ` [${sec}s]` : ''}${item.author?.nick ? ` @${item.author.nick}` : ''}`
}
