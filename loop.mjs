/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / loop.mjs — 在专用 Edge 里跑「一轮」的主体逻辑
//
// 为什么是一轮而不是一个一直跑的后台循环：
//   · DSH 插件会被重载（loader/volatile-update），常驻定时器容易跑出两份；
//   · 出问题时开发/用户都能手动触发一轮，看完 events.jsonl 就知道卡在哪；
//   · 自我调度的「下一轮」由一个 setTimeout 串起来，进程活着就一直转，
//     进程死了也不会有 zombie 定时器（老 watch 的坑）。
//
// 一轮做什么（都是开关化的，默认只做最安全的几件）：
//   1. 探活 Edge（空壳则补页）
//   2. 开一个干净的 /chat 页，等接口就绪
//   3. 看左栏有没有新私信 → 回
//   4. 扫自己作品下的新评论 → 回
//   5. 刷推荐流 → 挑一条 → 可选转发给对端
//   6. 按需写日记、生成日报

import { ensureEdge, connect, openFreshPage, closePage, healthCheck, ensureLivePage, pruneTargets, listPages, sleep, stateRoot } from './edge.mjs'
import * as api from './api.mjs'
import * as chat from './chat.mjs'
import * as comments from './comments.mjs'
import * as feed from './feed.mjs'
import * as share from './share.mjs'
import * as voice from './voice.mjs'
import * as usage from './usage.mjs'
import * as report from './report.mjs'
import { Guard } from './guard.mjs'
import { paths } from './edge.mjs'
import { activeWindow } from './soul.mjs'
import { outboundLocked } from './setup.mjs'
import { join } from 'node:path'
import { readState, writeState, appendEvent } from './state.mjs'

/** 一轮的上下文：页面、闸门、灵魂、大脑，都在这里备好。 */
export async function makeRound({ cfg, soul, brain, guard, log = () => { } }) {
  const port = Number(cfg.port || 9334)
  const edge = await ensureEdge({ port, headless: cfg.headless !== false, url: 'https://www.douyin.com/chat', browserPath: cfg.browserPath || '' })
  // 空壳（端口在、没有 page）时补一个常驻页，否则后面开新页会一起失败
  try { await ensureLivePage(edge.port) } catch { /* 补不上就下面 open 时再报 */ }
  const cdp = await connect(edge.port)
  // 顺手回收几轮下来泄漏的空白页（closePage 之后 target 总数并不会下降）
  try {
    const p = await pruneTargets(edge.port, { max: 3 })
    if (p.ok && p.closed > 0) log('info', `回收了 ${p.closed} 个残留页（原有 ${p.pages} 个）`)
  } catch { /* 回收失败不影响这一轮 */ }
  return { cdp, port: edge.port, edge, cfg, soul, brain, guard, log }
}

/**
 * 在「干净的新页」上跑一段逻辑，跑完把页收掉。
 * 所有真正的操作都应该走这里 —— 页复用是「半死」的唯一来源。
 */
export async function onPage(round, fn, { navigate = null } = {}) {
  const t = round
  const r = await openFreshPage(t.cdp, t.port, navigate || 'https://www.douyin.com/chat')
  try {
    // 签名头要页面自己跑一会儿才生成，先拿最便宜的接口探一下
    if (!navigate) {
      const w = await api.warmup(r.s, { tries: 6, gapMs: 600 })
      if (!w.ok) t.log('warn', `接口还没就绪（${w.head || '?'}），照常继续`)
    }
    return await fn(r.s, r)
  } finally {
    await closePage(t.cdp, r.targetId)
  }
}

/** 关掉一轮的 CDP 根会话（浏览器进程不杀）。 */
export function endRound(round) {
  try { round.cdp?.close() } catch { /* ignore */ }
}

// ── 私信 ────────────────────────────────────────────────────────────────────

