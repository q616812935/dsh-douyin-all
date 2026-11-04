// 生成 DSH 插件市场「格式 1」索引（dsh-plugin-market-index 校验器规则）
// 用法：node _mkindex.mjs            → 写到 _dev/market-index.json 并自检
//       node _mkindex.mjs --write    → 额外写回 ../README.md 的市场条目片段
import { readFileSync, writeFileSync, mkdirSync, existsSync as existsSyncE } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = HERE
const OUT_DIR = join(HERE, '_dev')

// 包清单优先取 plugin/package.json（Git 源安装的根目录），否则取仓库根 package.json
const PKG_PATH = existsSyncE(join(ROOT, 'plugin', 'package.json')) ? join(ROOT, 'plugin', 'package.json') : join(ROOT, 'package.json')
const PLUGIN_DIR = PKG_PATH === join(ROOT, 'plugin', 'package.json') ? join(ROOT, 'plugin') : ROOT
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
const iconB64 = readFileSync(join(PLUGIN_DIR, 'icon.svg')).toString('base64')

// 版本来源：source = npm（默认）或 git（把 plugin/ 源码推到仓库，索引指到某个提交）
//   DSH_SRC_TYPE=git DSH_SRC_COMMIT=<40 位 sha> DSH_SRC_PATH=plugin node make-index.mjs
const SRC_TYPE = (process.env.DSH_SRC_TYPE || 'npm').trim()
const SRC_COMMIT = (process.env.DSH_SRC_COMMIT || '').trim()
const SRC_PATH = (process.env.DSH_SRC_PATH || 'plugin').trim()

const ICON = `data:image/svg+xml;base64,${iconB64}`

// 真实地址：环境变量优先，其次 repo.json（{ "github": "owner/repo" }），都没有才用占位
import { existsSync } from 'node:fs'
let GH = process.env.DSH_GH || ''
if (!GH) {
  try {
    GH = JSON.parse(readFileSync(join(ROOT, 'repo.json'), 'utf8')).github || ''
  } catch {}
}
const REPO_HOME = GH ? `https://github.com/${GH}` : 'https://github.com/example/dsh-douyin-all'

// 索引里每个版本的 source：npm 还是 git（git 需要 40 位提交哈希）
const VERSION_SOURCE = (() => {
  if (SRC_TYPE !== 'git') return { type: 'npm' }
  if (!/^[0-9a-f]{40}$/u.test(SRC_COMMIT)) {
    console.error(JSON.stringify({ ok: false, error: 'DSH_SRC_TYPE=git 时必须给 DSH_SRC_COMMIT=<40 位 sha>' }))
    process.exit(1)
  }
  return { type: 'git', url: `https://github.com/${GH || 'example/dsh-douyin-all'}.git`, commit: SRC_COMMIT, path: SRC_PATH }
})()

const SUMMARY_ZH = '大肥鱼抖音助手：把私信自动回复、作品评论自动回复、刷推荐流挑视频转发、人格与长期记忆、语音回复、观看日报合并成一个 DSH 插件，全部走同一个 Edge 浏览器会话。'
const SUMMARY_EN = 'Douyin (TikTok China) companion for DeepSeek Harness: auto-reply to DMs, auto-reply to comments on your own and others\' works, browse the For-You feed and share picks, persona + long-term memory, TTS voice replies and daily viewing reports — all through one shared Edge session.'

