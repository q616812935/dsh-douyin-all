/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / social.mjs —— 刷到视频以后「怎么说话」：评论它 / @ 人 / 私信分享
//
// 为什么单独拆一份：这三件事原来是写在 loop.feedRound 里的三段 if，
// 结果「评论别人视频」和「@ 人」混在一处，谁也说不清哪条开关管哪件事。
// 用户的原话是四件事：分享视频、在别的视频下 @ 我、随机挑感兴趣的视频评论、评论我的作品。
// 这里就是前四件里的前三件的实现。
//
// 都遵守同一条铁律：**先过闸门（guard），再开口**。闸门管字数、禁止词、按目标去重、小时/日额度。

import * as api from './api.mjs'
import * as comments from './comments.mjs'
import * as feed from './feed.mjs'
import * as share from './share.mjs'
import * as usage from './usage.mjs'
import { appendEvent, readState, writeState } from './state.mjs'
import { sleep } from './edge.mjs'

function readStateSafe(file, fb) {
  try { return readState(file, fb) } catch { return fb }
}

/**
 * 在别人的视频下面留一条评论（不是楼中楼，是这个视频的顶层评论）。
 * 文案由模型按「她看懂了这条视频 + 她自己的口味」写，闸门 second-pass 再查一遍。
 *
 * @returns {{ok:boolean, cid?:string, text?:string, why?:string}}
 */
export async function commentOnVideo(t, p, { cand, summary, tags = [], reaction = '', topComments = [] } = {}) {
  const c = t.cfg.comments || {}
  const awemeId = String(cand?.aweme_id || '')
  if (!awemeId) return { ok: false, why: '没有作品号' }
  const target = `${awemeId}:top:${t.cfg.owner || ''}`
  const g = t.guard.checkComment({ awemeId, target, source: 'video-comment' })
  if (!g.ok) return { ok: false, why: g.why }

  const out = await t.brain.commentVideo({
    videoSummary: summary,
    videoDesc: cand.desc,
    author: cand.author?.nick || '',
    tags,
    reaction,
    topComments,
  })
  if (!out || !out.ok || !out.text) {
    t.guard.markFailed(g.row, out?.why || 'no-text')
    return { ok: false, why: out?.why || '模型没给出话' }
  }
  const g2 = t.guard.checkComment({ awemeId, target, text: out.text, source: out.source, reserve: false, skipPending: true })
  if (!g2.ok) {
    t.guard.markFailed(g.row, g2.why)
    return { ok: false, why: '内容被拦：' + g2.why }
  }
  const visited = await visitComments(t, p, awemeId)
  if (!visited.ok) {
    t.guard.markFailed(g2.row || g.row, 'not-visited:' + visited.why)
    appendEvent({ job: 'comment.video', ok: false, aweme: awemeId, code: 'not-visited', why: visited.why })
    return { ok: false, code: 'not-visited', why: '评论区没加载出来（' + visited.why + '），这轮跳过' }
  }
  const posted = await comments.postComment(p, { awemeId, text: out.text })
  if (!posted.ok) {
    t.guard.markFailed(g2.row || g.row, posted.code)
    usage.bump('comment.failed', { aweme: awemeId, code: posted.code, job: 'video' })
    return { ok: false, why: posted.code }
  }
  t.guard.confirm(g2.row || g.row, { cid: posted.cid, text: out.text })
  usage.bump('comment.video', { aweme: awemeId, cid: posted.cid })
  appendEvent({ job: 'comment.video', ok: true, aweme: awemeId, cid: posted.cid, author: cand.author?.nick || '', out: out.text })
  return { ok: true, cid: posted.cid, text: out.text }
}

/**
 * 在别人的视频评论区 @ 账号持有人。
 *
 * 关键：**必须带 user_id 才叫「真的 @ 了」**（见 api.cleanTextExtra）。拿不到 uid 就直接放弃，
 * 不要退化成「正文里写个 @昵称」—— 那样对方收不到任何通知，等于白公开说话。
 */