/**
 * 看左栏有没有新私信并回一条。
 *
 * 判据（实测过的三条）：
 *   · 会话行文本变了 → 有新消息（抖音私信没有独立的「收件箱接口」）
 *   · 未读角标 > 0 → 有新消息
 *   · 两者都没有但离上次检查超过 10 分钟 → 主动点开看一眼（兜底）
 *
 * @returns {Promise<{ok:boolean, acted:boolean, why?:string, sent?:string}>}
 */
export async function dmRound(round, { force = false } = {}) {
  const t = round
  const c = t.cfg
  const peer = String(c.peer || '').trim()
  if (!peer) return { ok: false, acted: false, why: '没配置对端昵称（设置页 → 抖音自动陪伴 → 基础设置 → 对端昵称）' }
  if (!c.dm?.enabled) return { ok: true, acted: false, why: '私信功能已关闭' }

  const wm = readState('chat-watermark.json', {}) || {}
  const cur = wm[peer] || {}

  return await onPage(t, async (p) => {
    const rows = await chat.conversationRows(p, { waitMs: 15000 })
    const row = chat.findConversationRow(rows, peer)
    if (!row) {
      return { ok: false, acted: false, why: `左栏没找到「${peer}」（会话可能在折叠区里，或昵称改了）` }
    }

    const changed = cur.row !== row.text
    const unread = Array.isArray(row.unread) ? row.unread : []
    let needOpen = force || changed || unread.length > 0
    if (!needOpen && cur.checkedAt && Date.now() - Number(cur.checkedAt) < 10 * 60 * 1000) {
      return { ok: true, acted: false, why: '没有新消息' }
    }

    const oc = await chat.openConversation(p, { nick: peer })
    if (!oc.ok) return { ok: false, acted: false, why: '打不开会话：' + (oc.why || oc.code) }
    const msgs = await chat.readMessages(p)
    const incoming = lastIncoming(msgs, cur.messages || 0)
    wm[peer] = { ...cur, row: row.text, checkedAt: Date.now(), messages: msgs.length }
    writeState('chat-watermark.json', wm)

    if (!incoming.length) return { ok: true, acted: false, why: '点了会话但没有新的对方消息' }

    const acted = []
    for (const m of incoming.slice(-1)) {
      if (!c.dm.autoReply) break
      // 故意慢一点再回，秒回太像机器人
      if (Number(c.dm.replyDelayMs || 0) > 0) await sleep(Math.max(0, Math.min(30000, Number(c.dm.replyDelayMs))))
      // 闸门拿占位符 'x' 去查只有「空正文/太频繁/超配额」——真正的正文校验放在拿到模型输出之后
      const g = t.guard.checkDm({ text: 'x', to: peer })
      if (!g.ok) { acted.push('闸门拦下：' + g.why); break }

      // 他主动来了就一定要回：免打扰时段只管「她主动开口」，不拦「回复」。
      const out = await t.brain.replyDm({ who: peer, incoming: m.text, recent: msgs.slice(-8) })
      if (!out || !out.text) { acted.push('模型没给出话'); break }
      const gb = t.guard.checkDm({ text: out.text, to: peer })
      if (!gb.ok) { acted.push('闸门拦下：' + gb.why); break }
      const sent = await chat.sendMessage(p, out.text, { nick: peer, timeoutMs: 25000 })
      if (!sent.ok) {
        usage.bump('dm.failed', { why: sent.code })
        acted.push('发送失败：' + (sent.why || sent.code))
        break
      }
      const rowRec = t.guard.reserve('dm', { text: out.text, to: peer, source: out.source })
      t.guard.confirm(rowRec)
      usage.bump('dm.replied', { who: peer })
      appendEvent({ job: 'dm', ok: true, who: peer, incoming: m.text.slice(0, 100), out: out.text.slice(0, 100), source: out.source })
      acted.push('回了：' + out.text)
      t.soul.bumpAffection(peer, 1)

      // 顺带记一句关于他的话
      try {
        const mems = await t.brain.extractMemories({ who: peer, lines: msgs.slice(-6) })
        for (const mm of mems) {
          t.soul.remember({ text: mm.text, who: peer, kind: mm.kind || 'fact', importance: mm.importance || 3, evidence: m.text.slice(0, 120) })
        }
        if (mems.length) acted.push(`记下 ${mems.length} 条记忆`)
      } catch (e) { t.log('warn', '抽取记忆失败：' + (e?.message || e)) }

      if (c.dm.voiceReply) {
        try {
          const v = await voice.speak(out.text, { preset: c.dm.voicePreset || voice.DEFAULT_PRESET })
          if (v.ok) {
            // 抖音私信没法发本地音频文件，只能记一笔等 IM 渠道去发
            usage.bump('voice.sent', { file: v.path })
            appendEvent({ job: 'voice', ok: true, file: v.path, bytes: v.bytes })
            acted.push('语音已合成（' + Math.round(v.bytes / 1024) + 'KB）')
          }
        } catch (e) { t.log('warn', '语音合成失败：' + (e?.message || e)) }
      }
    }
    return { ok: true, acted: acted.length > 0, why: acted.join('；') || '不必回复', sent: acted.join('；') }
  })
}

