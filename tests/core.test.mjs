// soul / state / edge 的纯函数与落盘行为。
//
// 这些是「不碰浏览器就能测」的部分：人格卡、时间窗、分词、默认配置、原子写、
// 事件日志、互斥锁、状态根解析。凡是需要真 Edge 的一律不放进来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dya-core-'))
process.env.DOUYIN_ALL_HOME = dir

const soul = await import('../soul.mjs')
const state = await import('../state.mjs')
const edge = await import('../edge.mjs')

// ── 人格卡 ──────────────────────────────────────────────────────────────────

test('默认人格卡是中性的，不含任何具体账号或称呼', () => {
  const card = soul.DEFAULT_PERSONA.data
  const text = JSON.stringify(card)
  for (const bad of ['小鱼', '大肥鱼', '主人', '鲸', '蓝头发', '蓝毛']) {
    assert.equal(text.includes(bad), false, `默认卡不该出现「${bad}」`)
  }
  assert.equal(typeof card.name, 'string')
  assert.ok(card.name.length > 0)
})

test('personaName 在名称为空时回落', () => {
  assert.equal(soul.personaName({ data: { name: '阿甲' } }), '阿甲')
  assert.equal(soul.personaName({ data: { name: '' } }), soul.DEFAULT_PERSONA.data.name)
  assert.equal(soul.personaName(null, '兜底'), '兜底')
})

test('normalizePersona 补齐缺字段且不炸', () => {
  const p = soul.normalizePersona({ spec: 'chara_card_v2', data: { name: 'x' } })
  assert.ok(p && p.data)
  assert.equal(typeof p.data.name, 'string')
})

// ── 时间窗 ──────────────────────────────────────────────────────────────────

test('parseHHMM 只吃合法时间', () => {
  assert.equal(soul.parseHHMM('22:00'), 22 * 60)
  assert.equal(soul.parseHHMM('7:05'), 7 * 60 + 5)
  for (const bad of ['25:00', '2200', 'abcd', '', null, undefined, '12:60']) {
    assert.equal(soul.parseHHMM(bad), null, String(bad))
  }
})

test('活跃窗口：跨零点', () => {
  const q = { nightMuted: true, nightFrom: '22:00', nightTo: '08:00' }
  const at = (h) => new Date(2026, 0, 1, h, 30, 0)
  assert.equal(soul.activeWindow(q, at(22)).ok, false)
  assert.equal(soul.activeWindow(q, at(2)).ok, false)
  assert.equal(soul.activeWindow(q, at(7)).ok, false)
  assert.equal(soul.activeWindow(q, at(8)).ok, true)
  assert.equal(soul.activeWindow(q, at(21)).ok, true)
})

test('活跃窗口：同日区间', () => {
  const q = { nightMuted: true, nightFrom: '12:00', nightTo: '14:00' }
  const at = (h) => new Date(2026, 0, 1, h, 0, 0)
  assert.equal(soul.activeWindow(q, at(13)).ok, false)
  assert.equal(soul.activeWindow(q, at(15)).ok, true)
})

test('关闭免打扰后一律放行', () => {
  const q = { nightMuted: false, nightFrom: '22:00', nightTo: '08:00' }
  assert.equal(soul.activeWindow(q, new Date(2026, 0, 1, 3, 0, 0)).ok, true)
})

test('最小间隔：刚说过话要等', () => {
  const now = new Date(2026, 0, 1, 15, 0, 0)
  const q = {
    nightMuted: false, minGapMinutes: 30,
    __lastProactiveAt: now.getTime() - 5 * 60 * 1000,
  }
  const r = soul.activeWindow(q, now)
  assert.equal(r.ok, false)
  assert.match(r.why, /分钟/)
})

test('从没主动说过话不受间隔限制', () => {
  const now = new Date(2026, 0, 1, 15, 0, 0)
  const q = { nightMuted: false, minGapMinutes: 30, __lastProactiveAt: 0 }
  assert.equal(soul.activeWindow(q, now).ok, true)
})

test('tokenize 对中文切成二元组', () => {
  const t = soul.tokenize('蓝色鲸鱼')
  assert.ok(t.length > 0)
  assert.ok(t.every((x) => typeof x === 'string' && x.length > 0))
})

// ── 默认配置 ────────────────────────────────────────────────────────────────

test('默认配置里没有任何具体账号', () => {
  const d = state.DEFAULTS
  assert.equal(d.owner, '')
  assert.equal(d.peer, '')
  assert.equal(d.setup.step, 'login')
  assert.deepEqual(d.comments.skipNicks, [])
  assert.deepEqual(d.feed.like, [])
  assert.deepEqual(d.feed.dislike, [])
})

test('安全默认：刷流关、不回别人评论、严格模式开', () => {
  const d = state.DEFAULTS
  assert.equal(d.feed.enabled, false)
  assert.equal(d.comments.others, false)
  assert.equal(d.comments.strict, true)
  assert.equal(d.comments.allowOutsideLink, false)
})

