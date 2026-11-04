/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / usage.mjs — 用量台账（日报与限速的共同底座）
//
// 取代：browser-local 的 usage-ledger.mjs / daily-report.mjs、watch 的 usage 字段、
//       fish-soul 的 life.js。三家里只有浏览器本地的"计数"是真做成日切文件的，所以结构照它。
//
// 设计要点：
//   · 一天一个文件 usage-YYYY-MM-DD.json，跨天自动滚。
//   · 只记"发生过的事"，不记预测：谁发的话、回了哪条、花了多久。
//   · 读的时候一律走 today()/range()，让日报和限速用同一份事实。

import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { stateRoot, ensureDir } from './edge.mjs'
import { dayKey } from './soul.mjs'

export function usageDir() {
  const d = join(stateRoot(), 'usage')
  ensureDir(d)
  return d
}

export function fileFor(day) {
  return join(usageDir(), `usage-${day || dayKey()}.json`)
}

function empty(day) {
  return {
    day,
    // 动作计数：key = 动作名，value = 次数
    counts: {},
    // 明细：最多留 500 条，防文件无限长
    events: [],
    startedAt: Date.now(),
  }
}

export function load(day = dayKey()) {
  const f = fileFor(day)
  if (!existsSync(f)) return empty(day)
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (!j || j.day !== day) return empty(day)
    j.counts ||= {}
    j.events ||= []
    return j
  } catch {
    // 写坏了就换一份新的，但不动原文件（留给人工看）
    return empty(day)
  }
}

export function save(book) {
  const f = fileFor(book.day)
  const tmp = f + '.tmp'
  // 明细截断：只留最后 500 条
  if (book.events.length > 500) book.events = book.events.slice(-500)
  writeFileSync(tmp, JSON.stringify(book), 'utf8')
  renameSync(tmp, f)
  return book
}

/**
 * 记一笔。
 * @param {string} action 'dm.replied' | 'comment.posted' | 'feed.browsed' | 'video.shared' | 'voice.sent' ...
 * @param {object} meta 任意附加信息会被平铺进事件的 meta
 * @param {string} [day] 要记到哪一天，默认今天
 */
export function bump(action, meta = {}, day) {
  const d = day || dayKey()
  const b = load(d)
  b.counts[action] = (b.counts[action] || 0) + 1
  b.events.push({ at: Date.now(), action, meta })
  return save(b)
}

/** 只要计数，不写。 */
export function count(action, day) {
  return load(day || dayKey()).counts[action] || 0
}

/** 近 n 天的书，按日期升序。缺的那天给空。 */
export function range(days = 7, now = Date.now()) {
  const keys = []
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * 86400000))
  return keys.map((k) => load(k))
}
export function availableDays() {
  try {
    return readdirSync(usageDir())
      .map((f) => /^usage-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .sort()
  } catch { return [] }
}

export function totals(book) {
  return { ...book.counts }
}