export async function mentionOwner(t, p, { cand, summary, tags = [], reaction = '', at = null } = {}) {
  const owner = String(t.cfg.owner || '').trim()
  const who = at || t.ownerAt || null
  if (!who || !who.uid) t.missOwnerAt = (t.missOwnerAt || 0) + 1
  if (!owner) return { ok: false, why: '没配置账号持有人昵称' }
  if (!who || !who.uid) return { ok: false, why: `查不到「${owner}」的 uid，@ 不成立，已跳过` }
  const awemeId = String(cand?.aweme_id || '')
  const target = `${awemeId}:mention:${owner}`
  const g = t.guard.checkComment({ awemeId, target, source: 'mention' })
  if (!g.ok) return { ok: false, why: g.why }
  const txt = await t.brain.commentMention({
    who: owner,
    videoSummary: summary,
    videoDesc: cand.desc,
    reaction,
    tags,
  })
  if (!txt.ok || !txt.text) {
    t.guard.markFailed(g.row, txt.why || 'no-text')
    return { ok: false, why: txt.why || '模型没给出话' }
  }
  const g2 = t.guard.checkComment({ awemeId, target, text: txt.text, source: 'mention', reserve: false, skipPending: true })
  if (!g2.ok) {
    t.guard.markFailed(g.row, g2.why)
    return { ok: false, why: '内容被拦：' + g2.why }
  }
  const visited = await visitComments(t, p, awemeId)
  if (!visited.ok) {
    appendEvent({ job: 'mention', ok: false, aweme: awemeId, code: 'not-visited', why: visited.why })
    return { ok: false, code: 'not-visited', why: '评论区没加载出来（' + visited.why + '），这轮不 @' }
  }
  const posted = await comments.postComment(p, { awemeId, text: txt.text, at: { nick: owner, uid: who.uid } })
  if (!posted.ok) {
    t.guard.markFailed(g2.row || g.row, posted.code)
    usage.bump('comment.failed', { aweme: awemeId, code: posted.code, job: 'mention' })
    return { ok: false, why: posted.code }
  }
  t.guard.confirm(g2.row || g.row, { cid: posted.cid, text: txt.text })
  usage.bump('comment.mention', { aweme: awemeId, cid: posted.cid })
  appendEvent({
    job: 'mention', ok: true, aweme: awemeId, cid: posted.cid, out: txt.text,
    // 服务端回执里带回来 user_id = 这次提及是真的
    confirmed: !!posted.mentionedUid, uid: posted.mentionedUid || '',
  })
  t.soul.markSpoke()
  return { ok: true, cid: posted.cid, text: txt.text, confirmed: !!posted.mentionedUid }
}

/**
 * 把刷到的视频分享给对端（发送地用「普通私信 + 链接」，因为卡片会被服务端静默吞掉）。
 * 送达判据来自 chat.sendMessage（左栏会话行变成「刚刚 + 末条」）。
 */
export async function shareToPeer(t, p, { cand, summary, reaction = '', topComments = [], tags = [] } = {}) {
  const peer = String(t.cfg.peer || '').trim()
  if (!peer) return { ok: false, why: '没配置对端昵称' }
  const pitch = await t.brain.pickPitch({
    who: peer,
    videoDesc: summary ? `${feed.describe(cand)}（${summary}）` : feed.describe(cand),
    comments: topComments,
  })
  const text = (pitch.text ? pitch.text + '\n' : '') + api.workUrl(cand.aweme_id)
  const g = t.guard.checkDm({ text, to: peer })
  if (!g.ok) return { ok: false, why: g.why }
  const s = await share.shareLink(p, { awemeId: cand.aweme_id, peer, text })
  if (!s.ok) return { ok: false, why: s.why || 'not-sent', detail: s.detail }
  const rec = t.guard.reserve('dm', { text, to: peer, source: 'feed-share' })
  t.guard.confirm(rec)
  usage.bump('video.shared', { aweme: cand.aweme_id })
  appendEvent({ job: 'share', ok: true, aweme: cand.aweme_id, via: 'link', out: text.slice(0, 100) })
  t.soul.markSpoke()
  // 记下「分享过什么」，等他回话时判断这是不是对这个视频的反馈（learn.mjs 会读它）
  const prev = readStateSafe('last-share.json', {}) || {}
  const shares = Array.isArray(prev.shares) ? prev.shares : []
  shares.unshift({ awemeId: String(cand.aweme_id), desc: String(cand.desc || '').slice(0, 80), tags: Array.isArray(tags) ? tags.slice(0, 8) : [], at: Date.now() })
  try { writeState('last-share.json', { shares: shares.slice(0, 10) }) } catch { /* 记不下来不影响分享 */ }
  return { ok: true, text, conv: s.conv }
}

