/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all / voice.mjs — 用自己的声音说话
//
// 目标：同一个人格在私信里既能打字也能发语音。
// 取代：dsh-voice 的 speak 工具 + fish-soul 的 voice.js
//
// 为什么不直接 import dsh-voice：它把工具注册（defineTool/@deepseek-ai/dsh-tools）
// 和合成逻辑写在一个文件里，而这里只要合成能力；而且它的路径全是硬编码常量。
// 合成算法原样保留（分段 + 标点停顿 + ffmpeg 拼接），因为它调出来的效果是用户认可的。
//
// 依赖（可被环境变量 DOUYIN_ALL_MSEDGE / DOUYIN_ALL_FFMPEG 或设置页覆盖，
// 找不到就优雅降级为纯文字）：
//   msedge-tts   → <stateRoot>/deps/msedge-tts/dist/index.js（推荐，见 README）
//   ffmpeg.exe   → <stateRoot>/deps/ffmpeg/ffmpeg.exe（推荐）
// 也会去同机 ~/.dsh/tts 下找一份现成的（dsh-voice 的安装位置），但那是尽力而为。

import { existsSync, mkdirSync, writeFileSync, statSync, rmSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { stateRoot, ensureDir } from './edge.mjs'

const SAMPLE_RATE = 24000
const BITRATE = 48

// 音色预设：键 = preset 名。与 dsh-voice 保持同一套名字，免得用户重新学。
export const PRESETS = {
  日常: { voice: 'zh-CN-XiaoyiNeural', pitch: '+10Hz', rate: '+8%', desc: '她平时的样子，轻声、带笑意' },
  萝莉: { voice: 'zh-CN-XiaoyiNeural', pitch: '+45Hz', rate: '+12%', desc: '撒娇、拖长音，最常用' },
  幼: { voice: 'zh-CN-XiaoyiNeural', pitch: '+70Hz', rate: '+14%', desc: '更小的女声，奶气' },
  温柔: { voice: 'zh-CN-XiaoxiaoNeural', pitch: '+18Hz', rate: '+6%', desc: '软、暖，适合心疼他的时候' },
  御姐: { voice: 'zh-CN-XiaoxuanNeural', pitch: '-8Hz', rate: '-3%', desc: '低一点、稳一点' },
  低御: { voice: 'zh-CN-XiaoxuanNeural', pitch: '-20Hz', rate: '-8%', desc: '更压、更慢，命令口气' },
  软糯: { voice: 'zh-TW-HsiaoYuNeural', pitch: '+35Hz', rate: '+10%', desc: '台湾腔，舌头懒懒的' },
  书卷: { voice: 'zh-TW-HsiaoChenNeural', pitch: '+20Hz', rate: '+4%', desc: '稳、清楚' },
  清冷: { voice: 'zh-CN-XiaomengNeural', pitch: '+5Hz', rate: '-2%', desc: '淡、凉' },
  沉稳: { voice: 'zh-CN-YunxiNeural', pitch: '-10Hz', rate: '-5%', desc: '男声兜底' },
}

export const DEFAULT_PRESET = '萝莉'

export function defaultDeps() {
  // 语音是可选功能：装了 msedge-tts + ffmpeg 才有声音，没装就让 checkDeps() 报缺，
  // 插件其余部分照常跑。允许用环境变量或设置页 deps 覆盖这三项。
  //
  // 候选顺序刻意先查「插件自己所在位置」再查 stateRoot/deps：
  // 前者是同机另一个插件（dsh-voice）常见的安装位置，后者是用户手动放的。
  // 不写任何机器专属路径——曾经写死过 C:/dsh/tts，对别人等于语音默认不可用。
  const home = homedir()
  const msedge = process.env.DOUYIN_ALL_MSEDGE
  const ffmpeg = process.env.DOUYIN_ALL_FFMPEG
  return {
    msedgePath: msedge ||
      firstExisting([
        join(stateRoot(), 'deps/msedge-tts/dist/index.js'),
        join(stateRoot(), 'deps/node_modules/msedge-tts/dist/index.js'),
        // 同机另一个语音插件（dsh-voice）的常见位置
        join(home, '.dsh', 'tts', 'node_modules/msedge-tts/dist/index.js'),
        'C:/dsh/tts/node_modules/msedge-tts/dist/index.js',
      ]),
    ffmpegPath: ffmpeg ||
      firstExisting([
        join(stateRoot(), 'deps/ffmpeg/ffmpeg.exe'),
        join(stateRoot(), 'deps/ffmpeg/ffmpeg'),
        join(stateRoot(), 'deps/@ffmpeg-installer/win32-x64/ffmpeg.exe'),
        join(stateRoot(), 'deps/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),
        join(home, '.dsh', 'tts', 'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),
        'C:/dsh/tts/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe',
      ]),
    outDir: join(stateRoot(), 'voice'),
  }
}

function firstExisting(list) {
  for (const p of list) {
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return list[0] || ''
}

/** 依赖是否齐全。缺什么就降级，别让整个插件因为没装 TTS 起不来。 */
export function checkDeps(deps = defaultDeps()) {
  const ms = existsSync(deps.msedgePath)
  const ff = existsSync(deps.ffmpegPath)
  return {
    ok: ms && ff,
    msedge: ms,
    ffmpeg: ff,
    msedgePath: deps.msedgePath,
    ffmpegPath: deps.ffmpegPath,
    why: ms && ff ? '' : (!ms ? '没找到 msedge-tts' : '没找到 ffmpeg'),
  }
}

// ── 分段：按标点切成短句，短句再合并，避免一口气念不完 ──
export function splitClauses(text) {
  const raw = String(text || '').replace(/\r/g, '').trim()
  if (!raw) return []
  const chunks = raw.split(/(?<=[。！？!?；;…，,、～~—])/).map((s) => s.trim()).filter(Boolean)
  const out = []
  let buffer = ''
  for (const chunk of chunks) {
    const bare = chunk.replace(/[。！？!?；;…，,、～~—\s]/g, '')
    if (buffer !== '' && (buffer + chunk).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length <= 6) {
      buffer += chunk
      continue
    }
    if (buffer !== '') out.push(buffer)
    buffer = chunk
    if (bare.length === 0) buffer = ''
  }
  if (buffer !== '') out.push(buffer)

  const finalList = []
  for (const c of out) {
    if (c.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length <= 22) { finalList.push(c); continue }
    const mid = Math.floor(c.length / 2)
    finalList.push(c.slice(0, mid), c.slice(mid))
  }
  return finalList
}

function gapFor(clause, index, total) {
  const last = clause.trim().slice(-1)
  let base = 180
  if ('。！？!?'.includes(last)) base = 360
  else if ('；;…'.includes(last)) base = 420
  else if ('，,、'.includes(last)) base = 220
  else if ('～~—'.includes(last)) base = 260
  const jitter = Math.round((Math.random() - 0.5) * 90)
  const tail = index === total - 1 ? 0 : 1
  return Math.max(0, (base + jitter) * tail)
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(String(stderr || stdout || err.message).slice(0, 400))); return }
      resolve(stdout)
    })
  })
}