test('默认限速值是保守的', () => {
  const d = state.DEFAULTS
  assert.ok(d.dm.maxPerHour > 0 && d.dm.maxPerHour <= 60)
  assert.ok(d.dm.maxPerDay > 0 && d.dm.maxPerDay <= 300)
  assert.ok(d.comments.perHour > 0 && d.comments.perHour <= 20)
})

test('mergeDefaults 深合并且保留用户值', () => {
  const m = state.mergeDefaults(state.DEFAULTS, { owner: '我', dm: { maxPerHour: 5 } })
  assert.equal(m.owner, '我')
  assert.equal(m.dm.maxPerHour, 5)
  assert.equal(m.dm.maxPerDay, state.DEFAULTS.dm.maxPerDay)  // 没覆盖的保持默认
})

// ── 落盘 ────────────────────────────────────────────────────────────────────

test('writeJson/readJsonSafe 往返', () => {
  const f = path.join(dir, 'x.json')
  state.writeJson(f, { a: 1, b: [1, 2] })
  assert.deepEqual(state.readJsonSafe(f, null), { a: 1, b: [1, 2] })
})

test('readJsonSafe 遇到坏文件回退', () => {
  const f = path.join(dir, 'bad.json')
  fs.writeFileSync(f, '{ not json')
  assert.equal(state.readJsonSafe(f, 'fallback'), 'fallback')
  assert.equal(state.readJsonSafe(path.join(dir, 'nope.json'), 7), 7)
})

test('连续快写不因 rename 竞争报 EPERM', () => {
  // 回归：writeJson 原来固定用 <file>.tmp，异步 GC 会在这个窗口里碰文件，
  // 导致 Windows 上偶发 EPERM: rename ...tmp -> ....
  const f = path.join(dir, 'hot.json')
  for (let i = 0; i < 40; i++) state.writeJson(f, { i })
  assert.equal(state.readJsonSafe(f, {}).i, 39)
})

test('saveConfig/loadConfig 往返', () => {
  state.saveConfig(state.mergeDefaults(state.DEFAULTS, { owner: '甲' }))
  assert.equal(state.loadConfig().owner, '甲')
})

test('state 读写与事件日志', () => {
  state.writeState('t.json', { v: 1 })
  assert.deepEqual(state.readState('t.json', null), { v: 1 })
  assert.deepEqual(state.readState('missing.json', { d: 1 }), { d: 1 })
  state.appendEvent({ kind: 'test', msg: 'hello' })
  const evs = state.readEvents({ limit: 5 })
  assert.ok(evs.some((e) => e.msg === 'hello'))
})

test('互斥锁：同进程重复抢会失败，释放后能再抢', () => {
  // acquireLock 返回 { ok, pid } / { ok:false, why }
  const name = 'lock-' + Math.random().toString(36).slice(2)
  assert.equal(state.acquireLock(name).ok, true)
  assert.equal(state.acquireLock(name).ok, false)
  state.releaseLock(name)
  assert.equal(state.acquireLock(name).ok, true)
  state.releaseLock(name)
})

test('runOnce 在锁被占时直接放弃', async () => {
  const name = 'once-' + Math.random().toString(36).slice(2)
  state.acquireLock(name)
  let ran = false
  const r = await state.runOnce(name, async () => { ran = true; return 1 })
  assert.equal(ran, false)
  assert.equal(r.skipped, true)
  assert.equal(r.ok, false)
  state.releaseLock(name)
})

test('runOnce 正常执行并释放锁', async () => {
  const name = 'once2-' + Math.random().toString(36).slice(2)
  const r = await state.runOnce(name, async () => 'ok')
  assert.equal(r.ok, true)
  assert.equal(r.result, 'ok')
  assert.equal(state.acquireLock(name).ok, true)
  state.releaseLock(name)
})

// ── 状态根 ──────────────────────────────────────────────────────────────────

test('stateRoot 跟随 DOUYIN_ALL_HOME', () => {
  assert.equal(edge.stateRoot(), dir)
})

test('setStateRoot 覆盖优先', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dya-root-'))
  edge.setStateRoot(other)
  assert.equal(edge.stateRoot(), other)
  edge.setStateRoot(dir)
  assert.equal(edge.stateRoot(), dir)
})

test('paths 都在状态根下', () => {
  for (const [k, v] of Object.entries(edge.paths)) {
    if (typeof v !== 'function') continue
    const p = v()
    assert.ok(String(p).startsWith(dir), `${k} 应落在状态根下，实际 ${p}`)
  }
})

test('ensureDir 幂等', () => {
  const p = path.join(dir, 'a', 'b', 'c')
  edge.ensureDir(p)
  edge.ensureDir(p)
  assert.ok(fs.existsSync(p))
})

test('Cdp 的连接失败给出可读报错', async () => {
  // 关闭的端口：connect 应该超时而不是挂死
  await assert.rejects(
    () => edge.cdpAlive(1, 500).then((ok) => { if (!ok) throw new Error('closed') }),
    /closed/,
  )
})

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
