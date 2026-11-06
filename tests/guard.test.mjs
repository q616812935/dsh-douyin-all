// 出站闸门：把守卫的每条规则都钉住。
//
// 这些用例原来是手跑的脚本，没进套件。教训来源：new Guard({ file }) 漏了 () 导致
// 台账文件名为空、appendFileSync('') 静默失败，去重全失效，同一条评论回了 4 次。
// 所以第一个用例必须验证台账真的落盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Guard, DEFAULT_POLICY, norm } from '../guard.mjs'

/** 每个用例一份独立的台账目录，互不干扰。 */
function mkGuard(policy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dya-guard-'))
  const file = path.join(dir, 'ledger.jsonl')
  const g = new Guard({ file, policy: { ...DEFAULT_POLICY, minGapMs: 0, ...policy } })
  return { g, file, dir }
}

/** 走完一次完整的出站：判闸 → 占位 → 确认。额度只认 confirmed，所以必须 confirm。 */
function send(g, { awemeId = 'aw1', target, text, state = 'confirmed' }) {
  const chk = g.checkComment({ awemeId, target, text })
  if (!chk.ok) return chk
  if (state === 'confirmed') g.confirm(chk.row, { cid: 'cid-' + target })
  return chk
}

test('台账真的写到了磁盘上（漏() 那个 bug 的回归）', () => {
  const { g, file } = mkGuard()
  send(g, { target: 't1', text: '哈哈哈这个我也刷到过' })
  assert.ok(fs.existsSync(file), '台账文件必须存在')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).target, 't1')
})

test('目标级去重：同一条评论不会回第二次', () => {
  const { g } = mkGuard()
  assert.equal(send(g, { target: 't1', text: '哈哈哈' }).ok, true)
  const again = send(g, { target: 't1', text: '换个说法也没用' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'duplicate_target')
})

test('去重只看目标，不看正文（换个说法绕不过去）', () => {
  const { g } = mkGuard()
  g.confirm(g.checkComment({ awemeId: 'aw1', target: 't1', text: '原话一' }).row, { cid: 'c1' })
  const r = send(g, { target: 't1', text: '完全不同的一句话' })
  assert.equal(r.code, 'duplicate_target')
})

test('pending 行只挡并发重入，不永久占死目标', () => {
  const { g } = mkGuard()
  const first = g.checkComment({ awemeId: 'aw1', target: 't1', text: 'hi' })
  assert.equal(first.ok, true)
  const reentry = g.checkComment({ awemeId: 'aw1', target: 't1', text: 'hi' })
  assert.equal(reentry.code, 'in_flight')
  // 同一个调用方二次校验自己刚占的位，不该被自己的 pending 挡住
  const self = g.checkComment({ awemeId: 'aw1', target: 't1', text: 'hi', skipPending: true })
  assert.equal(self.ok, true)
})

test('pending 过期（220 秒）后不再挡', () => {
  // pendingForTarget 用真实的 Date.now()，不接受注入时间，
  // 所以只能把台账里的 at 往前挪来模拟「占位是很久以前的事」。
  const { g, file } = mkGuard()
  const chk = g.checkComment({ awemeId: 'aw1', target: 't1', text: 'hi' })
  assert.equal(chk.ok, true)
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't1', text: 'hi' }).code, 'in_flight')
  const old = Date.now() - 221 * 1000
  fs.writeFileSync(file, JSON.stringify({ ...chk.row, at: old }) + '\n')
  // Ledger 有 loaded 缓存且 append 会写内存 rows，必须新建一个 Guard 才会重读文件
  const g2 = new Guard({ file, policy: { ...DEFAULT_POLICY, minGapMs: 0 } })
  const later = g2.checkComment({ awemeId: 'aw1', target: 't1', text: 'hi' })
  assert.notEqual(later.code, 'in_flight')
})

test('同一作品同一句话不重复', () => {
  const { g } = mkGuard()
  send(g, { awemeId: 'aw1', target: 't1', text: '这句一模一样' })
  const r = send(g, { awemeId: 'aw1', target: 't2', text: '这句一模一样' })
  assert.equal(r.code, 'duplicate_text')
})

test('失败的行不参与正文判重', () => {
  const { g } = mkGuard()
  const chk = g.checkComment({ awemeId: 'aw1', target: 't1', text: '草稿' })
  g.markFailed(chk.row, '网络断了')
  const r = send(g, { awemeId: 'aw1', target: 't2', text: '草稿' })
  assert.equal(r.ok, true)
})

test('字数上限', () => {
  const { g } = mkGuard({ maxChars: 10 })
  const r = g.checkComment({ awemeId: 'aw1', target: 't1', text: '一'.repeat(11) })
  assert.equal(r.code, 'too_long')
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't2', text: '一'.repeat(10) }).ok, true)
})