/** 从消息数组里取出「比上次多出来的、对方说的」部分。 */
function lastIncoming(msgs, seenCount) {
  const list = Array.isArray(msgs) ? msgs : []
  const fresh = list.slice(Math.max(0, Number(seenCount) || 0))
  const incoming = fresh.filter((m) => !m.mine && String(m.text || '').trim())
  // 兜底：有时候消息条数不变（换会话时复用），那就取最后三条里对方的最后一条
  if (!incoming.length && list.length) {
    const tail = list.slice(-3).filter((m) => !m.mine)
    return tail.slice(-1)
  }
  return incoming
}

// ── 评论 ────────────────────────────────────────────────────────────────────

/**
 * 扫「自己作品」下的评论并回。
 * 不依赖上方通知（本号的 /aweme/v1/web/notice/ 恒 status_code:5），直接读作品列表。
 */
export async function commentRound(round, { awemeIds = [], maxWorks = 5, perWork = 10 } = {}) {
  const t = round
  const c = t.cfg.comments || {}
  if (!c.selfWorks && !c.others) return { ok: true, posted: 0, why: '评论回复已关闭' }

  return await onPage(t, async (p) => {
    const mine = await api.myWorks(p, { count: 20 })
    const works = (mine?.aweme_list || []).map(api.pickWork).filter((w) => w.aweme_id)
    const ids = awemeIds.length ? awemeIds : works.slice(0, maxWorks).map((w) => w.aweme_id)
    if (!ids.length) return { ok: false, posted: 0, why: '没读到自己的作品' }

    const selfNick = String(t.cfg.owner || '').trim()
    const skips = c.skipNicks || []
    // 「只回多久以内的评论」跟下面「作品最长多久」是同一件事的两个口径，
    // 不能再单独写死 48 小时 —— 那会让 7 天内的作品只剩最后两天有回复。
    const maxAge = Number(c.workMaxAgeDays || 7) * 24
    let posted = 0
    const notes = []
    const now = Date.now()

    for (const id of ids) {
      const w = works.find((x) => x.aweme_id === id) || { aweme_id: id, desc: '' }
      const ageDays = w.create_time ? (now - w.create_time * 1000) / 86400000 : 0
      if (c.workMaxAgeDays && ageDays > c.workMaxAgeDays) { notes.push(`${id} 太旧，跳过`); continue }
      const lc = await comments.listComments(p, id, { max: perWork })
      if (!lc.ok) { notes.push(`${id} 读评论失败`); continue }
      usage.bump('comment.scanned', { aweme: id, n: lc.items.length })
      const cand = comments.pickReplies(
        lc.items.map((x) => ({ ...x, time: x.time })),
        { selfNick, skipNicks: skips, maxAgeHours: maxAge, now, limit: Math.max(1, Number(c.maxPerRound || 3)) },
      )
      for (const it of cand.picked) {
        if (posted >= Number(c.maxPerRound || 3)) break
        const target = `${id}:${it.cid}`
        // 第一次只判目标重复与额度，不传正文：传占位符 'x' 会让「同作品同正文」那一条把
        // 每次回复都判成一模一样（回的内容还没生成呢）。正文类校验留给下面 g2。
        const g = t.guard.checkComment({ awemeId: id, target, source: 'comment' })
        if (!g.ok) { notes.push(`${it.cid} 闸门：${g.why}`); continue }

        const out = await t.brain.replyComment({ awemeDesc: w.desc, author: it.nick, incoming: it.text, isSelfWork: true })
        const g2 = t.guard.checkComment({ awemeId: id, target, text: out.text, source: out.source, reserve: false, skipPending: true })
        if (!g2.ok) { t.guard.markFailed(g.row, g2.why); notes.push(`${it.cid} 内容被拦：${g2.why}`); continue }

        const r = await comments.postComment(p, { awemeId: id, text: out.text, replyId: it.cid })
        if (!r.ok) {
          t.guard.markFailed(g2.row, r.code)
          usage.bump('comment.failed', { aweme: id, code: r.code })
          notes.push(`${it.cid} 发送失败：${r.code}`)
          continue
        }
        t.guard.confirm(g2.row || g.row, { cid: r.cid, text: out.text })
        usage.bump('comment.self', { aweme: id, cid: r.cid })
        appendEvent({ job: 'comment', ok: true, aweme: id, cid: r.cid, to: it.nick, incoming: it.text.slice(0, 80), out: out.text })
        posted++
        notes.push(`回了 ${it.nick}：${out.text}`)
        await sleep(1500)
      }
    }
    return { ok: true, posted, scannedWorks: ids.length, notes, why: notes.join('；') || '没有需要回的评论' }
  })
}

