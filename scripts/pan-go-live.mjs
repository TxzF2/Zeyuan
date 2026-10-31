#!/usr/bin/env node
/**
 * pan-go-live.mjs · 网盘救急上线一键脚本（R-234 一）
 * ---------------------------------------------------------------------------
 * 总控私聊给网盘链接后执行（≤30 分钟要求，实际 <1 分钟）：
 *   node scripts/pan-go-live.mjs --url "<分享链接>" --code "<提取码>" [--label 百度网盘] [--no-send]
 *
 * 做的事（顺序固定，任一步失败即中止并打印原因）：
 *   1) 写入 docs/download-links.json（url/code/label/note）
 *   2) 重新生成 docs/download.html（含网盘卡片）
 *   3) 撤下"通道维护中"横幅
 *   4) 校验页面：含链接、含提取码、无维护横幅
 *   5) 群内发恢复公告（--no-send 可跳过）
 *   6) 回执与证据落盘 交付/evidence/pan-golive-<ts>.json
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LINKS = join(ROOT, 'docs', 'download-links.json')
const PAGE = join(ROOT, 'docs', 'download.html')

const args = process.argv.slice(2)
const val = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (f) => args.includes(f)
const url = val('--url')
const code = val('--code') ?? ''
const label = val('--label') ?? '百度网盘'
const note = val('--note') ?? '整包 149.35 MB，含《升级说明》与合并脚本'

if (!url) {
  console.error('用法：node scripts/pan-go-live.mjs --url "<分享链接>" --code "<提取码>" [--label 百度网盘] [--no-send]')
  process.exit(1)
}
if (!/^https?:\/\//.test(url)) {
  console.error('❌ url 必须以 http(s):// 开头')
  process.exit(1)
}

const steps = []
const ok = (name, detail = '') => {
  steps.push({ name, ok: true, detail })
  console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`)
}
const bad = (name, detail) => {
  steps.push({ name, ok: false, detail })
  console.error(`❌ ${name} — ${detail}`)
}

// 1) 写配置
try {
  const cfg = existsSync(LINKS) ? JSON.parse(readFileSync(LINKS, 'utf8')) : {}
  cfg.pan = { label, url, code, note }
  writeFileSync(LINKS, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  ok('写入 download-links.json', `label=${label} code=${code || '（无）'}`)
} catch (err) {
  bad('写入 download-links.json', err.message)
  process.exit(1)
}

// 2) 重新生成页面
try {
  const { writePage } = await import(pathToFileURL(join(ROOT, 'scripts/release.mjs')).href)
  const r = writePage({ repo: 'TxzF2/Zeyuan' })
  ok('重新生成下载页', `版本 ${r.version} / 哈希前 8 位 ${r.hash8}`)
} catch (err) {
  bad('重新生成下载页', err.message)
  process.exit(1)
}

// 3) 撤下维护横幅
try {
  let html = readFileSync(PAGE, 'utf8')
  const before = html.length
  html = html.replace(/\n?\s*<div style="[^"]*">\s*<b>⚠️ 通道维护中，暂勿下发<\/b>[\s\S]*?<\/div>/, '')
  writeFileSync(PAGE, html, 'utf8')
  const removed = before !== html.length
  if (removed) ok('撤下"通道维护中"横幅')
  else ok('维护横幅', '页面已无横幅（幂等）')
} catch (err) {
  bad('撤下维护横幅', err.message)
}

// 4) 校验页面
try {
  const html = readFileSync(PAGE, 'utf8')
  const checks = [
    ['页面含网盘链接', html.includes(url)],
    ['页面含"网盘备用下载"', html.includes('网盘备用下载')],
    ['页面无维护横幅', !html.includes('通道维护中')],
    code ? ['页面含提取码', html.includes(code)] : ['提取码（未提供，跳过）', true],
  ]
  let allOk = true
  for (const [name, pass] of checks) {
    if (pass) ok('校验：' + name)
    else {
      allOk = false
      bad('校验：' + name, '未通过')
    }
  }
  if (!allOk) process.exit(1)
} catch (err) {
  bad('校验页面', err.message)
  process.exit(1)
}

// 5) 群内恢复公告
let pushResult = 'skipped'
if (!has('--no-send')) {
  try {
    const push = await import(pathToFileURL(join(ROOT, 'plugins/zeyuan-im/dist/push.js')).href)
    const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || '', 'zeyuan')
    const cfg = JSON.parse(readFileSync(join(stateDir, 'data', 'im.json'), 'utf8')).dingtalk
    const msg = [
      '### 📢 下载通道恢复公告',
      '',
      `- 网盘整包下载已上线：${label}`,
      code ? `- 提取码：${code}` : '- 无需提取码',
      '- GitHub 直连仍可能限速，请优先用网盘',
      '- 下载页：https://txzf2.github.io/Zeyuan/download.html',
      '',
      `> ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].join('\n')
    const r = await push.sendDingTalk(cfg, push.markdownMessage('下载通道恢复公告', msg))
    pushResult = r.ok ? `HTTP ${r.status} / errcode ${r.errcode ?? 0} / attempts ${r.attempts}` : `失败：${r.error}`
    if (r.ok) ok('群内恢复公告已发送', pushResult)
    else bad('群内恢复公告', pushResult)
  } catch (err) {
    bad('群内恢复公告', err.message)
  }
} else {
  console.log('· 跳过群公告（--no-send）')
}

// 6) 证据
const ev = {
  at: new Date().toISOString(),
  url,
  code,
  label,
  page: 'docs/download.html',
  steps,
  pushResult,
}
const dir = join(ROOT, '交付', 'evidence')
mkdirSync(dir, { recursive: true })
const f = join(dir, `pan-golive-${Date.now()}.json`)
writeFileSync(f, JSON.stringify(ev, null, 2) + '\n', 'utf8')
console.log(`\n📄 证据：${f}`)

const passCount = steps.filter((s) => s.ok).length
console.log(`\n${passCount}/${steps.length} 步通过`)
if (steps.some((s) => !s.ok)) process.exit(1)
console.log('\n⚠️ 还需人工一步：手机浏览器打开下载页 → 下载整包 → 合并/解压验证（我无法用手机实测）')
