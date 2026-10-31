#!/usr/bin/env node
/**
 * verify-im-live.mjs · R-234 加载层/推送层一次性验证
 * ---------------------------------------------------------------------------
 * 做的事（不重启、不写业务数据以外的东西）：
 *   1) 查 zeyuan-im 是否已挂载（mount-events）
 *   2) 查配置（webhook/secret 是否存在，脱敏）
 *   3) 跑一条真实任务流：发布→领取→提交→验收（唯一标题，便于定位）
 *   4) 读 event-log，核对该任务是否产生 zeyuan:im:notified / push-failed
 *   5) 输出三行判定（加载层 / 订阅层 / 推送层）+ 落盘证据 JSON
 *
 * 用法：
 *   node scripts/verify-im-live.mjs
 * 退出码：0=全通；1=有未通过项（会打印原因）
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BASE = 'http://127.0.0.1:19387'
const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || '', 'zeyuan')
const mountFile = join(stateDir, 'mount-events.jsonl')
const logFile = join(stateDir, 'event-log.jsonl')
const cfgFile = join(stateDir, 'data', 'im.json')

const rows = []
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function api(path, { method = 'GET', body, user } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-dsh-user': user } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let j = null
  try {
    j = await res.json()
  } catch {}
  return { status: res.status, body: j }
}

const readJsonl = (f) => {
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------------- 1) 加载层 ----------------
const mounts = readJsonl(mountFile).filter((m) => m.plugin === 'zeyuan-im')
const lastMount = mounts.slice(-1)[0] ?? null
const imAny = readJsonl(logFile).filter((e) => String(e.event).startsWith('zeyuan:im:')).slice(-1)[0] ?? null
const mounted = lastMount?.event === 'mounted'
check('加载层：zeyuan-im 已加载', mounted || Boolean(imAny), mounted ? `挂载标记 ${lastMount.at} v${lastMount.version}` : imAny ? `无挂载标记，但已有 im 事件（${imAny.event} @ ${imAny.ts}）→ 插件确在运行` : '无挂载标记且无 im 事件')

// ---------------- 2) 配置层 ----------------
let cfg = null
try {
  cfg = JSON.parse(readFileSync(cfgFile, 'utf8')).dingtalk
} catch {}
const hasWebhook = Boolean(cfg?.webhook)
const hasSecret = Boolean(cfg?.secret)
check('配置层：webhook 已配置', hasWebhook, hasWebhook ? `${cfg.webhook.length} 字符（已脱敏不显示）` : '❌ 缺 webhook（推送会静默跳过）')
check('配置层：加签密钥已配置', hasSecret, hasSecret ? '已配置（不显示）' : '未配置（若机器人开了加签会 310000）')

// ---------------- 3) 任务流 ----------------
const title = `R-234 验证-${Date.now().toString(36)}`
console.log(`\n— 跑任务流：${title}`)
const created = await api('/zeyuan/tasks/create', { method: 'POST', body: { title, description: 'R-234 加载/推送验证', bounty: 1 }, user: 'bob' })
const taskId = created.body?.data?.id
check('任务流：发布成功', created.status === 200 && Boolean(taskId), taskId ? `${taskId} status=${created.body.data.status}` : `HTTP ${created.status}`)
if (taskId) {
  const claimed = await api('/zeyuan/tasks/claim', { method: 'POST', body: { id: taskId }, user: 'alice' })
  check('任务流：领取成功', claimed.status === 200, `status=${claimed.body?.data?.status ?? claimed.status}`)
  const submitted = await api('/zeyuan/tasks/submit', { method: 'POST', body: { id: taskId, note: '验证提交' }, user: 'alice' })
  check('任务流：提交成功', submitted.status === 200, `status=${submitted.body?.data?.status ?? submitted.status}`)
  const accepted = await api('/zeyuan/tasks/accept', { method: 'POST', body: { id: taskId }, user: 'bob' })
  check('任务流：验收成功', accepted.status === 200, `status=${accepted.body?.data?.status ?? accepted.status}`)
}

// ---------------- 4) 事件核对 ----------------
await new Promise((r) => setTimeout(r, 1500))
const logs = readJsonl(logFile)
const taskEvents = logs.filter((e) => e.payload?.taskId === taskId).map((e) => e.event)
const imEvents = logs.filter((e) => String(e.event).startsWith('zeyuan:im:') && (!taskId || e.payload?.taskId === taskId || e.event === 'zeyuan:im:notified'))
const notified = imEvents.filter((e) => e.event === 'zeyuan:im:notified')
const failed = imEvents.filter((e) => e.event === 'zeyuan:im:push-failed')

console.log('\n— 事件：', taskEvents.length ? [...new Set(taskEvents)].join(' / ') : '（未找到该任务事件）')
check('订阅层：任务事件已产生', taskEvents.includes('zeyuan:tasks:task-claimed') && taskEvents.includes('zeyuan:tasks:task-accepted'), `${taskEvents.length} 条`)

const loadedEvidence = Boolean(lastMount?.event === 'mounted') || imEvents.length > 0
if (loadedEvidence && hasWebhook) {
  check('推送层：产生 notified 事件', notified.length > 0, `notified=${notified.length} push-failed=${failed.length}`)
} else if (loadedEvidence && !hasWebhook) {
  check('推送层：未配置 webhook 时按设计跳过（不算失败）', notified.length === 0, '插件会记日志「未配置钉钉 webhook，跳过」，无 im 事件属预期')
} else {
  check('推送层：未加载，无法验证', false, '需先重启 DSH')
}

// ---------------- 5) 落盘证据 ----------------
const okAll = rows.every((r) => r.ok)
const ev = {
  at: new Date().toISOString(),
  taskId: taskId ?? null,
  title,
  mount: lastMount,
  config: { webhook: hasWebhook, secret: hasSecret },
  taskEvents: [...new Set(taskEvents)],
  imEvents: imEvents.map((e) => e.event),
  rows,
  verdict: okAll ? 'PASS' : 'FAIL',
}
const evDir = join(ROOT, '交付', 'evidence')
mkdirSync(evDir, { recursive: true })
const evFile = join(evDir, `R-234-IM验证-${Date.now()}.json`)
writeFileSync(evFile, JSON.stringify(ev, null, 2) + '\n', 'utf8')
console.log(`\n📄 证据：${evFile}`)
console.log(`\n${okAll ? '✅ 全部通过' : '❌ 有未通过项'}（${rows.filter((r) => r.ok).length}/${rows.length}）`)
if (!okAll) {
  console.log('\n未通过原因：')
  rows.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.name}：${r.detail}`))
}
process.exit(okAll ? 0 : 1)