const FEATURES_ZH = [
  '私信自动回复：读取左栏未读，模型生成回复，回车发送，发送后在会话列表逐字确认。',
  '作品评论自动回复：自己的作品默认开，别人作品可单独开；支持楼中楼（reply_id）。',
  '刷推荐流：按兴趣打分挑视频，可自动转发给指定好友（默认发描述 + 链接，送达可验证）。',
  '人格与长期记忆：兼容 chara_card_v2 人格卡，记忆去重/加权/上限淘汰，中文召回。',
  '语音回复：msedge-tts + ffmpeg，10 套音色预设。',
  '观看日报：按天统计浏览/挑片/私信/评论，晚上生成一段叙述。',
  '出站闸门：长度上限、禁止词、站外链接、目标级强去重（同一目标 7 天不回第二次）、每小时/每天配额。',
  '单一浏览器：一套 Edge + CDP 复用，空页面自动补页，残留页自动回收。'
]
const FEATURES_EN = [
  'DM auto-reply: reads unread conversations, generates a reply with the host model, presses Enter, then verifies delivery in the conversation list.',
  'Comment auto-reply: on by default for your own works, opt-in for other creators\' works, with thread replies (reply_id).',
  'Feed browsing: scores the For-You feed by interest and can share a pick to a friend (description + link, delivery verifiable).',
  'Persona and long-term memory: chara_card_v2 personas, deduplicated and weighted memories with a cap, Chinese-friendly recall.',
  'Voice replies via msedge-tts + ffmpeg with 10 voice presets.',
  'Daily viewing report: per-day browsing/picking/DM/comment counters with a narrative summary.',
  'Outbound guard: length cap, banned words, outbound links, strong per-target dedupe (one reply per target per 7 days), hourly/daily quotas.',
  'One browser only: a single Edge session over CDP, auto page healing and stale page recycling.'
]

const index = {
  format: 1,
  title: { en: 'DeepSeek Harness Plugin Index', zh: 'DeepSeek Harness 插件索引' },
  description: { en: 'A community-maintained index of DeepSeek Harness plugins.', zh: '社区维护的 DeepSeek Harness 插件索引。' },
  metadata: {
    categories: { automation: { title: { en: 'Automation', zh: '自动化' } } },
    labels: {
      'douyin': { title: { en: 'Douyin', zh: '抖音' } },
      'social': { title: { en: 'Social', zh: '社交' } },
      'chat': { title: { en: 'Chat', zh: '聊天' } },
      'self-hosted': { title: { en: 'Self-hosted', zh: '自托管' } }
    },
    sortKeys: {
      stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' }
    }
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Douyin Companion (Big Fatty Fish)', zh: '大肥鱼抖音助手' },
      description: { en: SUMMARY_EN, zh: SUMMARY_ZH },
      icon: ICON,
      author: pkg.author || 'dsh-douyin-all authors',
      homepage: REPO_HOME,
      repository: { url: REPO_HOME },
      metadata: {
        category: 'automation',
        keywords: ['douyin', '抖音', 'automation', 'dm', 'comment', 'memory', 'tts', 'persona', 'report'],
        labels: ['douyin', 'social', 'chat', 'self-hosted'],
        sortKeys: { stars: 0 }
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: VERSION_SOURCE,
          engines: { dsh: pkg.peerDependencies?.['@deepseek-ai/dsh'] || '>=0.2.1-rc.2 <0.3.0-0' }
        }
      ]
    }
  ]
}

// —— 自检（复刻 dsh-plugin-market-index 的关键规则）——
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u
const PKG = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const problems = []
const need = (ok, msg) => { if (!ok) problems.push(msg) }
const isLocalized = (v) => typeof v === 'string' ? v.trim() !== '' : (v && typeof v === 'object' && Object.hasOwn(v, 'en') && Object.values(v).every((s) => typeof s === 'string' && s.trim() !== ''))

need(index.format === 1, '$.format 必须为 1')
for (const [id, d] of Object.entries(index.metadata.categories)) need(id !== '' && isLocalized(d.title), `categories.${id}`)
for (const [id, d] of Object.entries(index.metadata.labels)) need(id !== '' && isLocalized(d.title), `labels.${id}`)
for (const [id, d] of Object.entries(index.metadata.sortKeys)) need(id !== '' && isLocalized(d.title) && ['asc', 'desc'].includes(d.order), `sortKeys.${id}`)