// ── 刷流 / 转发 ─────────────────────────────────────────────────────────────
//
// 诉求：助手要真的看懂视频、真的刷过之后才表态，并且有自己的兴趣取向。
//
// 所以这里不再只是「按关键词打分挑一条」，而是：
//   1. 刷一批 → 粗筛出 3 条候选（feed.pick 仍用关键词做第一道，减少模型调用）；
//   2. 让她**真的看一遍**：analyzeVideo 抽标签 + judgeVideo 凭自己的口味表态；
//   3. 表态写回 soul.learn()，口味随次数累积（这是「有自己的取向」的实现）；
//   4. 按她的表态决定动作：
//        like    → 想分享就分享给账号持有人（受免打扰/频率限制）/ 想评论就在评论区 @ 账号持有人（可选）
//        neutral → 只是看了，不发声
//        dislike → 记下来，什么都不做
//   5. 只有「真的想说」才发声，且主动发声必须过 activeWindow() 这一关。

/** 主动发声前的统一闸门：免打扰时段 + 最小间隔 + 每日上限。 */
function canSpeakNow(t, { perDay = 8 } = {}) {
  const q = t.cfg.dm?.quiet || {}
  const w = activeWindow({ ...q, __lastProactiveAt: t.soul.state?.lastSpeakAt || 0 })
  if (!w.ok) return w
  const quota = t.soul.canSpeakFirst({ perDay })
  if (!quota.ok) return quota
  return { ok: true, used: quota.used, perDay: quota.perDay }
}