/**
 * 在发评论之前，先把这条作品的评论区读一遍。
 * 实测：同一个页面里不读评论直接 publish 会回 status_code 2053（"你还没看过这个视频"那一类），
 * 读过一次（total>0）再发就是 0。total=0 的作品说明连评论都没加载出来，别硬发 ——
 * 那种情况客户端也发不出去，等下一轮换视频更划算。
 * @returns {{ok:boolean, total:number, why?:string}}
 */
export async function visitComments(t, p, awemeId) {
  try {
    const r = await api.commentList(p, awemeId, { cursor: 0, count: 20 })
    const code = Number(r?.status_code ?? 0)
    const total = Number(r?.total ?? 0)
    if (code !== 0) return { ok: false, total: 0, why: 'comment-list-' + code }
    if (total <= 0) return { ok: false, total: 0, why: 'no-comments-loaded' }
    return { ok: true, total }
  } catch (e) {
    return { ok: false, total: 0, why: String(e?.message || e) }
  }
}

/** 「这个视频以前见过吗」（同一个视频短时间内不重复动作）。 */
export function seenBefore(t, awemeId) {
  const w = (t.soul.getInterests().watched || []).find((x) => String(x.awemeId) === String(awemeId))
  return w ? { at: Number(w.at || 0), verdict: w.verdict } : null
}

/** 让出一点时间，避免连续动作被风控盯上。 */
export async function breathe(ms = 1500) {
  await sleep(ms)
}

/**
 * 解析「账号持有人」（config.owner 那个人）的 uid / sec_uid。
 *
 * 为什么需要缓存：抖音搜索里同名的号一大堆（实测搜「蓝毛小女仆」返回 6 个同名号），
 * 所以必须靠 `myWorks` 里自己作品的 author 来认；而 `myWorks(sec_user_id:'self')`
 * 在新开的页上并不总是立刻可用（warmup 有时 ok:false 但照常继续），
 * 于是这条链路会**间歇性**失败 —— 线上表现就是每隔几轮冒出一次
 * 「按昵称「蓝毛小女仆」没搜到完全一致的用户，这轮不 @ 人」，然后 @ 人这轮就没了。
 *
 * 所以：解析成功一次就写进 state/owner-id.json，以后直接读缓存；
 * 缓存命中就直接返回，压根不再开页查 —— 同时省掉一次开页 + 一次接口调用。
 *
 * @returns {{nick:string, uid:string, sec_uid:string}|null}
 */
export function cachedOwner(t) {
  const want = String((t && t.cfg && t.cfg.owner) || '').trim()
  if (!want) return null
  try {
    const c = readStateSafe('owner-id.json', {}) || {}
    if (c && c.uid && String(c.nick || '') === want) {
      return { nick: String(c.nick), uid: String(c.uid), sec_uid: String(c.sec_uid || '') }
    }
  } catch { /* 缓存坏了就当没有 */ }
  return null
}

/** 解析成功就落盘，下次轮次直接复用。 */
export function rememberOwner(t, who) {
  if (!who || !who.uid) return null
  const nick = String((t && t.cfg && t.cfg.owner) || who.nick || '').trim()
  try {
    writeState('owner-id.json', { nick, uid: String(who.uid), sec_uid: String(who.sec_uid || ''), at: Date.now() })
  } catch { /* 存不下来不影响本轮 */ }
  return who
}

/**
 * 在给定页上解析 owner uid：先 myWorks 的 author（最准），再拿搜索结果里昵称完全一致的。
 * 任一成功都会写缓存。失败返回 null，由调用方决定是否放弃这一轮的 @ 动作。
 */
export async function resolveOwner(t, p) {
  const hit = cachedOwner(t)
  if (hit) return hit
  const want = String((t && t.cfg && t.cfg.owner) || '').trim()
  if (!want) return null
  const mine = await api.myUser(p).catch(() => null)
  if (mine && mine.uid) return rememberOwner(t, mine)
  const sr = await api.searchUser(p, want, { count: 10 }).catch(() => null)
  const hit2 = sr && sr.ok ? api.exactUser(sr, want) : null
  if (hit2 && hit2.uid) return rememberOwner(t, hit2)
  return null
}
