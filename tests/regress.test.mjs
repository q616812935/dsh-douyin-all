// 线上真实翻车过的 bug 的回归测试。
//
// 这一组测试每一条都对应一个**已经发到线上、被用户看见**的故障，
// 注释里写清了当时的现象。以后谁想改这部分逻辑，先看现象再动代码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dya-regress-'))
process.env.DOUYIN_ALL_HOME = dir

const brain = await import('../brain.mjs')
const state = await import('../state.mjs')
const comments = await import('../comments.mjs')
const beam = await import('../comments.mjs')

// ── 分享文案被切成半句 ──────────────────────────────────────────────────────
// 现象：私信里收到「…那个视频最后那下，我心里堵得慌。你说，你会不会也那」，
// 用户看到的是半句话。

test('超长文案按句号收口，不会切出半句', () => {
  const src = '主人，221秒我居然看完了……那个视频最后那下，我心里堵得慌。你说，你会不会也那个样子'
  const out = brain.cleanReply(src, 40)
  assert.ok(out.length <= 40, `不该超长：${out.length}`)
  assert.ok(/[。！？～]$/.test(out), `应停在句读上，实际结尾是「${out.slice(-3)}」`)
  assert.equal(out, '主人，221秒我居然看完了……那个视频最后那下，我心里堵得慌。')
})

test('没超长的文案原样返回，不会被加省略号', () => {
  const src = '诶你看这个，agent还分贵的便宜的，跟你似的干活挑模型'
  assert.equal(brain.cleanReply(src, 40), src)
})

test('一句读完还是超长时退回逗号，实在没有标点才补省略号', () => {
  const long = '一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十'
  const out = brain.cleanReply(long, 14)
  assert.ok(out.length <= 14)
  assert.ok(/[，…]$/.test(out), `实际：${out}`)

  const noPunct = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
  const out2 = brain.cleanReply(noPunct, 10)
  assert.equal(out2.length, 10)
  assert.ok(out2.endsWith('…'))
})

// ── 判「这条评论是不是我发的」 ──────────────────────────────────────────────
// 现象：自己在别人视频下发的评论，comment/list 回来时 is_author 不是 1、uid 还常缺，
// 于是被当成「别人的评论」反复去回。

test('isMineComment 优先按昵称判，不迷信 is_author', () => {
  const mine = { is_author: 0, user: { nickname: '蓝毛小女仆' }, text: '随便说说' }
  assert.equal(comments.isMineComment(mine, '蓝毛小女仆'), true)
  assert.equal(comments.isMineComment(mine, '别人'), false)
})

test('isMineComment 拿不到昵称时才退回 is_author', () => {
  assert.equal(comments.isMineComment({ is_author: 1 }, ''), true)
  assert.equal(comments.isMineComment({ is_author: 0 }, ''), false)
})

test('isMineComment 对空值不抛异常', () => {
  assert.equal(comments.isMineComment(null, 'x'), false)
  assert.equal(comments.isMineComment(undefined, ''), false)
})

// ── @ 人：text_extra 的形状 ─────────────────────────────────────────────────
// 现象：带了 to_user_id / sec_uid 就 HTTP 200 空 body，整条评论作废。

test('buildAt 只生成 start/end/user_id/type，并算出正确的 end', () => {
  const at = comments.buildAt('@爱睡觉的kevin 这个我也刷到了', { nick: '爱睡觉的kevin', uid: '74978548871' })
  assert.equal(at.extra.length, 1)
  const e = at.extra[0]
  assert.equal(e.start, 0)
  assert.equal(e.end, 10, '@ + 6 个汉字 = 7？不，这里按昵称长度算')
  assert.equal(e.user_id, '74978548871')
  assert.equal(e.type, 0)
  assert.equal('to_user_id' in e, false)
  assert.equal('sec_uid' in e, false)
})

test('buildAt 拿不到 uid 时退化成纯文本 @，不瞎编 user_id', () => {
  const at = comments.buildAt('@某人 你好', '某人')
  assert.equal(at.extra.length, 0)
  assert.equal(at.at.textOnly, true)
  assert.equal(at.at.nick, '某人')
})

// ── 事件日志要能看出「为什么没发」 ──────────────────────────────────────────
// 现象：线上 events.jsonl 里 round.result.parts.feed 只剩一个 {…}，
// 排查时完全不知道 feed 为什么没出站。

test('summarize 在任意深度保留诊断字段', () => {
  const r = state.summarize({
    ok: false,
    parts: {
      feed: {
        ok: true,
        picked: null,
        acted: 0,
        why: '距离上次主动开口才 28 分钟',
        share: { ok: false, why: 'too soon' },
        mention: { ok: false, code: 'not-visited' },
        comment: { ok: false, why: 'x'.repeat(900) },
      },
    },
  })
  assert.equal(r.parts.feed.why, '距离上次主动开口才 28 分钟')
  assert.equal(r.parts.feed.share.why, 'too soon')
  assert.equal(r.parts.feed.mention.code, 'not-visited')
  assert.ok(r.parts.feed.comment.why.length <= 300, '诊断字段只该截长度，不该整段丢')
})

test('summarize 不会因为某个分支超长就把别的分支也折掉', () => {
  const r = state.summarize({
    parts: {
      a: { ok: false, why: 'w'.repeat(500) },
      b: { ok: false, why: '还在跑' },
    },
  })
  assert.equal(r.parts.b.why, '还在跑')
})

// ── 默认值 ──────────────────────────────────────────────────────────────────
// 现象：workMaxAgeDays 默认 7，自己 5 个作品全被判「太旧，跳过」，
// 「回自己作品下的评论」这条链彻底空转。

test('默认值不按作品发布时间卡评论', () => {
  assert.equal(state.DEFAULTS.comments.workMaxAgeDays, 0)
})

test('主动动作的最小间隔与私信间隔分开，默认 12 分钟', () => {
  assert.equal(state.DEFAULTS.feed.proactiveGapMinutes, 12)
  assert.equal(state.DEFAULTS.feed.browsesPerRound, 3)
})