export async function feedRound(round, { count = 6, share: doShare = null, mention: doMention = null } = {}) {
  const t = round
  const c = t.cfg.feed || {}
  if (!c.enabled) return { ok: true, picked: null, why: '刷流已关闭' }

  // 她自己的口味画像（来自 soul.interests + 长期记忆里的「喜欢…」）
  const taste = t.soul.tastePrompt()
  const tasteMem = t.brain.tasteFromMemory ? t.brain.tasteFromMemory(6) : []
  const tasteAll = [taste, tasteMem.length ? tasteMem.join('；') : ''].filter(Boolean).join('｜')

  return await onPage(t, async (p) => {
    const r = await feed.pickWithContext(p, {
      count: Number(count || c.count || 6),
      limit: 3,                       // 多拿两条候选让模型挑，别只给一条
      dislike: c.dislike || [],
      like: c.like || [],
      tasteTags: t.soul.getInterests().likes.map((x) => x.tag),
      tasteScore: (tags) => t.soul.tasteScore(tags),
    })
    if (!r.ok) {
      usage.bump('feed.browsed', { ok: 0, why: r.code || r.why })
      return { ok: false, picked: null, why: r.why || r.code || '这轮没有想说的' }
    }
    usage.bump('feed.browsed', { ok: 1, n: r.scanned })

    // ── 让她真的看一遍：抽标签 → 凭口味表态 ──
    let chosen = null
    // pickWithContext 回来的候选列表字段叫 cands（不是 candidates），
    // 兜底也不能拿 null 去 slice——先过滤掉空值再切。
    const pool = (Array.isArray(r.cands) && r.cands.length ? r.cands : [r.picked]).filter(Boolean)
    for (const cand of pool.slice(0, 3)) {
      const an = await t.brain.analyzeVideo({
        desc: cand.desc,
        author: cand.author?.nick || '',
        durationMs: cand.duration,
        comments: cand === r.picked ? r.comments : [],
      }).catch(() => ({ ok: false, tags: [] }))
      const jd = await t.brain.judgeVideo({
        summary: an.summary || '',
        tags: an.tags || [],
        desc: cand.desc,
        taste: tasteAll,
      }).catch(() => ({ ok: false, verdict: 'neutral', strength: 1, reaction: '' }))
      // 口味立刻长一点：明显喜欢的记强，明显的 dislike 也记
      try {
        t.soul.learn({
          tags: an.tags || [],
          verdict: jd.verdict === 'like' ? 'like' : jd.verdict === 'dislike' ? 'dislike' : 'neutral',
          strength: jd.strength || 1,
          item: { awemeId: cand.aweme_id, desc: cand.desc },
        })
      } catch (e) { t.log('warn', '更新口味失败：' + (e?.message || e)) }
      appendEvent({
        job: 'browse', ok: true, aweme: cand.aweme_id,
        summary: String(an.summary || '').slice(0, 60),
        tags: an.tags || [], verdict: jd.verdict, strength: jd.strength || 1,
        reaction: String(jd.reaction || '').slice(0, 40),
      })
      // 第一条「表态为 like」的就选它；都没有就退回第一条候选
      if (!chosen) chosen = { cand, an, jd }
      if (jd.verdict === 'like') { chosen = { cand, an, jd }; break }
      await sleep(1200)
    }
    if (!chosen) return { ok: false, picked: null, why: '没挑出可看的视频' }

    const { cand, an, jd } = chosen
    usage.bump('video.picked', { aweme: cand.aweme_id })
    appendEvent({ job: 'feed', ok: true, aweme: cand.aweme_id, desc: String(cand.desc || '').slice(0, 80), verdict: jd.verdict })

    const out = {
      ok: true,
      picked: cand,
      comments: r.comments,
      summary: an.summary,
      tags: an.tags,
      verdict: jd.verdict,
      reaction: jd.reaction,
      taste: t.soul.getInterests().likes.slice(0, 5),
      why: `${feed.describe(cand)}${an.summary ? ' → ' + an.summary : ''}（${jd.verdict}）`,
    }

    // ── 动作一：分享给账号持有人 ──
    const wantShare = doShare === null ? !!c.shareToPeer : !!doShare
    if (wantShare && jd.verdict !== 'dislike') {
      const gate = canSpeakNow(t, { perDay: Number(t.cfg.dm?.perDay || 40) })
      if (!gate.ok) return { ...out, share: { ok: false, skipped: true, why: gate.why } }
      const peer = String(t.cfg.peer || '').trim()
      if (!peer) return { ...out, share: { ok: false, why: '没配置对端昵称' } }
      const pitch = await t.brain.pickPitch({ who: peer, videoDesc: feed.describe(cand), comments: r.comments })
      const text = (pitch.text ? pitch.text + '\n' : '') + api.workUrl(cand.aweme_id)
      const g = t.guard.checkDm({ text, to: peer })
      if (!g.ok) return { ...out, share: { ok: false, why: g.why } }
      const s = await share.shareLink(p, { awemeId: cand.aweme_id, peer, text })
      if (s.ok) {
        const rec = t.guard.reserve('dm', { text, to: peer, source: 'feed-share' })
        t.guard.confirm(rec)
        t.soul.markSpoke()
        t.soul.state.lastSpeakAt = Date.now()
        t.soul.saveState()
        usage.bump('video.shared', { aweme: cand.aweme_id })
        appendEvent({ job: 'share', ok: true, aweme: cand.aweme_id, via: 'link' })
      }
      out.share = s
    }

    // ── 动作二：在别人视频的评论区 @ 账号持有人 ──
    // 用户的诉求：「不会在别的视频评论区下 @ 我」。
    // 默认关（公开评论会被人看到），开了才做；且只对「她自己真的喜欢」的视频发。
    const wantMention = doMention === null ? !!c.mentionPeer : !!doMention
    if (wantMention && jd.verdict === 'like') {
      const owner = String(t.cfg.owner || '').trim()
      if (!owner) return { ...out, mention: { ok: false, why: '没配置账号持有人昵称' } }
      const gate = canSpeakNow(t, { perDay: Number(t.cfg.dm?.perDay || 40) })
      if (!gate.ok) return { ...out, mention: { ok: false, skipped: true, why: gate.why } }
      const target = `${cand.aweme_id}:mention:${owner}`
      const g1 = t.guard.checkComment({ awemeId: cand.aweme_id, target, source: 'mention' })
      if (!g1.ok) return { ...out, mention: { ok: false, why: g1.why } }
      const txt = await t.brain.commentMention({
        who: owner,
        videoSummary: an.summary,
        videoDesc: cand.desc,
        reaction: jd.reaction,
        tags: an.tags,
      })
      if (!txt.ok) {
        t.guard.markFailed(g1.row, txt.why || 'no-text')
        return { ...out, mention: { ok: false, why: txt.why || '模型没给出话' } }
      }
      const g2 = t.guard.checkComment({ awemeId: cand.aweme_id, target, text: txt.text, source: 'mention', reserve: false, skipPending: true })
      if (!g2.ok) {
        t.guard.markFailed(g1.row, g2.why)
        return { ...out, mention: { ok: false, why: '内容被拦：' + g2.why } }
      }
      const posted = await comments.postComment(p, { awemeId: cand.aweme_id, text: txt.text })
      if (!posted.ok) {
        t.guard.markFailed(g2.row || g1.row, posted.code)
        usage.bump('comment.failed', { aweme: cand.aweme_id, code: posted.code, job: 'mention' })
        return { ...out, mention: { ok: false, why: posted.code } }
      }
      t.guard.confirm(g2.row || g1.row, { cid: posted.cid, text: txt.text })
      t.soul.markSpoke()
      t.soul.state.lastSpeakAt = Date.now()
      t.soul.saveState()
      usage.bump('comment.mention', { aweme: cand.aweme_id, cid: posted.cid })
      appendEvent({ job: 'mention', ok: true, aweme: cand.aweme_id, cid: posted.cid, out: txt.text })
      out.mention = { ok: true, cid: posted.cid, text: txt.text }
    }

    return out
  })
}

