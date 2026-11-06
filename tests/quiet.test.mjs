// dsh-douyin-all 单元测试：只测纯逻辑（时间窗、口味画像、打分），不碰浏览器。
// 跑法：node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activeWindow, parseHHMM } from '../soul.mjs'

const at = (h, m = 0) => new Date(2026, 10, 5, h, m, 0)

test('parseHHMM 接受合法时间，拒绝非法', () => {
  assert.equal(parseHHMM('22:00'), 1320)
  assert.equal(parseHHMM('08:30'), 510)
  assert.equal(parseHHMM('8:05'), 485)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('22:60'), null)
  assert.equal(parseHHMM('2200'), null)
  assert.equal(parseHHMM(''), null)
  assert.equal(parseHHMM(undefined), null)
})

test('免打扰时段：22:00–08:00 跨零点', () => {
  const q = { nightMuted: true, nightFrom: '22:00', nightTo: '08:00', minGapMinutes: 0 }
  // 夜间：应当安静
  for (const h of [22, 23, 0, 3, 7]) {
    const r = activeWindow(q, at(h, 30))
    assert.equal(r.ok, false, `${h}:30 应当处于免打扰`)
  }
  assert.equal(activeWindow(q, at(21, 59)).ok, true)
  assert.equal(activeWindow(q, at(8, 0)).ok, true)
})

test('免打扰时段：白天时段（不跨零点）', () => {
  const q = { nightMuted: true, nightFrom: '12:00', nightTo: '14:00', minGapMinutes: 0 }
  assert.equal(activeWindow(q, at(13, 0)).ok, false)
  assert.equal(activeWindow(q, at(11, 59)).ok, true)
  assert.equal(activeWindow(q, at(14, 0)).ok, true)
})

test('免打扰可关闭', () => {
  const q = { nightMuted: false, nightFrom: '22:00', nightTo: '08:00', minGapMinutes: 0 }
  assert.equal(activeWindow(q, at(23, 0)).ok, true)
})

test('最小间隔：刚说过话就不再开口', () => {
  const now = at(15, 0)
  const q = { nightMuted: false, minGapMinutes: 30, __lastProactiveAt: now.getTime() - 5 * 60000 }
  const r = activeWindow(q, now)
  assert.equal(r.ok, false)
  assert.match(r.why, /还要等 25 分钟/)

  const okQ = { ...q, __lastProactiveAt: now.getTime() - 31 * 60000 }
  assert.equal(activeWindow(okQ, now).ok, true)
})

test('从没主动说过话时不受间隔限制', () => {
  const q = { nightMuted: false, minGapMinutes: 60, __lastProactiveAt: 0 }
  assert.equal(activeWindow(q, at(15, 0)).ok, true)
})

test('空配置默认走 22:00–08:00', () => {
  assert.equal(activeWindow({}, at(23, 0)).ok, false)
  assert.equal(activeWindow({}, at(12, 0)).ok, true)
})
