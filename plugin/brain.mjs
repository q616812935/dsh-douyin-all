/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / brain.mjs — 「说什么」这一层
//
// 把「怎么发」和「说什么」彻底分开：
//   · chat/comments/feed 负责操作抖音页面；
//   · brain 负责用人格写出这句话。
//
// 模型来源有三档，按可用性降级（DSH 宿主 → OpenAI 兼容端点 → 本地模板）：
//   1. 宿主模型：`ctx.llm`（DshWeb 里就是用户设置页选的那个 deepseek-flash）。
//      这是首选 —— 不额外配 key，而且和 IM 那边是同一个人格。
//   2. 显式配置的兼容端点：`config.llm = {baseUrl, apiKey, model}`，走 /v1/chat/completions。
//   3. 兜底：不从网络要东西，从人格里取几句现成的话，保证「永不出错、永不空手」。
//
// 为什么要有第 3 档：抖音风控、断网、模型限流都是常态。那个位置宁可说一句
// 平淡的话，也不能沉默 —— 沉默在用户看来就是「插件坏了」。

import { Soul } from './soul.mjs'

export class Brain {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig 配置读取器（每次现读，改配置立刻生效）
   * @param {object} [o.llm] DSH 的 llm 服务（ctx.llm），可为空
   * @param {(level:string, msg:string) => void} [o.log]
   */
  constructor({ getConfig, llm = null, log = () => { } } = {}) {
    this.getConfig = getConfig
    this.llm = llm
    this.log = log
    this.soul = new Soul()
    this.lastSource = ''
  }

  get conf() { return this.getConfig() }

  // ── 模型调用 ──────────────────────────────────────────────────────────────

  /**
   * 宿主模型的可用性（设置页要显示这个）。
   * 配置里没写 = **跟随宿主设置页**（默认行为），这时取宿主第一个可用模型，
   * 不能当成「没配置」——那会让每一次回复都掉到兜底话术上。
   */
  hostModel() {
    const c = this.conf
    const provider = String(c.model?.provider || '').trim()
    const model = String(c.model?.model || '').trim()
    if (provider && model) return { provider, model }
    if (this._autoPick) return this._autoPick
    return null
  }

  /** 问宿主要一份可用模型列表（并记下第一个当「跟随宿主」的默认值）。 */
  async ensureAutoModel() {
    if (!this.llm) return null
    if (this._autoPick) return this._autoPick
    const list = await this.listModels().catch(() => [])
    const hit = list.find((m) => m && m.provider && m.model)
    if (hit) this._autoPick = { provider: hit.provider, model: hit.model }
    return this._autoPick || null
  }

  /**
   * 问模型要一句/一段话。
   * @returns {Promise<{ok:boolean, text:string, source:string, why?:string}>}
   */
  async ask({ system, user, maxChars = 200, temperature = 0.9, timeoutMs = 45000 } = {}) {
    const c = this.conf
    // 1) 宿主模型（没显式配置就跟宿主设置页走）
    if (this.llm && !this.hostModel()) await this.ensureAutoModel().catch(() => null)
    const hm = this.hostModel()
    if (this.llm && hm) {
      try {
        const out = await this.callHost({ system, user, maxChars, temperature, timeoutMs })
        if (out && out.trim()) return { ok: true, text: out.trim(), source: 'host:' + hm.model }
      } catch (e) {
        this.log('warn', `宿主模型调用失败：${e?.message || e}`)
      }
    } else if (this.llm && !hm) {
      this.log('warn', '宿主没有可用模型（设置页 → 模型 → 选一个），本轮走兜底')
    }

    // 2) 自定义兼容端点
    if (c.llm?.baseUrl && c.llm?.model) {
      try {
        const out = await this.callOpenAI({ system, user, maxChars, temperature, timeoutMs, conf: c.llm })
        if (out && out.trim()) return { ok: true, text: out.trim(), source: 'api:' + c.llm.model }
      } catch (e) {
        this.log('warn', `自定义端点调用失败：${e?.message || e}`)
      }
    }

    // 3) 兜底
    return { ok: false, text: '', source: 'none', why: '没有可用的模型' }
  }