// ── 日记 / 日报 ─────────────────────────────────────────────────────────────

export async function diaryRound(round) {
  const t = round
  if (t.soul.hasDiaryToday) return { ok: true, wrote: false, why: '今天已经写过了' }
  const d = report.digestDay()
  const lines = []
  const n = (k) => Number(d?.counts?.[k] || 0)
  if (n('dm.replied')) lines.push(`回了 ${n('dm.replied')} 条私信`)
  if (n('comment.self')) lines.push(`回了 ${n('comment.self')} 条评论`)
  if (n('video.shared')) lines.push(`转发了 ${n('video.shared')} 个视频`)
  if (n('feed.browsed')) lines.push(`刷了 ${n('feed.browsed')} 次推荐`)
  const dayText = lines.length ? lines.join('，') : '今天几乎没怎么动，安静地待着。'
  const w = await t.brain.writeDiary({ dayText, name: t.cfg.peer })
  const text = w.text || dayText
  t.soul.writeDiary(text)
  usage.bump('diary.written', {})
  appendEvent({ job: 'diary', ok: true, text })
  return { ok: true, wrote: true, text, basedOn: dayText, source: w.source }
}

export async function reportRound(round) {
  const r = report.narrate(1, { name: round.cfg.persona?.name || '助手' })
  appendEvent({ job: 'report', ok: true, head: String(r?.text || r || '').slice(0, 200) })
  return { ok: true, report: r }
}

