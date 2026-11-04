/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / report.mjs — 观看日报
//
// 取代：browser-local 的 daily-report.mjs + fish-soul 的 life.js 日报段。
// 原则：日报不编故事，每个数字都要能指到 usage 台账里的 action；
//       叙事部分（今天看了什么、心情如何）从 feed 候选与 soul 日记里取真实内容。

import { range, load, availableDays, bump } from './usage.mjs'
import { dayKey, soulPaths } from './soul.mjs'
import { existsSync, readFileSync } from 'node:fs'

const ACTION_LABEL = {
  'feed.browsed': '刷到推荐视频',
  'video.watched': '看了视频',
  'video.picked': '挑中候选',
  'video.shared': '转发视频',
  'dm.received': '收到私信',
  'dm.replied': '回了私信',
  'dm.sent': '发了私信',
  'voice.sent': '发了语音',
  'comment.scanned': '扫了评论区',
  'comment.posted': '回了评论',
  'comment.self': '回了自己作品的评论',
  'comment.failed': '评论没发出去',
  'diary.written': '写了日记',
  'spoke.first': '主动开口',
  'guard.blocked': '被闸门拦下',
}

const ORDER = [
  'feed.browsed', 'video.watched', 'video.picked', 'video.shared',
  'dm.received', 'dm.replied', 'dm.sent', 'voice.sent',
  'comment.scanned', 'comment.self', 'comment.posted', 'comment.failed',
  'diary.written', 'spoke.first', 'guard.blocked',
]

function label(action) {
  return ACTION_LABEL[action] || action
}

/** 一天的数字（只有真正有记录的 action 才出现）。 */
export function digestDay(day = dayKey()) {
  const b = load(day)
  const rows = []
  for (const a of ORDER) {
    const n = b.counts[a] || 0
    if (n > 0) rows.push({ action: a, label: label(a), n })
  }
  // 台账里可能还有 ORDER 之外的动作
  for (const [a, n] of Object.entries(b.counts)) {
    if (n > 0 && !ORDER.includes(a)) rows.push({ action: a, label: label(a), n })
  }
  const shared = b.events.filter((e) => e.action === 'video.shared').map((e) => e.meta?.desc || e.meta?.awemeId).filter(Boolean)
  const replied = b.events.filter((e) => e.action === 'dm.replied' || e.action === 'dm.sent').map((e) => e.meta?.text).filter(Boolean)
  const blocked = b.events.filter((e) => e.action === 'guard.blocked').map((e) => ({ why: e.meta?.why, text: e.meta?.text })).filter((x) => x.why)
  return {
    day,
    hasData: rows.length > 0,
    rows,
    total: rows.reduce((s, r) => s + r.n, 0),
    shared, replied, blocked,
    startedAt: b.startedAt,
  }
}

/** 近 n 天汇总（表格用）。 */
export function digestRange(days = 7) {
  const books = range(days)
  const actions = new Set()
  for (const b of books) for (const [a, n] of Object.entries(b.counts)) if (n > 0) actions.add(a)
  const cols = ORDER.filter((a) => actions.has(a)).concat([...actions].filter((a) => !ORDER.includes(a)))
  return {
    cols: cols.map((a) => ({ action: a, label: label(a) })),
    rows: books.map((b) => ({
      day: b.day,
      cells: cols.map((a) => b.counts[a] || 0),
      total: Object.values(b.counts).reduce((s, n) => s + n, 0),
    })),
    days,
  }
}

/** 读今天的日记（如果写过）。 */
export function todayDiary(day = dayKey()) {
  const f = soulPaths.diary()
  if (!existsSync(f)) return null
  try {
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const j = JSON.parse(lines[i])
      if (j.day === day) return j
    }
  } catch { /* 读坏就当没写 */ }
  return null
}

/**
 * 生成一段给人看的大白话日报。
 * 不打分、不评价，像她自己跟主人说的。
 */
export function narrate(days = 1, { name = '小鱼' } = {}) {
  if (days <= 1) {
    const d = digestDay()
    if (!d.hasData) return { ok: true, text: `今天还没怎么动呢，${name}一直在待着。`, digest: d }
    const parts = []
    const get = (a) => d.rows.find((r) => r.action === a)?.n || 0
    if (get('feed.browsed')) parts.push(`刷了 ${get('feed.browsed')} 轮推荐`)
    if (get('video.watched')) parts.push(`看了 ${get('video.watched')} 个视频`)
    if (get('video.shared')) parts.push(`挑了 ${get('video.shared')} 个分享给你`)
    if (get('dm.sent') + get('dm.replied')) parts.push(`跟你说了 ${get('dm.sent') + get('dm.replied')} 句话`)
    if (get('voice.sent')) parts.push(`发过 ${get('voice.sent')} 条语音`)
    if (get('comment.posted') + get('comment.self')) parts.push(`回了 ${get('comment.posted') + get('comment.self')} 条评论`)
    if (get('guard.blocked')) parts.push(`被拦下 ${get('guard.blocked')} 次（怕说错话）`)
    const head = parts.length ? `今天我${parts.join('，')}。` : `今天我就在旁边待着。`
    const tail = d.shared.length ? `\n给你挑的是：${d.shared.slice(0, 3).join('；')}` : ''
    const diary = todayDiary()
    const dline = diary?.text ? `\n我的日记写了一句：${diary.text}` : ''
    return { ok: true, text: head + tail + dline, digest: d }
  }
  const r = digestRange(days)
  const sums = r.cols.map((c, i) => ({ ...c, n: r.rows.reduce((s, row) => s + row.cells[i], 0) }))
  const active = sums.filter((s) => s.n > 0)
  if (!active.length) return { ok: true, text: `这 ${days} 天基本没动过。`, range: r }
  const line = active.map((s) => `${s.label} ${s.n}`).join('，')
  return { ok: true, text: `这 ${days} 天：${line}。`, range: r }
}

/** 记一笔日报（供插件在收到"生成日报"请求时落账，避免重复生成）。 */
export function markGenerated() {
  bump('report.generated', {})
}