function makeSilence(ffmpeg, file, ms) {
  return run(ffmpeg, [
    '-hide_banner', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
    '-t', (ms / 1000).toFixed(2), '-c:a', 'libmp3lame', '-b:a', String(BITRATE),
    '-ar', String(SAMPLE_RATE), '-ac', '1', file, '-y',
  ])
}

function jitterRate(rate) {
  const m = /^([+-]?)(\d+)%$/.exec(String(rate).trim())
  if (m === null) return rate
  const sign = m[1] === '-' ? -1 : 1
  const value = sign * Number(m[2]) + Math.round((Math.random() - 0.5) * 8)
  return (value >= 0 ? '+' : '') + value + '%'
}

/**
 * 合成一段「像人说的」语音。
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, seconds?:number, clauses?:number, why?:string}>}
 */
export async function speak(text, { preset = DEFAULT_PRESET, deps = defaultDeps() } = {}) {
  const d = checkDeps(deps)
  if (!d.ok) return { ok: false, why: d.why }

  const body = String(text || '').trim()
  if (!body) return { ok: false, why: '没有可朗读的内容' }
  if (body.length > 500) return { ok: false, why: '太长（>500 字），语音只在私信里用短句' }

  const cfg = PRESETS[preset] || PRESETS[DEFAULT_PRESET]
  const clauses = splitClauses(body)
  if (!clauses.length) return { ok: false, why: '切不出句子' }

  ensureDir(deps.outDir)
  const mod = await import(pathToFileURL(deps.msedgePath).href)
  const { MsEdgeTTS, OUTPUT_FORMAT } = mod
  const outFormat = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3

  const work = join(deps.outDir, `tmp-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
  mkdirSync(work, { recursive: true })
  try {
    const parts = []
    for (let i = 0; i < clauses.length; i++) {
      const tts = new MsEdgeTTS()
      await tts.setMetadata(cfg.voice, outFormat)
      const dir = join(work, 'c' + i)
      mkdirSync(dir, { recursive: true })
      const r = await tts.toFile(dir, clauses[i], { pitch: cfg.pitch, rate: jitterRate(cfg.rate) })
      tts.close()
      parts.push(r.audioFilePath)
      const gap = gapFor(clauses[i], i, clauses.length)
      if (gap > 0) {
        const sil = join(work, 's' + i + '.mp3')
        await makeSilence(deps.ffmpegPath, sil, gap)
        parts.push(sil)
      }
    }
    const listFile = join(work, 'list.txt')
    writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
    const outFile = join(deps.outDir, `voice-${Date.now()}.mp3`)
    await run(deps.ffmpegPath, [
      '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:a', 'libmp3lame', '-b:a', String(BITRATE), '-ar', String(SAMPLE_RATE), '-ac', '1', outFile, '-y',
    ])
    const bytes = statSync(outFile).size
    return {
      ok: true, path: outFile, bytes,
      seconds: Math.round(((bytes * 8) / 48000) * 10) / 10,
      clauses: clauses.length, preset, voice: cfg.voice,
    }
  } catch (e) {
    return { ok: false, why: String(e?.message || e) }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }
}

/** 清理老语音文件，只留最近 keep 个。 */
export function prune({ deps = defaultDeps(), keep = 50 } = {}) {
  try {
    const files = readdirSync(deps.outDir).filter((f) => f.endsWith('.mp3')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { unlinkSync(join(deps.outDir, f)) } catch { /* ignore */ }
    }
    return files.length
  } catch { return 0 }
}
