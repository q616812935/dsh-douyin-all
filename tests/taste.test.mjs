// 口味画像单元测试：Soul 落盘到临时目录，验证学习/衰减/清理/打分。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Soul } from '../soul.mjs'
import { score, pick } from '../feed.mjs'

function freshSoul() {
  const dir = mkdtempSync(join(tmpdir(), 'dya-soul-'))
  // Soul 的参数名是 { root }（不是 dir）。写错会静默落到真实的 stateRoot()，
  // 把测试数据写进用户自己的 soul 目录——这里断言一下。
  const s = new Soul({ root: dir })
  return { s, dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('测试绝不能碰真实 soul 目录', () => {
  const { s, dir, done } = freshSoul()
  try {
    assert.ok(s.interestsFile.startsWith(dir), `interests 应落在临时目录，实际 ${s.interestsFile}`)
  } finally { done() }
})

test('喜欢一个标签会让它的分值上升', () => {
  const { s, dir, done } = freshSoul()
  try {
    s.learn({ tags: ['手工'], verdict: 'like', strength: 2, item: { desc: '做了一只毛毡猫' } })
    s.learn({ tags: ['手工'], verdict: 'like', strength: 2, item: { desc: '编了个手绳' } })
    const it = s.getInterests()
    const hit = it.likes.find((x) => x.tag === '手工')
    assert.ok(hit, '手工 应当出现在 likes 里')
    assert.ok(hit.score > 3, `两次 strength=2 后分数应 >3，实际 ${hit?.score}`)
    assert.equal(it.watched.length, 2)
    assert.ok(s.tastePrompt().includes('手工'))
  } finally { done() }
})

test('不喜欢会把喜欢压下去（观念会变）', () => {
  const { s, done } = freshSoul()
  try {
    s.learn({ tags: ['带货'], verdict: 'like', strength: 3 })
    const before = s.tasteScore(['带货'])
    s.learn({ tags: ['带货'], verdict: 'dislike', strength: 3 })
    const after = s.tasteScore(['带货'])
    assert.ok(after < before, `转黑之后分数应下降（${before} → ${after}）`)
  } finally { done() }
})

test('口味会随观测次数缓慢衰减', () => {
  const { s, done } = freshSoul()
  try {
    s.learn({ tags: ['猫'], verdict: 'like', strength: 3 })
    const first = s.getInterests().likes[0].score
    for (let i = 0; i < 40; i++) s.learn({ tags: ['别的'], verdict: 'neutral' })
    const later = s.getInterests().likes.find((x) => x.tag === '猫')
    if (later) assert.ok(later.score < first, `衰减后应更低（${first} → ${later.score}）`)
  } finally { done() }
})

test('分值过低的老标签会被清掉，画像不会无限长', () => {
  const { s, done } = freshSoul()
  try {
    s.learn({ tags: ['冷门'], verdict: 'like', strength: 0.2 })
    for (let i = 0; i < 120; i++) s.learn({ tags: ['热'], verdict: 'like', strength: 1 })
    const it = s.getInterests()
    assert.ok(!it.likes.some((x) => x.tag === '冷门'), '冷门 应已被清理')
    assert.ok(it.watched.length <= 12, '设置页只回最近 12 条')
  } finally { done() }
})

test('笔记可以写、可以清空', () => {
  const { s, done } = freshSoul()
  try {
    s.learn({ tags: ['猫'], verdict: 'like', strength: 2 })
    assert.ok(s.setTasteNote('最近就想看手工和猫').includes('手工'))
    assert.ok(s.tastePrompt().includes('说起自己口味'))
    s.setTasteNote('')
    assert.ok(!s.tastePrompt().includes('说起自己口味'))
  } finally { done() }
})

test('口味会真的影响挑视频', () => {
  const { s, done } = freshSoul()
  try {
    s.learn({ tags: ['手工'], verdict: 'like', strength: 3 })
    const items = [
      { aweme_id: 'a', desc: '今天做手工毛毡，做了一下午', statistics: { digg: 10 } },
      { aweme_id: 'b', desc: '随便拍的路边风景', statistics: { digg: 10 } },
    ]
    const tags = s.getInterests().likes.map((x) => x.tag)
    const picked = pick(items, { tasteTags: tags, tasteScore: (h) => s.tasteScore(h), limit: 1 })
    assert.equal(picked[0]?.aweme_id, 'a', '应当挑中带「手工」的那条')
  } finally { done() }
})

test('自己的作品不会被挑出来分享', () => {
  const items = [
    { aweme_id: 'mine', desc: '今天做手工毛毡超开心', isMine: true, statistics: { digg: 99999 } },
    { aweme_id: 'other', desc: '今天做手工毛毡超开心', statistics: { digg: 1 } },
  ]
  const picked = pick(items, { limit: 3 })
  assert.deepEqual(picked.map((x) => x.aweme_id), ['other'])
})

test('dislike 关键词能压掉一条候选', () => {
  const items = [{ aweme_id: 'x', desc: '游戏直播开箱带货超值', statistics: { digg: 50000 } }]
  assert.ok(score(items[0], { dislike: ['带货', '游戏直播'] }) < 0)
  assert.equal(pick(items, { dislike: ['带货', '游戏直播'] }).length, 0)
})
