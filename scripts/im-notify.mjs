#!/usr/bin/env node
/**
 * im-notify.mjs · 向钉钉群推送任意消息（供三机协同/分工表/日报使用）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/im-notify.mjs --text "R-219 联通测试 2026-10-31 22:00"
 *   node scripts/im-notify.mjs --file 交付/三机协同-分工表与夜间汇总-20261031.md --title "三机分工表"
 *   node scripts/im-notify.mjs --file <md> --title <标题> --webhook <url> --secret <SEC>
 *
 * 说明：
 *   - 有 --file 时按 markdown 发送（钉钉 markdown 上限约 5000 字，超长自动截断并提示）
 *   - 未给 --webhook 时读 %LOCALAPPDATA%\zeyuan\data\im.json
 *   - 只回执 HTTP/errcode/attempts，不打印 webhook 明文
 * ---------------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const push = await import(pathToFileURL(join(ROOT, 'plugins/zeyuan-im/dist/push.js')).href)

const args = process.argv.slice(2)
const val = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'zeyuan')
const cfgPath = join(stateDir, 'data', 'im.json')

function loadCfg() {
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8')).dingtalk
  } catch {
    return { webhook: '', secret: '' }
  }
}

let cfg = loadCfg()
const webhookArg = val('--webhook')
if (webhookArg) {
  cfg = { webhook: webhookArg.trim(), secret: (val('--secret') ?? cfg.secret ?? '').trim(), enabled: true }
  mkdirSync(dirname(cfgPath), { recursive: true })
  writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, dingtalk: cfg, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
}

const textArg = val('--text')
const fileArg = val('--file')
const titleArg = val('--title') ?? '泽元 · 群通知'

if (!cfg.webhook) {
  console.error('❌ 未配置 webhook。先设置：')
  console.error('   node scripts/im-notify.mjs --webhook "<钉钉 webhook>" [--secret "<SEC>"] --text "测试"')
  process.exit(1)
}
if (!textArg && !fileArg) {
  console.error('❌ 需要 --text 或 --file')
  process.exit(1)
}

const MAX = 4800
let payload
if (fileArg) {
  const p = resolve(ROOT, fileArg)
  if (!existsSync(p)) {
    console.error(`❌ 文件不存在：${p}`)
    process.exit(1)
  }
  let body = readFileSync(p, 'utf8')
  if (body.length > MAX) {
    body = body.slice(0, MAX) + '\n\n> （内容超长已截断，完整版见仓库）'
    console.warn(`⚠️ 内容 ${readFileSync(p, 'utf8').length} 字，超过 ${MAX}，已截断`)
  }
  payload = push.markdownMessage(titleArg, body)
} else {
  payload = push.textMessage(textArg)
}

const r = await push.sendDingTalk(cfg, payload)
if (r.ok) {
  console.log(`✅ 已发送（HTTP ${r.status} / errcode ${r.errcode ?? 0} / attempts ${r.attempts}）`)
} else {
  console.error(`❌ 发送失败（attempts ${r.attempts}）：${r.error}`)
  process.exit(1)
}
