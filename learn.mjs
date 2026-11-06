/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / learn.mjs —— 从对方说的话里学「他的兴趣」，然后让她真的用上
//
// 用户的诉求原话：「并根据我的回复兴趣了解我的兴趣点」。
//
// 两条通路：
//   A. 私信：对方聊到什么，就把它变成**她自己的**口味标签（他爱看什么，她就学着爱看什么），
//      并让下一次回话和刷流都带着这份口味（replyDm 的 personaPrompt 里已经带 tastePrompt）。
//   B. 分享回来的视频：她把视频分享给他，他如果回「这个好看」「还有吗」，这就是最强的正反馈 ——
//      直接给这类内容加权。
//
// 刻意不做的事：不把「他喜欢 X」写成长期记忆条目。实测那样会灌出上百条
// 「他关注大肥鱼相关的内容」「他分享了一个带 #deepseek 标签的视频」这种自我指涉的垃圾。
// 口味是口味，记忆是记忆，分开存。

import * as api from './api.mjs'
import * as feed from './feed.mjs'
import * as usage from './usage.mjs'
import { appendEvent } from './state.mjs'

// ── 词表 ────────────────────────────────────────────────────────────────────
// 她能在私信里听懂的「内容品类」。命中就记成 she 的口味标签。
// 宁可少列也别乱列：标签会进画像，乱标签会让刷流全跑偏。
const TOPIC_WORDS = [
  '桌宠', '插件', '大模型', 'AI', '人工智能', '开源', '编程', '代码', '写代码', '硬件', '显卡', '电脑',
  '猫', '猫片', '橘猫', '狗', '仓鼠', '鲸鱼', '海豚',
  '二次元', '动画', '番剧', '漫画', '手办', '游戏', '手游', '主机游戏', '像素',
  '科技', '数码', '手机', '评测',
  '音乐', '歌', '唱歌', '翻唱', '鼓', '吉他',
  '做饭', '美食', '甜点', '咖啡',
  '旅行', '风景', '露营', '骑行', '跑步', '健身',
  '科普', '历史', '纪录片', '电影', '影视', '剧情', '短剧', '动漫',
  '搞笑', '沙雕', '吐槽', '解压', 'ASMR',
  '穿搭', '摄影', '手工', '画画', '手绘', '剪辑',
]

const LIKE_WORDS = ['喜欢', '爱看', '爱刷', '想看', '好看', '多来点', '再来点', '有点意思', '有意思', '再来', '还有吗', '多发', '收藏', '笑死', '太顶了', '顶了', '不错', '好用']
const DISLIKE_WORDS = ['不喜欢', '讨厌', '没意思', '无聊', '别发', '不想看', '太吵', '太吵了', '腻了', '腻', '无感', '不想']

// 长词先匹配：否则「不喜欢」会被「喜欢」抢走，「猫片」会被「猫」抢走。
const ALL_EMO = [...LIKE_WORDS.map((w) => ({ w, pol: 'like' })), ...DISLIKE_WORDS.map((w) => ({ w, pol: 'dislike' }))]
  .sort((a, b) => b.w.length - a.w.length)

/** 找出句子里所有情绪词，且**不重叠**（吃掉已匹配的区间，避免「不喜欢」里再认出「喜欢」）。 */
function emotionsIn(s) {
  const taken = new Array(s.length).fill(false)
  const hits = []
  for (const e of ALL_EMO) {
    let i = -1
    while ((i = s.indexOf(e.w, i + 1)) >= 0) {
      let free = true
      for (let k = i; k < i + e.w.length; k++) if (taken[k]) { free = false; break }
      if (!free) continue
      for (let k = i; k < i + e.w.length; k++) taken[k] = true
      hits.push({ at: i, end: i + e.w.length, pol: e.pol, w: e.w })
    }
  }
  return hits
}

