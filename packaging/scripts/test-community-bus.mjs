#!/usr/bin/env node
/** test-community-bus.mjs · 消费草稿发布事件（内容继承 + 双去重 + 补扫）+ 存储韧性 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-community-bus-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const consume = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-community/dist/consume.js')).href)
const store = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-community/dist/store.js')).href)

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
const TYPE = 'dsh-training:feature-workbench:draft-published'
const ev = (draftId, eventId, owner = 'bob') => ({ v: 1, id: eventId, type: TYPE, payload: { draftId, owner } })

const dataDir = store.dataDir()

try {
  // 预置一份工作台草稿（供内容继承）
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'drafts.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: NOW.toISOString(),
        seq: 1,
        drafts: [{ id: 'd-1', title: '联动验收报告', body: '# 结论\n链路已通', tags: ['联动'], owner: 'bob', status: 'published' }],
        consumed: [],
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log('=== 1 · 在线消费（内容继承）===')
  const r1 = consume.consumeDraftPublished(ev('d-1', 'ev-a'), NOW)
  check('建帖子草稿成功', r1.created, true)
  let doc = store.readDoc(NOW)
  const post = doc.posts[0]
  check('帖子数', doc.posts.length, 1)
  check('标题继承草稿', post.title, '联动验收报告')
  checkTrue('正文继承草稿', post.body.includes('链路已通'), post.body)
  check('标签继承草稿', post.tags[0], '联动')
  check('作者继承草稿 owner', post.author, 'bob')
  check('状态为 draft（不直接公开）', post.status, 'draft')
  check('sourceDraftId', post.sourceDraftId, 'd-1')

  console.log('\n=== 2 · 双去重 ===')
  check('同事件重复', consume.consumeDraftPublished(ev('d-1', 'ev-a'), NOW).reason, 'duplicate-event')
  check('同草稿新事件', consume.consumeDraftPublished(ev('d-1', 'ev-b'), NOW).reason, 'duplicate-draft')
  check('帖子仍 1 份', store.readDoc(NOW).posts.length, 1)

  console.log('\n=== 3 · 补扫 ===')
  const log = join(STATE, 'event-log.jsonl')
  writeFileSync(
    log,
    [
      { v: 1, id: 'ev-1', type: 'dsh-training:tasks:task-accepted', payload: { taskId: 't-1' } },
      { v: 1, id: 'ev-2', type: TYPE, payload: { draftId: 'd-2', owner: 'carol' } },
      { v: 1, id: 'ev-2', type: TYPE, payload: { draftId: 'd-2', owner: 'carol' } },
      { v: 1, id: 'ev-3', type: TYPE, payload: { draftId: 'd-3', owner: 'dave' } },
      'bad-line',
    ]
      .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
      .join('\n') + '\n',
    'utf8',
  )
  const r = consume.replayLog(NOW)
  check('扫描 3 条', r.scanned, 3)
  check('新建 2 份', r.created, 2)
  check('总帖子数', store.readDoc(NOW).posts.length, 3)
  check('二次补扫不重复', consume.replayLog(NOW).created, 0)

  console.log('\n=== 4 · 存储韧性 ===')
  const file = store.postsFile()
  const good = readFileSync(file, 'utf8')
  writeFileSync(file, '{bad', 'utf8')
  let code = ''
  try {
    store.readDoc(NOW)
  } catch (err) {
    code = err.code
  }
  check('损坏报 E-1010', code, 'E-1010')
  checkTrue('未覆盖原文件', readFileSync(file, 'utf8') === '{bad')
  writeFileSync(file, good, 'utf8')
  writeFileSync(store.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
  let lockCode = ''
  try {
    store.withLock(() => 1, 120)
  } catch (err) {
    lockCode = err.code
  }
  check('锁占用报 E-1011', lockCode, 'E-1011')
  rmSync(store.lockFile(), { force: true })
  checkTrue('锁已清理', !existsSync(store.lockFile()))
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
