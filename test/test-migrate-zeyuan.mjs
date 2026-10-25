// 泽元迁移脚本测试：dry-run / apply / 幂等 / 回滚备份
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const mod = await import(pathToFileURL(resolve(ROOT, 'packaging/scripts/migrate-zeyuan.mjs')).href)

const BASE = mkdtempSync(join(tmpdir(), 'zy-migrate-'))
const oldDir = join(BASE, 'dsh-training')
const newDir = join(BASE, 'zeyuan')
const profileDir = join(BASE, 'profile')
mkdirSync(oldDir, { recursive: true })
mkdirSync(profileDir, { recursive: true })

writeFileSync(
  join(oldDir, 'event-log.jsonl'),
  [
    JSON.stringify({ event: 'dsh-training:tasks:task-created', id: 'ev-1', ts: new Date().toISOString(), actor: 'bob', payload: {} }),
    JSON.stringify({ event: 'dsh-training:exchange:file-uploaded', id: 'ev-2', ts: new Date().toISOString(), actor: 'bob', payload: {} }),
    JSON.stringify({ event: 'zeyuan:console:bootstrap', id: 'ev-3', ts: new Date().toISOString(), actor: null, payload: {} }),
  ].join('\n') + '\n',
  'utf8',
)
writeFileSync(
  join(oldDir, 'mount-events.jsonl'),
  [JSON.stringify({ plugin: 'dsh-training-tasks', event: 'mounted' }), JSON.stringify({ plugin: 'zeyuan-console', event: 'mounted' })].join('\n') + '\n',
  'utf8',
)
writeFileSync(join(oldDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [] }), 'utf8')

writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify(
    {
      name: 'desktop',
      dependencies: { 'dsh-training-console': 'link:../plugins/dsh-training-console', 'dsh-training-tasks': 'link:../plugins/dsh-training-tasks' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-training-protocol'] } },
    },
    null,
    2,
  ),
  'utf8',
)

const paths = { oldStateDir: oldDir, newStateDir: newDir, profileDir }

test('migrate: dry-run plans copy+rewrites without touching disk', () => {
  const plan = mod.buildPlan(paths)
  assert.ok(plan.pending >= 3, `应有 ≥3 项待执行，实际 ${plan.pending}`)
  const kinds = plan.actions.map((a) => `${a.kind}:${a.what}`)
  assert.ok(kinds.includes('copy:state-dir'), JSON.stringify(kinds))
  assert.ok(kinds.includes('rewrite:event-log'), JSON.stringify(kinds))
  assert.ok(kinds.includes('rewrite:mount-events'), JSON.stringify(kinds))
  assert.ok(kinds.includes('rewrite:profile'), JSON.stringify(kinds))
  // dry-run 不写盘
  assert.ok(!existsSync(newDir), 'dry-run 不应创建新目录')
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.ok('dsh-training-console' in pkg.dependencies, 'dry-run 不应改 profile')
})

test('migrate: apply copies state, rewrites event/mount/profile, keeps old dir', () => {
  const { done } = mod.applyMigration(paths)
  assert.ok(done.length >= 3, `应执行 ≥3 项，实际 ${done.length}`)
  assert.ok(existsSync(newDir), '新状态目录应存在')
  assert.ok(existsSync(oldDir), '旧目录必须保留（非破坏）')

  const events = readFileSync(join(newDir, 'event-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(events.map((e) => e.event), ['zeyuan:tasks:task-created', 'zeyuan:exchange:file-uploaded', 'zeyuan:console:bootstrap'])
  const mounts = readFileSync(join(newDir, 'mount-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(mounts.map((m) => m.plugin), ['zeyuan-tasks', 'zeyuan-console'])

  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.ok('zeyuan-console' in pkg.dependencies && 'zeyuan-tasks' in pkg.dependencies)
  assert.ok(!Object.keys(pkg.dependencies).some((k) => k.startsWith('dsh-training')))
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'zeyuan-protocol'])

  const backups = readdirSync(profileDir).filter((f) => f.includes('.bak-'))
  assert.equal(backups.length, 1, '应生成 1 个备份')
})

test('migrate: second run is idempotent (no further changes, no extra backup)', () => {
  const before = readFileSync(join(newDir, 'event-log.jsonl'), 'utf8')
  const backupsBefore = readdirSync(profileDir).filter((f) => f.includes('.bak-')).length
  const { done } = mod.applyMigration(paths)
  assert.deepEqual(done, [], `第二次应无变更，实际：${JSON.stringify(done)}`)
  assert.equal(readFileSync(join(newDir, 'event-log.jsonl'), 'utf8'), before)
  assert.equal(readdirSync(profileDir).filter((f) => f.includes('.bak-')).length, backupsBefore, '不应新增备份')
})

test('migrate: legacy envelope upgraded to canonical and renamed', () => {
  const legacy = JSON.stringify({ v: 1, id: 'ev-9', at: '2026-10-20T00:00:00.000Z', source: 'tasks', type: 'dsh-training:tasks:task-claimed', subject: {}, payload: { by: 'bob', taskId: 't1' } })
  const out = mod.convertLine(legacy)
  assert.equal(out.changed, true)
  assert.equal(out.upgraded, true)
  const env = JSON.parse(out.line)
  assert.deepEqual(Object.keys(env).sort(), ['actor', 'event', 'id', 'payload', 'ts'])
  assert.equal(env.event, 'zeyuan:tasks:task-claimed')
  assert.equal(env.actor, 'bob')
  assert.equal(env.ts, '2026-10-20T00:00:00.000Z')

  const already = JSON.stringify({ event: 'zeyuan:tasks:task-created', id: 'ev-1', ts: new Date().toISOString(), actor: null, payload: {} })
  assert.equal(mod.convertLine(already).changed, false, '已合规行不应改动')
})

test('migrate: pure renamers', () => {
  assert.equal(mod.renameEvent('dsh-training:tasks:task-created'), 'zeyuan:tasks:task-created')
  assert.equal(mod.renameEvent('zeyuan:tasks:task-created'), 'zeyuan:tasks:task-created')
  assert.equal(mod.renameName('dsh-training-console'), 'zeyuan-console')
  assert.equal(mod.renameName('dsh-training-protocol'), 'zeyuan-protocol')
  assert.equal(mod.renameName('@deepseek-ai/dsh-base'), '@deepseek-ai/dsh-base')
})

process.on('exit', () => rmSync(BASE, { recursive: true, force: true }))