/** 从一句话里认出「他在说内容品类」。返回 [{word, polarity:'like'|'dislike'}] */
export function topicsFrom(text, { dislikeHint = false } = {}) {
  const s = String(text || '')
  if (!s.trim()) return []
  const emo = emotionsIn(s)
  const out = []
  for (const w of TOPIC_WORDS) {
    if (!s.includes(w)) continue
    const at = s.indexOf(w)
    // 只认**同一分句**里的情绪：不能在逗号/句号另一边乱认（「今天好累，不过猫片不错」里
    // 前半句的情绪不该算到后半句上）。分句边界取最近的一个标点。
    const segStart = Math.max(0, ...[...'，。！？,.!?~ '].map((p) => s.lastIndexOf(p, at - 1) + 1))
    const segEndRaw = [...'，。！？,.!?~ '].map((p) => s.indexOf(p, at)).filter((x) => x >= 0)
    const segEnd = segEndRaw.length ? Math.min(...segEndRaw) : s.length
    const near = emo.filter((e) => e.at >= segStart && e.end <= segEnd)
    let pol = 'neutral'
    if (near.length) {
      // 取离品类词最近的那个情绪词
      near.sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))
      pol = near[0].pol
    } else if (dislikeHint) pol = 'dislike'
    if (pol === 'neutral') continue
    out.push({ word: w, polarity: pol, at })
  }
  // 同一件事别占三格：「猫片」「橘猫」都指向猫 —— 互含的标签只留最长的那个
  out.sort((a, b) => b.word.length - a.word.length)
  const merged = []
  for (const o of out) {
    if (merged.some((m) => m.word.includes(o.word) || o.word.includes(m.word))) continue
    merged.push(o)
  }
  return merged.slice(0, 4).map(({ word, polarity }) => ({ word, polarity }))
}

/** 他发来的东西是不是「对我分享的视频的反应」。 */
export function looksLikeReaction(text) {
  const s = String(text || '')
  if (!s) return false
  if (!/好看|不错|可以|喜欢|笑了|好家伙|这也|还有吗|再来|有点意思|太|绝了|牛逼|厉害|\?$|？$/.test(s)) return false
  return s.length <= 40
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 私信里学口味。
 * @param {object} soul
 * @param {string} text 对方这条私信
 * @param {{awemeId?:string}} lastShare 上一次分享的视频（有的话，这条回复就是对他的反馈）
 * @returns {{learned:Array, reaction?:object}}
 */
export async function learnFromDm(soul, text, { peer = '', lastShare = null, tagger } = {}) {
  const hits = topicsFrom(text)
  const result = { learned: [], reaction: null }
  if (!hits.length) return result
  for (const h of hits) {
    try {
      soul.learn({ tags: [h.word], verdict: h.polarity === 'like' ? 'like' : 'dislike', strength: 1.2, item: { desc: `(他说的：${String(text).slice(0, 40)})` } })
      result.learned.push({ tag: h.word, verdict: h.polarity })
    } catch { /* 写画像失败不影响聊天 */ }
  }
  // 他是在回应我刚才分享的那个视频吗？—— 是的话，那条视频的标签吃双倍权重
  if (lastShare && looksLikeReaction(text)) {
    const pos = !DISLIKE_WORDS.some((w) => String(text).includes(w))
    const tags = Array.isArray(lastShare.tags) && lastShare.tags.length ? lastShare.tags : []
    if (tags.length) {
      try {
        soul.learn({ tags, verdict: pos ? 'like' : 'dislike', strength: 1.6, item: { awemeId: lastShare.awemeId, desc: lastShare.desc } })
      } catch { /* 同上 */ }
    }
    result.reaction = { awemeId: lastShare.awemeId, positive: pos, tags }
    appendEvent({ job: 'taste.feedback', ok: true, aweme: lastShare.awemeId, positive: pos, tags, text: String(text).slice(0, 60) })
  }
  if (result.learned.length) {
    usage.bump('taste.learned', { n: result.learned.length })
    appendEvent({ job: 'taste.learned', ok: true, from: 'dm', hits: result.learned, peer })
    // 顺带让她用自己的话讲一次口味（tastePrompt 里那句「说起自己口味你会这样讲」）
    try {
      if (typeof tagger === 'function') {
        const note = await tagger(result.learned)
        if (note) soul.setTasteNote(note)
      }
    } catch { /* 口味自述只是锦上添花 */ }
  }
  return result
}

/**
 * 记住「我刚把哪个视频分享给了他」，好在他回复时判断这是不是反馈。
 * 存 state 目录，进程重启不丢。
 */
export const LAST_SHARE_FILE = 'last-share.json'