test('站外链接默认拦', () => {
  const { g } = mkGuard()
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't1', text: '看 https://x.com' }).code, 'outbound')
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't2', text: '看 www.x.com' }).code, 'outbound')
})

test('允许站外链接后放行，但引导加微信仍然拦', () => {
  const { g } = mkGuard({ allowOutsideLink: true })
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't1', text: '看 https://x.com' }).ok, true)
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't2', text: '微信：abc12345' }).code, 'outbound')
})

test('广告与金钱类一律拦', () => {
  const { g } = mkGuard()
  for (const t of ['加我微信聊', '兼职刷单日赚300', '扫码付款']) {
    assert.equal(g.checkComment({ awemeId: 'aw1', target: 'x' + t, text: t }).code, 'outbound', t)
  }
})

test('禁止词可配', () => {
  const { g } = mkGuard({ bannedWords: ['广告'] })
  const r = g.checkComment({ awemeId: 'aw1', target: 't1', text: '这是广告' })
  assert.equal(r.code, 'banned_word')
  assert.match(r.why, /广告/)
})

test('严格模式默认开：客服腔被拦', () => {
  const { g } = mkGuard()
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't1', text: '亲，感谢您的支持！' }).code, 'robot_tone')
})

test('严格模式关掉后客服腔放行', () => {
  const { g } = mkGuard({ strict: false })
  assert.equal(g.checkComment({ awemeId: 'aw1', target: 't1', text: '亲，感谢您的支持！' }).ok, true)
})

test('正常人话永远放行', () => {
  const { g } = mkGuard()
  for (const t of ['哈哈哈这个我也刷到过', '我家猫也这样', '这个bgm叫什么呀']) {
    assert.equal(g.checkComment({ awemeId: 'aw1', target: 'x' + t, text: t }).ok, true, t)
  }
})

test('每小时额度只算真正发出去的', () => {
  const { g } = mkGuard({ perHour: 2 })
  send(g, { target: 't1', text: 'a' })
  send(g, { target: 't2', text: 'b' })
  const third = send(g, { target: 't3', text: 'c' })
  assert.equal(third.code, 'quota_hour')
})

test('pending 占位也算进额度（宁可少发，不可多发）', () => {
  // countSince 不区分 pending/confirmed：占位那一刻就记一次。
  // 这是有意的保守选择 —— 进程在发送中途挂掉时，那条也算「可能已经发了」。
  const { g } = mkGuard({ perHour: 1 })
  const chk = g.checkComment({ awemeId: 'aw1', target: 'p1', text: 'x' })
  assert.equal(chk.ok, true)
  assert.equal(g.usage().comment.hour, 1)
  assert.equal(send(g, { target: 'p2', text: 'y' }).code, 'quota_hour')
})

test('每天额度', () => {
  const { g } = mkGuard({ perDay: 2, perHour: 100 })
  send(g, { target: 't1', text: 'a' })
  send(g, { target: 't2', text: 'b' })
  assert.equal(send(g, { target: 't3', text: 'c' }).code, 'quota_day')
})

test('最小间隔', () => {
  const { g } = mkGuard({ minGapMs: 30000 })
  send(g, { target: 't1', text: 'a' })
  const r = send(g, { target: 't2', text: 'b' })
  assert.equal(r.code, 'too_soon')
})

test('私信额度按 policy 生效', () => {
  const { g } = mkGuard({ dmPerHour: 2, dmPerDay: 10 })
  const one = (to) => {
    const chk = g.checkDm({ text: 'hi', to })
    if (chk.ok) g.confirm(g.reserve('dm', { to, text: 'hi' }), { cid: 'c' + to })
    return chk
  }
  assert.equal(one('p1').ok, true)
  assert.equal(one('p2').ok, true)
  assert.equal(one('p3').code, 'quota_hour')
})

test('私信空正文被拦', () => {
  const { g } = mkGuard()
  assert.equal(g.checkDm({ text: '   ', to: 'p1' }).code, 'empty')
})

test('setPolicy 能热更新额度', () => {
  const { g } = mkGuard({ perHour: 10 })
  g.setPolicy({ ...DEFAULT_POLICY, perHour: 1, minGapMs: 0 })
  send(g, { target: 't1', text: 'a' })
  assert.equal(send(g, { target: 't2', text: 'b' }).code, 'quota_hour')
})

test('usage 汇总当天的出站', () => {
  const { g } = mkGuard()
  send(g, { target: 't1', text: 'a' })
  send(g, { target: 't2', text: 'b' })
  const u = g.usage()
  assert.equal(u.comment.total, 2)
  assert.equal(u.comment.hour, 2)
})

test('norm 抹平空白', () => {
  assert.equal(norm('  a \n b  '), 'a b')
  assert.equal(norm(null), '')
})
