#!/usr/bin/env node
/**
 * machine-report.mjs · 单机状态上报（自包含，零依赖，可拷到任意机器）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node machine-report.mjs --machine dsh-2
 *   node machine-report.mjs --machine dsh-2 --note "词库 30 条已完成"
 *   node machine-report.mjs --machine dsh-3 --selfcheck
 *
 * 配置：同目录 im.json（{ "webhook": "...", "secret": "SEC..." }），
 *       或 --config <path>，或环境变量 DINGTALK_WEBHOOK / DINGTALK_SECRET。
 * 输出：钉钉群 markdown 一行式状态；本地追加 machine-report.log。
 * 退出码：0 成功 / 1 失败。
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, platform, release } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const val = (f, d) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const has = (f) => args.includes(f)

const machine = val('--machine', hostname())
const note = val('--note', '')
const selfcheck = has('--selfcheck')
const cfgPath = val('--config', join(HERE, 'im.json'))
const hub = val('--hub', process.env.ZEYUAN_HUB ?? '')  // 可选：收集器地址 http://<ip>:19501/report
const done = val('--done', '')
const blocked = val('--blocked', '')
const next = val('--next', '')

let webhook = process.env.DINGTALK_WEBHOOK ?? ''
let secret = process.env.DINGTALK_SECRET ?? ''
if (existsSync(cfgPath)) {
  try {
    const c = JSON.parse(readFileSync(cfgPath, 'utf8'))
    webhook = c.webhook ?? c.dingtalk?.webhook ?? webhook
    secret = c.secret ?? c.dingtalk?.secret ?? secret
  } catch {
    /* ignore */
  }
}

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${machine} ${m}`
  console.log(line)
  try {
    appendFileSync(join(HERE, 'machine-report.log'), line + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

if (!webhook) {
  log('❌ 缺 webhook（同目录 im.json 或 DINGTALK_WEBHOOK）')
  process.exit(1)
}

const sh = (cmd, a) => {
  try {
    return execFileSync(cmd, a, { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

const now = new Date().toLocaleString('zh-CN', { hour12: false })
const head = sh('git', ['rev-parse', '--short', 'HEAD'])
const lastMsg = sh('git', ['log', '-1', '--pretty=%s'])
const pending = sh('git', ['rev-list', '--count', 'origin/main..HEAD'])

const rows = [
  `## [${machine}] 状态汇报${selfcheck ? '（接入自检）' : ''}`,
  '',
  `- 时间：${now}`,
  `- 主机：${hostname()} · ${platform()} ${release()} · Node ${process.version}`,
  head ? `- 仓库：HEAD \`${head}\`（未推送 ${pending || '?'}）` : '- 仓库：未检出/非 git 目录',
  lastMsg ? `- 最近提交：${lastMsg}` : '',
  done ? `- 做了什么：${done}` : (note ? `- 做了什么：${note}` : ''),
  blocked ? `- 卡在哪：${blocked}` : '',
  next ? `- 明天做什么：${next}` : '',
  '',
  `> 自动上报（machine-report.mjs）`,
].filter(Boolean)

const md = rows.join('\n')

const sign = (ts) => {
  if (!secret) return ''
  const s = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64')
  return `&timestamp=${ts}&sign=${encodeURIComponent(s)}`
}

let ok = false
let lastErr = ''
for (let i = 1; i <= 3; i++) {
  try {
    const url = webhook + sign(String(Date.now()))
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: `[${machine}] 状态汇报`, text: md } }),
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && (body.errcode === 0 || body.errcode === undefined)) {
      log(`✅ 已发送（HTTP ${res.status} / errcode ${body.errcode ?? 0} / attempts ${i}）`)
      ok = true
      break
    }
    lastErr = `HTTP ${res.status} errcode=${body.errcode ?? '-'} ${body.errmsg ?? ''}`.trim()
  } catch (err) {
    lastErr = err.name === 'TimeoutError' ? '超时 15s' : err.message
  }
  await new Promise((r) => setTimeout(r, 400 * i))
}

if (!ok) {
  log(`❌ 发送失败：${lastErr}`)
  process.exit(1)
}

// 上报收集器（可选，失败不影响已发群的结果）
if (hub) {
  try {
    const res = await fetch(hub, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machine, at: new Date().toISOString(), done: done || note, blocked, next, host: hostname(), node: process.version, head, lastMsg, pending }),
      signal: AbortSignal.timeout(8000),
    })
    log(res.ok ? `✅ 已上报收集器（HTTP ${res.status}）` : `⚠️ 收集器返回 HTTP ${res.status}`)
  } catch (e) {
    log(`⚠️ 收集器不可达（不影响群消息）：${e.name === 'TimeoutError' ? '超时' : e.message}`)
  }
}
