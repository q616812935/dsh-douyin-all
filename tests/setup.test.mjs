/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// 首次开通向导的状态机测试。
//
// 这几条是整个「装到陌生机器上不会出事」的底线：
//  * 没走完向导 = 出站全锁（否则插件会替一个陌生人去私信真号）
//  * 登录了但一个会话都没有 ≠ 没登录（否则老用户被关在门外）
//  * 识别不出自己是谁时绝不猜（宁可让用户手填）
//  * 设置页清空输入框 = 回到默认（否则改 DEFAULTS 对老用户无效）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'dya-setup-'))
process.env.DOUYIN_ALL_HOME = DIR

const setup = await import('../setup.mjs')
const { DEFAULTS } = await import('../state.mjs')

test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* ignore */ } })

// ── step 规范化与锁 ─────────────────────────────────────────────────────────

test('不认识的 step 一律从 login 开始', () => {
  assert.equal(setup.normalizeStep(undefined), 'login')
  assert.equal(setup.normalizeStep(''), 'login')
  assert.equal(setup.normalizeStep('DONE'), 'login')
  assert.equal(setup.normalizeStep('bogus'), 'login')
  for (const s of setup.STEPS) assert.equal(setup.normalizeStep(s), s)
})

test('只有 done 才解锁出站', () => {
  assert.equal(setup.outboundLocked({ setup: { step: 'done' } }), false)
  for (const s of ['login', 'identify', 'peer']) {
    assert.equal(setup.outboundLocked({ setup: { step: s } }), true)
  }
  // 老配置里根本没有 setup 字段：装上就得先走向导
  assert.equal(setup.outboundLocked({}), true)
  assert.equal(setup.outboundLocked(undefined), true)
})

// ── 探测：四种局面 ──────────────────────────────────────────────────────────

/**
 * 假页面：一个满足 `evaluateAsync` 契约的 send 函数。
 *
 * probe 内部只用两条页面脚本：`.length`（等左栏）与 conversation-item 抽屉（读行）。
 * 这里按表达式里出现的特征分别回答，避免真的等满 15 秒超时。
 */
function fakePage({ rows = [], me = null } = {}) {
  const send = async (method, params) => {
    if (method !== 'Runtime.evaluate') throw new Error('fakePage 只实现 Runtime.evaluate，收到 ' + method)
    const expr = String(params?.expression || '')
    if (expr.includes("querySelectorAll('[data-e2e=\"conversation-item\"]').length")) {
      return { result: { value: rows.length } }
    }
    if (expr.includes('conversation-item')) {
      return {
        result: {
          value: rows.map((r) => ({
            text: String(r.text || `${r.nick} 刚刚 你好`),
            parts: [String(r.nick || ''), '刚刚', String(r.text || '你好')],
          })),
        },
      }
    }
    return { result: { value: null } }
  }
  return {
    fake: true,
    send,
    async evalJson(expr) { const r = await send('Runtime.evaluate', { expression: expr }); return r.result.value },
    __me: me,
  }
}

/** 直接喂给 probe 一个假的 onPage（不碰浏览器）。 */
function fakeOnPage({ rows = [], me = null } = {}) {
  return async (fn) => fn(fakePage({ rows, me }))
}

const baseCfg = (patch = {}) => ({ ...JSON.parse(JSON.stringify(DEFAULTS)), ...patch })

test('左栏空 + 外部判据说没登录 → login', async () => {
  const cfg = baseCfg()
  const r = await setup.probe({
    cfg,
    onPage: fakeOnPage({ rows: [] }),
    detect: async () => 'login',
    waitMs: 0,
    deep: false,   // 假页面上打不了真实接口，别让它等 whoAmI 超时
  })
  assert.equal(r.step, 'login')
  assert.equal(r.loggedIn, false)
  assert.equal(r.locked, true)
  assert.equal(r.can.login, true)
})

test('左栏空但外部判据说登录了（老用户零会话）→ 不误判成没登录', async () => {
  const cfg = baseCfg()
  const r = await setup.probe({
    cfg,
    onPage: fakeOnPage({ rows: [], me: { nick: '我自己' } }),
    detect: async () => 'ok',
    waitMs: 0,
    deep: false,   // 直接用 fakeOnPage 的 me，不去打真实接口
  })
  assert.equal(r.loggedIn, true)
  assert.notEqual(r.step, 'login')
})

