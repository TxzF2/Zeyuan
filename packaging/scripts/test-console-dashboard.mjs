#!/usr/bin/env node
/** test-console-dashboard.mjs · 仪表盘聚合 + 健康检查 + 降级 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-dash-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/license-gate.js')).href)
const dash = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/dashboard.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${typeof actual === 'object' ? JSON.stringify(actual) : actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const checkTrue = (label, cond, detail = '') => {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log(`   细节：${detail}`)
}

const dataDir = join(STATE, 'data')

try {
  console.log('=== 1 · 空环境降级 ===')
  let d = dash.dashboard()
  check('任务总数 0', d.tasks.total, 0)
  check('草稿总数 0', d.drafts.total, 0)
  check('帖子总数 0', d.posts.total, 0)
  check('事件总数 0', d.events.total, 0)
  let h = dash.health()
  check('健康检查不崩', typeof h.ok, 'boolean')
  check('插件条目数', h.plugins.length, 5)
  check('无挂载记录 → missing', h.plugins[0].lastEvent, 'missing')

  console.log('\n=== 2 · 造数据后聚合 ===')
  mkdirSync(dataDir, { recursive: true })
  const nowIso = new Date().toISOString()
  writeFileSync(
    join(dataDir, 'tasks.json'),
    JSON.stringify({ schemaVersion: 1, updatedAt: nowIso, seq: 3, tasks: [{ status: 'open' }, { status: 'accepted' }, { status: 'accepted' }] }),
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'drafts.json'),
    JSON.stringify({ schemaVersion: 1, updatedAt: nowIso, seq: 2, drafts: [{ status: 'draft' }, { status: 'published' }], consumed: [] }),
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'posts.json'),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: nowIso,
      seq: 2,
      posts: [
        { status: 'published', likes: 3 },
        { status: 'draft', likes: 0 },
      ],
      consumed: [],
    }),
    'utf8',
  )
  writeFileSync(
    join(STATE, 'event-log.jsonl'),
    ['a', 'b', 'c', 'd'].map((x, i) => JSON.stringify({ at: `2026-10-24T12:0${i}:00.000Z`, type: `type-${x}` })).join('\n') + '\n',
    'utf8',
  )

  d = dash.dashboard()
  check('任务总数', d.tasks.total, 3)
  check('任务 accepted 数', d.tasks.byStatus.accepted, 2)
  check('任务 open 数', d.tasks.byStatus.open, 1)
  check('草稿 total', d.drafts.total, 2)
  check('草稿 published', d.drafts.byStatus.published, 1)
  check('帖子 total', d.posts.total, 2)
  check('点赞合计', d.posts.likes, 3)
  check('事件总数', d.events.total, 4)
  check('最近事件取最后 5 条内', d.events.recent.length, 4)
  check('最近事件顺序（最后一条）', d.events.recent.at(-1).type, 'type-d')
  check('用户数（无 users.json）', d.users.total, 0)
  checkTrue('板块状态包含 core', d.boards.some((x) => x.id === 'core'))

  console.log('\n=== 3 · 健康检查 ===')
  writeFileSync(
    join(STATE, 'mount-events.jsonl'),
    [
      { plugin: 'dsh-training-protocol', event: 'mounted', at: nowIso, host: 'electron' },
      { plugin: 'dsh-training-tasks', event: 'mounted', at: nowIso, host: 'electron' },
      { plugin: 'dsh-training-workbench', event: 'mounted', at: nowIso, host: 'electron' },
      { plugin: 'dsh-training-community', event: 'unmounted', at: nowIso, host: 'electron' },
      { plugin: 'dsh-training-console', event: 'mounted', at: nowIso, host: 'electron' },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
    'utf8',
  )
  /* 最后一条为 unmounted，且没有 license → ok=false 是预期 */
  gate.resetAccessCache()
  h = dash.health()
  check('community 最后状态 unmounted', h.plugins.find((p) => p.plugin === 'dsh-training-community').lastEvent, 'unmounted')
  check('健康检查整体不 ok（有 unmounted + 无 license）', h.ok, false)
  checkTrue('files.tasks 存在', h.files.tasks)
  check('files.boards 不存在（未写）', h.files.boards, false)

  console.log('\n=== 4 · 有 license 时的健康 ===')
  license.issueLicense({ subject: '学员', days: 30 })
  gate.resetAccessCache()
  writeFileSync(
    join(STATE, 'mount-events.jsonl'),
    ['dsh-training-protocol', 'dsh-training-tasks', 'dsh-training-workbench', 'dsh-training-community', 'dsh-training-console']
      .map((p) => JSON.stringify({ plugin: p, event: 'mounted', at: nowIso, host: 'electron' }))
      .join('\n') + '\n',
    'utf8',
  )
  h = dash.health()
  check('全部 mounted + license → ok', h.ok, true)
  check('license 等级', h.license.level, 'LV1')
  checkTrue('license 到期时间可读', typeof h.license.expiresAt === 'string')
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
