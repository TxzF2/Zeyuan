#!/usr/bin/env node
/**
 * test-tasks-store.mjs · 存储层（原子写 / 损坏恢复 / 文件锁）
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const STATE = mkdtempSync(join(tmpdir(), 'dsh-tasks-store-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const store = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-tasks/dist/store.js')).href)

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

const now = new Date('2026-10-24T12:00:00.000Z')
const dataDir = store.dataDir()
const tasksFile = store.tasksFile()

try {
  console.log('=== 1 · 首次读取 ===')
  const empty = store.readDoc(now)
  check('无文件返回空文档', empty.tasks.length, 0)
  check('schemaVersion', empty.schemaVersion, store.DOC_VERSION)
  check('seq 从 0 起', empty.seq, 0)

  console.log('\n=== 2 · 写入与回读 ===')
  const doc = {
    schemaVersion: store.DOC_VERSION,
    updatedAt: now.toISOString(),
    seq: 1,
    tasks: [
      {
        id: 't-20261024-0001',
        title: '示例',
        description: '',
        tags: ['文档'],
        bounty: 50,
        deadline: null,
        creator: 'alice',
        assignee: null,
        status: 'open',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        history: [],
      },
    ],
  }
  store.writeDoc(doc, now)
  checkTrue('tasks.json 已生成', readdirSync(dataDir).includes('tasks.json'))
  const back = store.readDoc(now)
  check('回读任务数', back.tasks.length, 1)
  check('回读 id', back.tasks[0].id, 't-20261024-0001')
  checkTrue('无 .tmp 残留', !readdirSync(dataDir).some((f) => f.includes('.tmp')), readdirSync(dataDir).join(','))

  console.log('\n=== 3 · 损坏恢复 ===')
  const good = readFileSync(tasksFile, 'utf8')
  writeFileSync(tasksFile, '{ this is not json', 'utf8')
  let corruptCode = ''
  try {
    store.readDoc(now)
  } catch (err) {
    corruptCode = err.code
  }
  check('损坏报 E-810', corruptCode, 'E-810')
  const backups = readdirSync(dataDir).filter((f) => f.includes('.corrupt-'))
  check('已生成备份文件', backups.length, 1)
  checkTrue('原文件未被覆盖', readFileSync(tasksFile, 'utf8') === '{ this is not json')
  // 还原，避免影响后续
  writeFileSync(tasksFile, good, 'utf8')

  console.log('\n=== 4 · 文件锁 ===')
  const lockPath = store.lockFile()
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
  let lockCode = ''
  try {
    store.withLock(() => 'never', 150)
  } catch (err) {
    lockCode = err.code
  }
  check('锁被占用时报 E-811', lockCode, 'E-811')
  rmSync(lockPath, { force: true })

  // stale 锁：把 mtime 拨到 1 分钟前
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() - 60_000 }), 'utf8')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockPath, old, old)
  const staleResult = store.withLock(() => 'recovered', 500)
  check('stale 锁可被回收', staleResult, 'recovered')
  checkTrue('回收后锁文件已删除', !readdirSync(dataDir).includes('tasks.json.lock'))

  console.log('\n=== 5 · updateDoc ===')
  const r1 = store.updateDoc((d) => ({ doc: { ...d, seq: d.seq + 1 }, result: d.seq + 1 }), now)
  check('updateDoc 返回业务结果', r1, 2)
  check('落盘 seq', store.readDoc(now).seq, 2)
  checkTrue('无锁残留', !readdirSync(dataDir).includes('tasks.json.lock'))

  console.log('\n=== 6 · 目录约定 ===')
  checkTrue('data 目录位于状态目录下', dataDir.startsWith(STATE))
  checkTrue('数据文件名固定 tasks.json', statSync(tasksFile).isFile())
  mkdirSync(dataDir, { recursive: true })
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
