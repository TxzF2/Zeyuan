#!/usr/bin/env node
/** test-workbench-routes.mjs · 草稿路由 + 总线联动 + 权限 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-wb-routes-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-workbench/dist/license-gate.js')).href)
const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-workbench/dist/index.js')).href)

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
const listeners = new Map()
const disposers = []
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  },
  on(type, cb) {
    listeners.set(type, cb)
  },
  emit(type, payload) {
    const cb = listeners.get(type)
    if (cb) cb(payload)
  },
  inject(deps, cb) {
    cb({
      effect: ctx.effect,
      webServer: {
        register(spec) {
          routes.set(spec.path, spec.handler)
          return () => routes.delete(spec.path)
        },
      },
    })
  },
}

function call(method, path, body, actor, query = '') {
  const handler = routes.get(`/dsh-training/workbench/${path}`)
  if (!handler) throw new Error(`路由不存在：${path}`)
  const listenersReq = {}
  const req = {
    method,
    url: `/dsh-training/workbench/${path}${query}`,
    headers: actor ? { 'x-dsh-user': actor } : {},
    on(ev, cb) {
      listenersReq[ev] = cb
    },
  }
  const res = {
    status: 0,
    body: null,
    writeHead(s) {
      res.status = s
    },
    end(b) {
      res.body = b ? JSON.parse(b) : null
    },
  }
  const p = Promise.resolve(handler(req, res))
  return (async () => {
    await new Promise((r) => setTimeout(r, 0))
    if (body !== undefined) listenersReq.data?.(Buffer.from(JSON.stringify(body)))
    listenersReq.end?.()
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    return res
  })()
}

const events = () =>
  existsSync(join(STATE, 'event-log.jsonl'))
    ? readFileSync(join(STATE, 'event-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

try {
  console.log('=== 1 · 注册与等级 ===')
  mod.apply(ctx)
  check('注册路由数', routes.size, 7)
  checkTrue('已订阅 task-accepted', listeners.has('dsh-training:tasks:task-accepted'))
  checkTrue('已订阅补扫完成（launch）', existsSync(join(STATE, 'mount-events.jsonl')))

  let r = await call('GET', 'me', undefined, 'alice')
  check('未签署 → LV0', r.body.data.level, 'LV0')
  r = await call('POST', 'create', { title: 'x' }, 'alice')
  check('LV0 创建 → 403', r.status, 403)
  check('LV0 → E-601', r.body.code, 'E-601')

  console.log('\n=== 2 · 签署后 CRUD ===')
  license.issueLicense({ subject: '测试学员', days: 30 })
  gate.resetAccessCache()

  r = await call('POST', 'create', { title: '我的第一篇', body: 'hello', tags: ['文档'] }, 'alice')
  check('创建成功', r.body.ok, true)
  const d1 = r.body.data
  check('owner=alice', d1.owner, 'alice')
  check('初始 draft', d1.status, 'draft')

  r = await call('POST', 'create', { title: '' }, 'alice')
  check('空标题 → 400', r.status, 400)
  check('空标题 → E-903', r.body.code, 'E-903')

  r = await call('GET', 'list', undefined, 'alice')
  check('列表总数', r.body.data.total, 1)
  r = await call('GET', 'list', undefined, 'bob', '?mine=1')
  check('mine 过滤（bob 无草稿）', r.body.data.total, 0)
  r = await call('GET', 'detail', undefined, 'alice', `?id=${d1.id}`)
  check('详情标题', r.body.data.title, '我的第一篇')
  r = await call('GET', 'detail', undefined, 'alice', '?id=nope')
  check('不存在 → 404', r.status, 404)

  console.log('\n=== 3 · 越权与状态 ===')
  r = await call('POST', 'save', { id: d1.id, title: '被改了' }, 'bob')
  check('他人保存 → 403', r.status, 403)
  check('他人保存 → E-902', r.body.code, 'E-902')
  r = await call('POST', 'save', { id: d1.id, title: '我的第一篇 v2', body: '正文' }, 'alice')
  check('本人保存成功', r.body.data.title, '我的第一篇 v2')

  // 空正文的草稿不能发布
  const d2 = (await call('POST', 'create', { title: '空正文草稿' }, 'alice')).body.data
  r = await call('POST', 'publish', { id: d2.id }, 'alice')
  check('空正文不可发布', r.status, 400)
  check('空正文 → E-903', r.body.code, 'E-903')

  // d1 有正文 → 可发布
  r = await call('POST', 'publish', { id: d1.id }, 'alice')
  check('发布成功', r.body.data.status, 'published')
  r = await call('POST', 'save', { id: d1.id, title: '再改' }, 'alice')
  check('已发布不可改 → 409', r.status, 409)
  check('已发布 → E-901', r.body.code, 'E-901')

  console.log('\n=== 4 · 总线联动（任务验收 → 自动建草稿）===')
  const before = (await call('GET', 'list', undefined, 'alice')).body.data.total
  ctx.emit('dsh-training:tasks:task-accepted', {
    v: 1,
    id: 'ev-live-1',
    type: 'dsh-training:tasks:task-accepted',
    payload: { taskId: 't-20261024-0099', to: 'carol', coins: 20 },
    subject: { taskId: 't-20261024-0099' },
  })
  const after = (await call('GET', 'list', undefined, 'alice')).body.data.total
  check('总线事件后多一份草稿', after, before + 1)
  const auto = (await call('GET', 'list', undefined, 'carol')).body.data.drafts.find((d) => d.sourceTaskId === 't-20261024-0099')
  checkTrue('草稿归属领取人 carol', auto?.owner === 'carol', auto?.owner)
  ctx.emit('dsh-training:tasks:task-accepted', {
    v: 1,
    id: 'ev-live-1',
    type: 'dsh-training:tasks:task-accepted',
    payload: { taskId: 't-20261024-0099', to: 'carol' },
  })
  const after2 = (await call('GET', 'list', undefined, 'alice')).body.data.total
  check('重复事件幂等', after2, after)

  console.log('\n=== 4.5 · 手动补扫路由 ===')
  r = await call('POST', 'replay', {}, 'alice')
  check('replay 返回 ok', r.body.ok, true)
  checkTrue('replay 返回扫描数', typeof r.body.data.scanned === 'number')
  r = await call('GET', 'replay', undefined, 'alice')
  check('replay 只接受 POST', r.status, 405)

  console.log('\n=== 5 · 事件 ===')
  const types = events().map((e) => e.type)
  checkTrue('draft-opened 已发', types.includes('dsh-training:feature-workbench:draft-opened'))
  checkTrue('draft-saved 已发', types.includes('dsh-training:feature-workbench:draft-saved'))
  checkTrue('draft-published 已发', types.includes('dsh-training:feature-workbench:draft-published'))
  check('事件 source', events().find((e) => e.type.endsWith('draft-published'))?.source, 'feature-workbench')
} finally {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* ignore */
    }
  }
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
