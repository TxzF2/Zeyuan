#!/usr/bin/env node
/** test-tasks-groups.mjs · 组任务仅组内可见 + 挂组 + 改派 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASE = mkdtempSync(join(tmpdir(), 'dsh-tasks-groups-'))
const STATE = join(BASE, 'state')
mkdirSync(join(STATE, 'data'), { recursive: true })
process.env.DSH_TRAINING_STATE_DIR = STATE

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-tasks/dist/license-gate.js')).href)
const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-tasks/dist/index.js')).href)

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

const routes = new Map()
const ctx = {
  effect(fn) { return fn() },
  on() {},
  inject(deps, cb) {
    cb({ effect: ctx.effect, webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } } })
  },
}

async function call(method, path, body, actor) {
  const [p, q] = path.split('?')
  const handler = routes.get(`/zeyuan/tasks/${p}`)
  if (!handler) throw new Error(`路由不存在：${path}`)
  const L = {}
  const req = { method, url: `/zeyuan/tasks/${p}${q ? '?' + q : ''}`, headers: actor ? { 'x-dsh-user': actor } : {}, on(ev, cb) { L[ev] = cb } }
  const res = { status: 0, body: null, writeHead(s) { res.status = s }, end(b) { res.body = b ? JSON.parse(b) : null } }
  const pr = Promise.resolve(handler(req, res))
  await new Promise((r) => setTimeout(r, 0))
  if (body !== undefined) L.data?.(Buffer.from(JSON.stringify(body)))
  L.end?.()
  await pr.catch(() => {})
  await new Promise((r) => setTimeout(r, 5))
  return res
}

try {
  console.log('=== 种子数据 ===')
  license.issueLicense({ subject: '学员', days: 30 })
  gate.resetAccessCache()
  // 组：bob 组长，alice 组员，carol 不在组
  writeFileSync(
    join(STATE, 'data', 'groups.json'),
    JSON.stringify({ schemaVersion: 1, seq: 1, groups: [{ id: 'g-1', leader: 'bob', capacity: 4, members: [{ userId: 'bob', duty: 'build' }, { userId: 'alice', duty: 'training' }], taskIds: [], status: 'active' }] }, null, 2),
    'utf8',
  )
  writeFileSync(join(STATE, 'data', 'admins.json'), JSON.stringify({ schemaVersion: 1, admins: [{ userId: 'root', tier: 8 }] }), 'utf8')

  mod.apply(ctx)
  check('路由数 10', routes.size, 10)

  console.log('\n=== 1 · 建任务并挂组 ===')
  let r = await call('POST', 'create', { title: '组内结项报告', bounty: 30 }, 'bob')
  check('建任务', r.status, 200)
  const tid = r.body.data.id
  r = await call('POST', 'attach-group', { id: tid, groupId: 'g-1' }, 'carol')
  check('非组长挂组 → 403', r.status, 403)
  r = await call('POST', 'attach-group', { id: tid, groupId: 'g-1' }, 'bob')
  check('组长挂组成功', r.body.data.groupId, 'g-1')
  r = await call('POST', 'attach-group', { id: tid, groupId: 'nope' }, 'bob')
  check('挂不存在的组 → 404', r.status, 404)

  console.log('\n=== 2 · 仅组内可见 ===')
  r = await call('GET', 'list', undefined, 'bob')
  check('组长可见', r.body.data.tasks.some((x) => x.id === tid), true)
  r = await call('GET', 'list', undefined, 'alice')
  check('组员可见', r.body.data.tasks.some((x) => x.id === tid), true)
  r = await call('GET', 'list', undefined, 'carol')
  check('非成员不可见', r.body.data.tasks.some((x) => x.id === tid), false)
  r = await call('GET', 'list', undefined, 'root')
  check('P8 可见（排障兜底）', r.body.data.tasks.some((x) => x.id === tid), true)
  r = await call('GET', `detail?id=${tid}`, undefined, 'carol')
  check('非成员详情 → 404', r.status, 404)
  r = await call('GET', `detail?id=${tid}`, undefined, 'alice')
  check('组员详情可读', r.status, 200)

  console.log('\n=== 3 · 组任务操作需成员 ===')
  r = await call('POST', 'claim', { id: tid }, 'carol')
  check('非成员领取 → 403', r.status, 403)
  check('→ E-806', r.body.code, 'E-806')
  r = await call('POST', 'claim', { id: tid }, 'alice')
  check('组员领取成功', r.body.data.status, 'claimed')

  console.log('\n=== 4 · 改派 ===')
  r = await call('POST', 'reassign', { id: tid, assignee: 'carol' }, 'bob')
  check('改派给非成员 → 400', r.status, 400)
  r = await call('POST', 'reassign', { id: tid, assignee: 'alice' }, 'alice')
  check('组员改派 → 403', r.status, 403)
  r = await call('POST', 'reassign', { id: tid, assignee: 'alice' }, 'bob')
  check('组长改派成功', r.body.data.assignee, 'alice')

  console.log('\n=== 5 · 公开任务不受影响 ===')
  r = await call('POST', 'create', { title: '公开任务' }, 'bob')
  const pub = r.body.data.id
  r = await call('GET', 'list', undefined, 'carol')
  check('公开任务所有人可见', r.body.data.tasks.some((x) => x.id === pub), true)

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
} finally {
  rmSync(BASE, { recursive: true, force: true })
}
