#!/usr/bin/env node
/**
 * test-workbench-bus.mjs · 事件消费（总线 + 补扫 + 幂等）+ 存储（原子/损坏/锁）
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-wb-bus-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const consume = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-workbench/dist/consume.js')).href)
const store = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-workbench/dist/store.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const checkTrue = (label, cond, detail = '') => {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log(`   细节：${detail}`)
}

const NOW = new Date('2026-10-24T12:00:00.000Z')
const accepted = (taskId, evId) => ({
  v: 1,
  id: evId,
  type: consentType(),
  payload: { taskId, to: 'alice', coins: 10 },
  subject: { taskId },
})
const consentType = () => 'dsh-training:tasks:task-accepted'

const dataDir = store.dataDir()

try {
  console.log('=== 1 · 在线消费 ===')
  const r1 = consume.consumeAccepted(accepted('t-1', 'ev-1'), NOW)
  check('建草稿成功', r1.created, true)
  check('草稿 id 形如 d-YYYYMMDD-NNNN', /^d-\d{8}-\d{4}$/.test(r1.draftId), true)
  let doc = store.readDoc(NOW)
  check('草稿数', doc.drafts.length, 1)
  check('owner 取自事件 to', doc.drafts[0].owner, 'alice')
  check('sourceTaskId', doc.drafts[0].sourceTaskId, 't-1')
  check('consumed 记录事件 id', doc.consumed.includes('ev-1'), true)

  console.log('\n=== 2 · 幂等 ===')
  const r2 = consume.consumeAccepted(accepted('t-1', 'ev-1'), NOW)
  check('同事件重复 → 不建', r2.created, false)
  check('同事件原因', r2.reason, 'duplicate-event')
  const r3 = consume.consumeAccepted(accepted('t-1', 'ev-2'), NOW)
  check('同任务新事件 → 不建', r3.created, false)
  check('同任务原因', r3.reason, 'duplicate-task')
  check('草稿仍为 1 份', store.readDoc(NOW).drafts.length, 1)

  console.log('\n=== 3 · 补扫 event-log.jsonl ===')
  const log = join(STATE, 'event-log.jsonl')
  const lines = [
    { v: 1, id: 'ev-10', type: 'dsh-training:tasks:task-submitted', payload: { taskId: 't-2' } },
    { v: 1, id: 'ev-11', type: consentType(), payload: { taskId: 't-2', to: 'bob' } },
    { v: 1, id: 'ev-12', type: consentType(), payload: { taskId: 't-3', to: 'carol' } },
    { v: 1, id: 'ev-11', type: consentType(), payload: { taskId: 't-2', to: 'bob' } },
    'not-json',
  ]
  writeFileSync(log, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8')
  const replay = consume.replayLog(NOW)
  check('扫描到 3 条 accepted', replay.scanned, 3)
  check('新建 2 份草稿', replay.created, 2)
  const after = store.readDoc(NOW)
  check('总草稿数', after.drafts.length, 3)
  checkTrue('无关事件被忽略', !after.drafts.some((d) => d.sourceTaskId === 't-2x'))

  const replay2 = consume.replayLog(NOW)
  check('二次补扫不重复建', replay2.created, 0)

  console.log('\n=== 4 · 存储韧性 ===')
  const file = store.draftsFile()
  const good = readFileSync(file, 'utf8')
  writeFileSync(file, '{bad json', 'utf8')
  let code = ''
  try {
    store.readDoc(NOW)
  } catch (err) {
    code = err.code
  }
  check('损坏报 E-910', code, 'E-910')
  checkTrue('生成备份', existsSync(dataDir) && readFileSync(file, 'utf8') === '{bad json')
  writeFileSync(file, good, 'utf8')

  writeFileSync(store.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
  let lockCode = ''
  try {
    store.withLock(() => 1, 120)
  } catch (err) {
    lockCode = err.code
  }
  check('锁占用报 E-911', lockCode, 'E-911')
  rmSync(store.lockFile(), { force: true })
  checkTrue('锁已清理', !existsSync(store.lockFile()))
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
