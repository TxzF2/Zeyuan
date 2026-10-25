#!/usr/bin/env node
/** test-console-dashboard.mjs · 仪表盘四指标 + 健康 + 对账降级 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASE = mkdtempSync(join(tmpdir(), 'dsh-console-dash-'))
const STATE = join(BASE, 'state')
const PROFILE = join(BASE, 'profile')
mkdirSync(STATE, { recursive: true })
mkdirSync(PROFILE, { recursive: true })
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_TRAINING_PROFILE_DIR = PROFILE

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/license-gate.js')).href)
const dash = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/dashboard.js')).href)
const users = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/users.js')).href)
const wallet = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/wallet.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${typeof actual === 'object' ? JSON.stringify(actual) : actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}

const NOW = new Date('2026-10-24T12:00:00.000Z')
const dataDir = join(STATE, 'data')
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')

try {
  console.log('=== 1 · 空环境 ===')
  let d = dash.dashboard(NOW)
  check('在线 0', d.online.current, 0)
  check('任务 0', d.tasks.total, 0)
  check('金币 0', d.coins.today, 0)
  check('对账 ok', d.coins.reconcileOk, true)

  console.log('\n=== 2 · 在线用户（15 分钟窗）===')
  users.resolveUser('fresh', new Date(NOW.getTime() - 60_000))
  users.resolveUser('stale', new Date(NOW.getTime() - 30 * 60_000))
  const u = users.listUsers(15 * 60 * 1000, NOW)
  check('总用户 2', u.total, 2)
  check('在线 1（fresh）', u.online, 1)

  console.log('\n=== 3 · 任务吞吐 ===')
  writeFileSync(
    join(dataDir, 'tasks.json'),
    JSON.stringify({
      schemaVersion: 1,
      seq: 3,
      tasks: [
        { id: 't1', status: 'accepted', createdAt: NOW.toISOString(), history: [{ action: 'accept', at: NOW.toISOString() }] },
        { id: 't2', status: 'open', createdAt: '2026-10-20T00:00:00.000Z', history: [] },
        { id: 't3', status: 'accepted', createdAt: NOW.toISOString(), history: [{ action: 'accept', at: '2026-10-23T00:00:00.000Z' }] },
      ],
    }),
    'utf8',
  )
  d = dash.dashboard(NOW)
  check('任务总数 3', d.tasks.total, 3)
  check('今日发布 2', d.tasks.createdToday, 2)
  check('今日完成 1', d.tasks.acceptedToday, 1)
  check('accepted 统计', d.tasks.byStatus.accepted, 2)

  console.log('\n=== 4 · 金币流水（钱包）===')
  wallet.ingestReward('ev-a', 'bob', 30, NOW)
  wallet.grantCoins('root', 8, 'carol', 20, '测试发放', NOW)
  d = dash.dashboard(NOW)
  check('今日金币合计 50', d.coins.today, 50)
  check('今日笔数 2', d.coins.count, 2)
  check('其中发币 20', d.coins.grantedToday, 20)
  check('对账仍 ok', d.coins.reconcileOk, true)

  console.log('\n=== 5 · 健康检查 ===')
  writeFileSync(
    join(STATE, 'mount-events.jsonl'),
    ['zeyuan-protocol', 'zeyuan-tasks', 'zeyuan-workbench', 'zeyuan-community', 'zeyuan-console']
      .map((p) => JSON.stringify({ plugin: p, event: 'mounted', at: NOW.toISOString(), host: 'electron' }))
      .join('\n') + '\n',
    'utf8',
  )
  license.issueLicense({ subject: '学员', days: 30 })
  gate.resetAccessCache()
  let h = dash.health(NOW)
  check('五插件都 mounted', h.plugins.every((p) => p.lastEvent === 'mounted'), true)
  check('健康 ok', h.ok, true)
  check('对账 ok', h.reconcile.ok, true)
  check('license LV1', h.license.level, 'LV1')

  console.log('\n=== 6 · 脏数据让健康变红 ===')
  const doc = wallet.readWallet()
  doc.balances.bob = 999
  wallet.writeWallet(doc)
  h = dash.health(NOW)
  check('对账失败', h.reconcile.ok, false)
  check('健康 ok=false', h.ok, false)
  check('给出不平用户', h.reconcile.mismatches.some((m) => m.startsWith('bob')), true)
} finally {
  rmSync(BASE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