for (const p of index.plugins) {
  need(PKG.test(p.name) && p.name.length <= 214, `name ${p.name}`)
  need(isLocalized(p.title), `title ${p.name}`)
  need(isLocalized(p.description), `description ${p.name}`)
  need(typeof p.author === 'string', `author ${p.name}`)
  if (p.icon && !p.icon.startsWith('data:')) need(/^https:/.test(p.icon), `icon ${p.name} 必须 https 或 data:`)
  if (p.icon?.startsWith('data:')) {
    const m = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(p.icon)
    need(!!m, `icon data URL 格式`)
    if (m) {
      const pad = m[1].endsWith('==') ? 2 : m[1].endsWith('=') ? 1 : 0
      const bytes = m[1].length / 4 * 3 - pad
      need(bytes <= 32768, `icon 解码后 ${bytes} 字节，超过 32 KiB`)
    }
  }
  const md = p.metadata || {}
  if (md.category) need(Object.hasOwn(index.metadata.categories, md.category), `category ${md.category} 未声明`)
  need((md.keywords || []).every((k) => typeof k === 'string'), `keywords 必须全是字符串`)
  need(new Set(md.labels || []).size === (md.labels || []).length, `labels 不得重复`)
  for (const l of md.labels || []) need(Object.hasOwn(index.metadata.labels, l), `label ${l} 未声明`)
  for (const [k, v] of Object.entries(md.sortKeys || {})) {
    need(Object.hasOwn(index.metadata.sortKeys, k), `sortKey ${k} 未声明`)
    need(typeof v === 'number' && Number.isFinite(v), `sortKey ${k} 必须是有限数字`)
  }
  need(Array.isArray(p.versions) && p.versions.length > 0, `versions 非空`)
  const seen = new Set()
  for (const v of p.versions) {
    need(SEMVER.test(v.version), `version ${v.version}`)
    need(!seen.has(v.version), `version 重复 ${v.version}`); seen.add(v.version)
    need(Number.isInteger(v.publishTimestamp) && v.publishTimestamp >= 0 && v.publishTimestamp < 1e11, `publishTimestamp ${v.publishTimestamp}`)
    const s = v.source || {}
    if (s.type === 'npm') {
      if (s.registry !== undefined) need(/^https?:\/\//.test(s.registry) && !s.registry.includes('?') && !s.registry.includes('#'), `registry ${s.registry}`)
    } else if (s.type === 'git') {
      need(/^https:\/\//.test(s.url) && !/\.(tgz|tar\.gz)$/iu.test(s.url), `git url ${s.url}`)
      need(/^[0-9a-f]{40}$/u.test(s.commit || ''), `git commit`)
    } else need(`source.type 必须 npm 或 git`)
    const range = v.engines?.dsh
    if (range !== undefined) need(typeof range === 'string' && !range.startsWith('workspace:') && /[0-9]/.test(range), `engines.dsh ${range}`)
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const out = join(OUT_DIR, 'market-index.json')
const text = JSON.stringify(index, null, 2)
writeFileSync(out, text, 'utf8')
const sha = createHash('sha256').update(text).digest('hex')

const lines = []
lines.push(`# 市场条目（直接用于 DSH 插件市场索引）`, '')
lines.push(`- 包名：\`${pkg.name}\`　版本：\`${pkg.version}\`　许可：UNLICENSED（专有）`, '')
lines.push('## 简介', '')
lines.push(SUMMARY_ZH, '', SUMMARY_EN, '')
lines.push('## 特色功能', '')
for (const f of FEATURES_ZH) lines.push(`- ${f}`)
lines.push('', '## Highlights (EN)', '')
for (const f of FEATURES_EN) lines.push(`- ${f}`)
lines.push('', '## 索引片段', '', '```json', JSON.stringify(index.plugins[0], null, 2), '```', '')
lines.push(`<!-- sha256(${sha}) bytes(${Buffer.byteLength(text)}) -->`)
const other = join(OUT_DIR, 'market-entry.md')
writeFileSync(other, lines.join('\n'), 'utf8')

console.log(JSON.stringify({
  ok: problems.length === 0,
  problems,
  indexBytes: Buffer.byteLength(text),
  iconBytes: Buffer.from(iconB64, 'base64').length,
  written: [out, other],
  name: pkg.name,
  version: pkg.version,
  engines: index.plugins[0].versions[0].engines.dsh,
  publishTimestamp: index.plugins[0].versions[0].publishTimestamp
}, null, 2))