// ── 一轮完整跑 ──────────────────────────────────────────────────────────────

export async function runRound({ cfg, soul, brain, guard, log = () => { }, parts = null } = {}) {
  const want = parts || {
    dm: !!cfg.dm?.enabled,
    comments: !!(cfg.comments?.selfWorks || cfg.comments?.others),
    feed: !!cfg.feed?.enabled,
    diary: true,
  }
  // 开通向导没走完 = 这个插件还不知道「我是谁、该跟谁说话」。
  // 这时候任何对外发送都是替陌生用户去联系真人，所以一律不发：
  // 只留刷流（不对外）与日记（本地）。锁死原因要明确写进结果，别让用户以为插件坏了。
  const locked = outboundLocked(cfg)
  if (locked) log('warn', '开通向导还没走完，已跳过私信/评论/分享/@（设置页 → 抖音自动陪伴 → 首次开通）')
  const round = await makeRound({ cfg, soul, brain, guard, log })
  const out = { at: new Date().toISOString(), locked, parts: {} }
  try {
    if (locked) {
      out.parts.dm = { ok: true, acted: false, why: LOCK_WHY }
      out.parts.comments = { ok: true, posted: 0, why: LOCK_WHY }
    } else {
      if (want.dm) out.parts.dm = await safe('dm', () => dmRound(round), log)
      if (want.comments) out.parts.comments = await safe('comments', () => commentRound(round), log)
    }
    if (want.feed) {
      // 刷流本身不对外，但「转发/评论 @ 人」是出站动作，锁死时必须显式关掉。
      out.parts.feed = await safe('feed', () => (locked
        ? feedRound(round, { share: false, mention: false })
        : feedRound(round)), log)
    }
    if (want.diary) out.parts.diary = await safe('diary', () => diaryRound(round), log)
  } finally {
    endRound(round)
  }
  appendEvent({ job: 'round', ok: true, locked, parts: Object.fromEntries(Object.entries(out.parts).map(([k, v]) => [k, v?.ok])) })
  return out
}

const LOCK_WHY = '开通向导未完成，出站已锁（设置页 → 抖音自动陪伴 → 首次开通）'

async function safe(name, fn, log) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { ...r, ms: Date.now() - t0 }
  } catch (e) {
    log('error', `${name} 失败：${e?.message || e}`)
    appendEvent({ job: name, ok: false, error: String(e?.message || e) })
    return { ok: false, error: String(e?.message || e), ms: Date.now() - t0 }
  }
}

export { usage, report, paths }
