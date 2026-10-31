#!/usr/bin/env node
/**
 * coordination-brief.mjs · 三机进度汇总（每天 09:00 自动发群）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/coordination-brief.mjs            # 收集 + 发群
 *   node scripts/coordination-brief.mjs --dry      # 只打印，不发群
 *   node scripts/coordination-brief.mjs --no-send  # 同 --dry（兼容写法）
 *
 * 数据来源（全部本机可读，不编造）：
 *   - git：分支、HEAD、最近提交
 *   - 交付/：文档数量、evidence 数量
 *   - tasks API：任务统计（在线时）；离线则标"离线"
 *   - im 配置：是否可用（脱敏）
 *   - dsh-2 / dsh-3：**固定写"未报到（无跨机通道）"**，不臆造
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const dry = process.argv.includes('--dry') || process.argv.includes('--no-send')
const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || '', 'zeyuan')

const sh = (cmd, args, cwd = ROOT) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// ---- dsh 本机状态 ----
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown'
const head = (sh('git', ['rev-parse', '--short', 'HEAD']) || 'unknown').slice(0, 7)
const lastCommit = sh('git', ['log', '-1', '--pretty=%s']) || '（无）'
const lastTime = sh('git', ['log', '-1', '--pretty=%cd', '--date=format:%m-%d %H:%M']) || ''
const behind = sh('git', ['rev-list', '--count', 'origin/main..HEAD']) || '?'
const delivery = existsSync(join(ROOT, '交付')) ? readdirSync(join(ROOT, '交付')).filter((f) => f.endsWith('.md')).length : 0
const evidence = existsSync(join(ROOT, '交付', 'evidence')) ? readdirSync(join(ROOT, '交付', 'evidence')).length : 0
const pageBanner = existsSync(join(ROOT, 'docs', 'download.html')) && readFileSync(join(ROOT, 'docs', 'download.html'), 'utf8').includes('通道维护中')

// ---- 任务统计（在线才取）----
let taskLine = '任务接口离线'
try {
  const res = await fetch('http://127.0.0.1:19387/zeyuan/tasks/list', { headers: { 'x-dsh-user': 'local-user' } })
  if (res.ok) {
    const j = await res.json()
    const rows = j.data?.tasks ?? []
    const by = {}
    for (const t of rows) by[t.status] = (by[t.status] ?? 0) + 1
    taskLine = `任务 ${rows.length} 条（${Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' ')}）`
  }
} catch {
  /* 离线 */
}

// ---- im 配置 ----
let imLine = 'IM 未配置'
try {
  const cfg = JSON.parse(readFileSync(join(stateDir, 'data', 'im.json'), 'utf8')).dingtalk
  const token = (cfg.webhook || '').match(/access_token=([^&]+)/)?.[1] ?? ''
  imLine = cfg.webhook ? `IM 可用（token ${token.slice(0, 6)}…${token.slice(-6)}，secret ${cfg.secret ? '已配' : '未配'}）` : 'IM 缺 webhook'
} catch {
  /* 未配置 */
}

const now = new Date()
const stamp = now.toLocaleString('zh-CN', { hour12: false })

const lines = [
  `## 三机进度汇总 · ${stamp}`,
  '',
  '| 机器 | 做了什么 | 卡在哪 | 明天做什么 |',
  '|---|---|---|---|',
  `| **dsh** | 分支 \`${branch}\` · HEAD \`${head}\`（未推送 ${behind}）· 最近提交：${lastCommit}｜交付 ${delivery} 份 / 证据 ${evidence} 件｜${taskLine}｜${imLine} | ${pageBanner ? '**下载页仍在维护横幅**（等网盘/镜像）' : '下载页无维护横幅'} | 复核支线交付、跟进字段裁定、通道修复 |`,
  '| **dsh-2** | ⏳ 未报到（无跨机通道） | — | — |',
  '| **dsh-3** | ⏳ 未报到（无跨机通道） | — | — |',
  '',
  `> 自动生成于 ${stamp}（scripts/coordination-brief.mjs）｜dsh-2/dsh-3 数据不可读，如实标注未报到，未编造`,
]

const md = lines.join('\n')
console.log(md)

if (dry) {
  console.log('\n（--dry：未发送）')
  process.exit(0)
}

// ---- 发群 ----
try {
  const push = await import(pathToFileURL(join(ROOT, 'plugins/zeyuan-im/dist/push.js')).href)
  const cfg = JSON.parse(readFileSync(join(stateDir, 'data', 'im.json'), 'utf8')).dingtalk
  if (!cfg.webhook) throw new Error('未配置 webhook')
  const r = await push.sendDingTalk(cfg, push.markdownMessage(`三机进度汇总 ${stamp}`, md))
  const receipt = r.ok ? `✅ HTTP ${r.status} / errcode ${r.errcode ?? 0} / attempts ${r.attempts}` : `❌ ${r.error}`
  console.log('\n' + receipt)
  const evDir = join(ROOT, '交付', 'evidence')
  mkdirSync(evDir, { recursive: true })
  writeFileSync(
    join(evDir, `brief-${Date.now()}.json`),
    JSON.stringify({ at: new Date().toISOString(), receipt, content: md }, null, 2) + '\n',
    'utf8',
  )
  process.exit(r.ok ? 0 : 1)
} catch (err) {
  console.error('\n❌ 发送失败：' + err.message)
  process.exit(1)
}