  /**
   * 调 DSH 宿主模型。
   *
   * 这里是实测出来的唯一正确用法（dsh 0.2.1-rc.4 / @deepseek-ai/dsh-llm）：
   *   `llm.prepareCall({provider, model, temperature, maxTokens})` → `prepared.stream(options)` → AsyncIterable<StreamChunk>
   *   拿文本：累加 `{type:'text-delta'}` 的 `.text`。
   *
   * 消息必须是 `Message` 对象，不能是 OpenAI 那种 `{role:'system', content:'...'}` 字面量：
   *   `createSystemMessage(text)` / `createUserMessage([{type:'text', text}])`（都来自 dsh-llm/message）。
   * 这两点都写错过一次（宿主 llm 只有 prepareCall/stream，没有 complete/chat），
   * 所以下面还留了一条 `llm.stream(options)` 的退路，但**不要**退回 OpenAI 消息格式。
   */
  async callHost({ system, user, maxChars, temperature, timeoutMs }) {
    const llm = this.llm
    const hm = this.hostModel()
    const mod = await hostLlmModule()
    const messages = []
    if (system) messages.push(mod.createSystemMessage(system))
    // 签名是 { content, source }，不是裸 content —— 传数组会被当成 input，content 变成 undefined，
    // 宿主适配器随后报 'content is not iterable'（实测）。
    messages.push(mod.createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }))
    const callConfig = {
      provider: hm.provider,
      model: hm.model,
      temperature,
      maxTokens: Math.max(64, Math.min(2048, maxChars * 4)),
    }
    const signal = AbortSignal.timeout(timeoutMs)
    let iterable
    if (typeof llm.prepareCall === 'function') {
      const prepared = await llm.prepareCall(callConfig, signal)
      // prepared.stream 要求请求里的 call-config 字段与 prepared.config 完全一致
      iterable = prepared.stream({ ...prepared.config, messages, signal })
    } else if (typeof llm.stream === 'function') {
      iterable = llm.stream({ ...callConfig, messages, signal })
    } else {
      throw new Error('宿主 llm 既没有 prepareCall 也没有 stream')
    }
    let text = ''
    for await (const chunk of iterable) {
      if (!chunk) continue
      // 只认 text-delta：block-end 里的 block.text 是**整块全文**，再拼一次会让每句话重复两遍（实测）。
      if (chunk.type === 'text-delta') text += String(chunk.text || '')
      else if (chunk.type === 'finish' && chunk.reason && /error|abort/i.test(String(chunk.reason))) {
        throw new Error('模型调用未完成：' + chunk.reason)
      }
    }
    if (!text.trim()) throw new Error('模型返回了空内容')
    return text
  }

  /** 列出可选的 provider/model（设置页要用；宿主没有 llm 就返回空）。 */
  async listModels() {
    const out = []
    const llm = this.llm
    if (!llm) return out
    let providers = []
    try { providers = llm.listProviders() || [] } catch { /* ignore */ }
    for (const p of providers) {
      let models = []
      try { models = (await llm.listModels(p.id)) || [] } catch { /* ignore */ }
      for (const m of models) out.push({ provider: p.id, providerName: p.name, model: m.id, name: m.name })
    }
    return out
  }

  /** 标准 OpenAI 兼容端点（/v1/chat/completions）。 */
  async callOpenAI({ system, user, maxChars, temperature, timeoutMs, conf }) {
    const base = String(conf.baseUrl).replace(/\/+$/, '')
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(conf.apiKey ? { authorization: 'Bearer ' + conf.apiKey } : {}),
      },
      body: JSON.stringify({
        model: conf.model,
        temperature,
        max_tokens: Math.max(64, Math.min(1024, maxChars * 4)),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200))
    const j = await r.json()
    return String(j?.choices?.[0]?.message?.content || '')
  }

  // ── 三个场景 ──────────────────────────────────────────────────────────────

  /** 回一条私信。返回 {ok,text,source} */
  async replyDm({ who, incoming, recent = [] }) {
    const c = this.conf
    const p = this.soul.personaPrompt({ context: 'dm', who })
    const mems = this.soul.recall(incoming, { who, limit: 4 })
      .map((m) => `· ${m.text}`).join('\n')
    const history = recent.slice(-6).map((m) => `${m.mine ? '我' : who}：${m.text}`).join('\n')
    const user = [
      `对方（${who}）刚发来：「${incoming}」`,
      history ? `最近的对话：\n${history}` : '',
      mems ? `你记得的事：\n${mems}` : '',
      '写一条回复。要求：只输出要说的话本身，不要引号、不要解释、不要加「回复：」；',
      '长度 1–3 句，口语，可以带一个 emoji 或者语气词；别像客服，别提自己是 AI。',
      `最多 ${c.dm?.maxChars || 120} 字。`,
    ].filter(Boolean).join('\n')
    const r = await this.ask({ system: p, user, maxChars: c.dm?.maxChars || 120, temperature: 0.95 })
    if (r.ok) return { ...r, text: cleanReply(r.text, c.dm?.maxChars || 120) }
    return { ok: false, text: fallbackDm(incoming, this.soul), source: 'fallback' }
  }

  /** 回一条评论（60 字以内，评论区的话要短）。 */
  async replyComment({ awemeDesc = '', author = '', incoming, isSelfWork = false }) {
    const c = this.conf
    const p = this.soul.personaPrompt({ context: 'comment', who: author })
    const max = c.comments?.maxChars || 60
    const user = [
      isSelfWork ? `这是我的作品，标题：「${awemeDesc}」` : `刷到一个作品，标题：「${awemeDesc}」`,
      `${author} 评论说：「${incoming}」`,
      '回一句评论。要求：只输出这一句，不要引号、不要解释；短、口语、像随手打的；',
      '' + `如果对方的评论没什么可接的，就只回一个词或者一个 emoji。最多 ${max} 字。`,
    ].join('\n')
    const r = await this.ask({ system: p, user, maxChars: max, temperature: 1.0 })
    if (r.ok) return { ...r, text: cleanReply(r.text, max) }
    return { ok: false, text: fallbackComment(incoming), source: 'fallback' }
  }

  /** 主动私信：挑到一个视频，说一句。 */
  async pickPitch({ who, videoDesc, comments = [] }) {
    const p = this.soul.personaPrompt({ context: 'pick', who })
    const user = [
      `你在刷抖音，刷到一个想跟他说一声的视频：「${videoDesc}」`,
      comments.length ? `热评：\n${comments.map((x) => `· ${x.nick}：${x.text}`).join('\n')}` : '',
      '给你想告诉的那个人写一句话，不要链接、不要标题，就说你的反应。最多 40 字。',
    ].filter(Boolean).join('\n')
    const r = await this.ask({ system: p, user, maxChars: 40, temperature: 1.0 })
    if (r.ok) return { ...r, text: cleanReply(r.text, 40) }
    return { ok: false, text: '刚刷到个东西，等你忙完给你看', source: 'fallback' }
  }

  /** 写今天的日记（这句要能留在 soul 里当记忆）。 */
  async writeDiary({ dayText, name = '' }) {
    const p = this.soul.personaPrompt({ context: 'diary', who: name })
    const user = [
      '用你自己的口吻写一句今天的日记（1–2 句，40 字以内）。',
      '下面是你今天真实发生的事，不要编：',
      dayText,
    ].join('\n')
    const r = await this.ask({ system: p, user, maxChars: 60, temperature: 0.9 })
    return r.ok ? { ...r, text: cleanReply(r.text, 60) } : { ok: false, text: '', source: 'none' }
  }

  /**
   * 从这段对话里抽出值得记的事（写进 soul 的长期记忆）。
   * 用「结构化输出 + 失败就当没有」的策略：抽不出来不算错。
   */
  async extractMemories({ who, lines = [] }) {
    if (!lines.length) return []
    const user = [
      `下面是我和「${who}」的聊天记录：`,
      lines.map((m) => `${m.mine ? '我' : who}：${m.text}`).join('\n'),
      '',
      '从中挑出关于「他」的、以后值得记住的事实（喜好、身份、约定、重要的日子、他说过的重要的事）。',
      '最多 3 条，每条一句话，不要客套话，不要评价。',
      '只输出 JSON 数组，元素形如 {"text":"...","kind":"fact|preference|event|promise","importance":1-5}。什么都没有就输出 []。',
    ].join('\n')
    // maxChars 是「兜底话术」的长度上限，不是 token 预算：原来给 300 去掉 \n 后被截成
    // "...{\"text\":\"...{\"text\":\"..." 这种半截 JSON，parse 永远失败（实测返回 []）。给足预算。
    const r = await this.ask({ system: '你是一个只输出 JSON 的信息抽取器，不要输出任何别的文字。', user, maxChars: 1200, temperature: 0.2 })
    if (!r.ok) return []
    const arr = parseJsonArray(r.text.replace(/\s*\n\s*/g, ' '))
    return arr.filter((x) => x && String(x.text || '').trim()).slice(0, 3)
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 把模型输出清成「一句能发出去的话」：去引号、去前缀、去换行、截断。 */
export function cleanReply(text, maxChars = 120) {
  let s = String(text || '').trim()
  // 去代码块围栏
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
  // 去常见前缀（模型爱加）
  s = s.replace(/^(回复|回应|答|回复内容|消息)[:：]\s*/g, '')
  // 去包裹的引号
  s = s.replace(/^["'“”「『]+/, '').replace(/["'“”」』]+$/, '')
  // 只取第一段（模型有时会写「选项 A / 选项 B」）
  s = s.split(/\n{2,}/)[0].replace(/\s*\n\s*/g, ' ').trim()
  if (s.length > maxChars) s = s.slice(0, maxChars)
  return s
}

// ── dsh-llm 消息构造器 ──────────────────────────────────────────────────────
// 宿主 llm 只吃 Message 对象，必须用 dsh-llm 的 createSystemMessage/createUserMessage 造。
// 但插件装在自己的目录里，裸写 '@deepseek-ai/dsh-llm/message' 会解析到插件目录下
// （实测报 'C:\@deepseek-ai\dsh\node_modules\...'）。所以这里分级定位：
//   ① 宿主安装位置（require.resolve 从 dsh 包出发）—— 最稳，换机器/换版本都对；
//   ② 本插件 node_modules（发布后理论上会有 peer）；
//   ③ 已知的服务器绝对路径（DshWeb 的 C:\nodejs22 安装）。
let _hostMod = null
let _hostModErr = ''
export function injectHostLlmModule(m) {
  if (m && typeof m.createUserMessage === 'function' && typeof m.createSystemMessage === 'function') {
    _hostMod = m
    return true
  }
  return false
}
async function hostLlmModule() {
  if (_hostMod) return _hostMod
  const specs = []
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(process.argv[1] || 'C:/nodejs22/node_modules/@deepseek-ai/dsh/package.json')
    // 先找宿主包本身，再从它的 node_modules 里取 dsh-llm
    const dshPkg = req.resolve('@deepseek-ai/dsh/package.json')
    const dir = dshPkg.replace(/[\\/]package\.json$/, '')
    specs.push('file:///' + dir.replace(/\\/g, '/') + '/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js')
    specs.push('file:///' + dir.replace(/\\/g, '/') + '/../dsh-llm/lib/types/message.js')
  } catch (e) { _hostModErr = 'resolve dsh: ' + (e?.message || e) }
  specs.push('@deepseek-ai/dsh-llm/message')
  if (process.env.DSH_LLM_MESSAGE) specs.push('file:///' + process.env.DSH_LLM_MESSAGE.replace(/\\/g, '/'))
  for (const spec of specs) {
    try {
      const m = await import(spec)
      if (injectHostLlmModule(m)) return m
    } catch (e) { _hostModErr = spec + ': ' + (e?.message || e) }
  }
  throw new Error('找不到 dsh-llm 的消息构造器（' + _hostModErr + '）')
}

function parseJsonArray(text) {
  const s = String(text || '').trim()
  const i = s.indexOf('[')
  const j = s.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  try {
    const arr = JSON.parse(s.slice(i, j + 1))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

// 兜底话术：不联网、不随机，只保证「有回应且不像机器人」
const FALLBACK_DM = ['嗯嗯，我在', '看到啦', '怎么啦', '刚在忙，现在有空了', '嘿嘿']
const FALLBACK_COMMENT = ['谢谢～', '哈哈哈', '好耶', '😘', '在呢']

function fallbackDm(incoming, soul) {
  const t = String(incoming || '')
  if (/[?？]/.test(t)) return '嗯…让我想想'
  if (/(晚安|睡觉|困)/.test(t)) return '晚安啦，早点睡'
  if (/(在吗|在不在|你好|hi)/i.test(t)) return '在的'
  const aff = soul?.state?.affection
  const k = t.length % FALLBACK_DM.length
  return FALLBACK_DM[k]
}

function fallbackComment(incoming) {
  const t = String(incoming || '')
  if (/(好看|可爱|漂亮|喜欢)/.test(t)) return '嘿嘿谢谢'
  if (/[?？]/.test(t)) return '这个嘛…'
  return FALLBACK_COMMENT[t.length % FALLBACK_COMMENT.length]
}

export { fallbackDm, fallbackComment }