test('有 owner 没 peer → peer 步，并且只在有会话时才允许挑', async () => {
  const cfg = baseCfg({ owner: '我自己', setup: { step: 'identify', at: 0 } })
  const empty = await setup.probe({ cfg, onPage: fakeOnPage({ rows: [] }), detect: async () => 'ok', waitMs: 0, deep: false })
  assert.equal(empty.step, 'peer')
  assert.equal(empty.can.peer, false)

  const withRows = await setup.probe({
    cfg,
    onPage: fakeOnPage({ rows: [{ nick: '对方', text: '对方 刚刚 你好' }] }),
    detect: async () => 'ok',
    waitMs: 0,
    deep: false,
  })
  assert.equal(withRows.step, 'peer')
  assert.equal(withRows.can.peer, true)
})

test('owner 与 peer 齐了且 peer 在左栏 → done 且解锁', async () => {
  const cfg = baseCfg({ owner: '我自己', peer: '对方', setup: { step: 'peer', at: 0 } })
  const r = await setup.probe({
    cfg,
    onPage: fakeOnPage({ rows: [{ nick: '对方', text: '对方 刚刚 你好' }] }),
    detect: async () => 'ok',
    waitMs: 0,
    deep: false,
  })
  assert.equal(r.step, 'done')
  assert.equal(r.locked, false)
  assert.equal(r.can.done, true)
})

test('peer 不在左栏 → 仍停 peer，但提示可能折叠了', async () => {
  const cfg = baseCfg({ owner: '我自己', peer: '改了名的', setup: { step: 'peer', at: 0 } })
  const r = await setup.probe({
    cfg,
    onPage: fakeOnPage({ rows: [{ nick: '别人', text: '别人 刚刚 嗨' }] }),
    detect: async () => 'ok',
    waitMs: 0,
    deep: false,
  })
  assert.equal(r.step, 'peer')
  assert.match(r.hint, /折叠/)
})

test('开页失败不抛，返回可直接展示的提示', async () => {
  const r = await setup.probe({
    cfg: baseCfg(),
    onPage: async () => { throw new Error('CDP 连不上') },
  })
  assert.equal(r.step, 'login')
  assert.match(r.hint, /CDP 连不上/)
})

// ── restoreDocumentedDefaults ───────────────────────────────────────────────

test('清空输入框 = 回到默认；引擎字段永不重置', () => {
  const cur = {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    port: 9999,
    home: 'D:/somewhere',
    owner: '我自己',
    persona: { name: '', preset: '', card: '' },
    feed: { ...DEFAULTS.feed, like: [], dislike: [] },
    comments: { ...DEFAULTS.comments, skipNicks: [] },
    dm: { ...DEFAULTS.dm, voicePreset: '' },
  }
  const out = setup.restoreDocumentedDefaults(cur, DEFAULTS)
  assert.equal(out.persona.name, DEFAULTS.persona.name)
  assert.equal(out.persona.preset, DEFAULTS.persona.preset)
  assert.deepEqual(out.feed.like, DEFAULTS.feed.like)
  assert.deepEqual(out.feed.dislike, DEFAULTS.feed.dislike)
  assert.deepEqual(out.comments.skipNicks, DEFAULTS.comments.skipNicks)
  assert.equal(out.dm.voicePreset, DEFAULTS.dm.voicePreset)
  // 引擎字段与用户自己填的内容不许被动
  assert.equal(out.port, 9999)
  assert.equal(out.home, 'D:/somewhere')
  assert.equal(out.owner, '我自己')
})

test('custom 人格卡不会被清空逻辑顶掉', () => {
  const cur = {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    persona: { name: '我自己起的', preset: 'custom', card: '你是…' },
  }
  const out = setup.restoreDocumentedDefaults(cur, DEFAULTS)
  assert.equal(out.persona.name, '我自己起的')
  assert.equal(out.persona.preset, 'custom')
  assert.equal(out.persona.card, '你是…')
})
