// 用真正的 dsh-plugin-market-index 校验器校验索引 JSON
// 用法：node _checkindex.mjs <json路径> [indexUrl]
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const file = process.argv[2] || 'C:/dsh/douyin-all/_dev/market-index.json'
const indexUrl = process.argv[3] || 'https://example.com/market-index.json'
const lib = 'C:/nodejs22/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'

const m = await import(pathToFileURL(lib).href)
const text = readFileSync(file, 'utf8')

const out = { file, indexUrl, bytes: Buffer.byteLength(text) }
try {
  const parsed = m.parseMarketIndex(JSON.parse(text), indexUrl)
  out.ok = true
  out.svg = JSON.stringify(parsed).slice(0, 400)
  out.pluginCount = parsed.plugins?.length ?? null
  out.firstPlugin = parsed.plugins?.[0] ? {
    name: parsed.plugins[0].name,
    versions: parsed.plugins[0].versions?.map((v) => v.version),
    iconPrefix: String(parsed.plugins[0].icon || '').slice(0, 40)
  } : null
} catch (e) {
  out.ok = false
  out.path = e.path
  out.reason = e.reason
  out.message = String(e && e.message)
}
console.log(JSON.stringify(out, null, 2))
