#!/usr/bin/env node
/**
 * test-tasks-routes.mjs · 任务接发 REST 路由（权限闸门 + 状态机 + 事件）
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-tasks-routes-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-tasks/dist/license-gate.js')).href)
const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-tasks/dist/index.js')).href)

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

// ---------- 假 ctx / 路由表 ----------
const routes = new Map()
const disposers = []
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  },
  on() {},
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

// ---------- 假 req/res ----------
function call(method, path, body, actor, query = '') {
  const handler = routes.get(`/dsh-training/tasks/${path}`)
  if (!handler) throw new Error(`路由不存在：${path}`)
  const chunks = []
  const listeners = {}
  const req = {
    method,
    url: `/dsh-training/tasks/${path}${query}`,
    headers: actor ? { 'x-dsh-user': actor } : {},
    on(ev, cb) {
      listeners[ev] = cb
      return req
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
  const p = Promise.resolve(handler(req, res)).then(() => {
    if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
    return new Promise((r) => setTimeout(r, 5)).then(() => res)
  })
  // 需要先投递 body 再等 end：handler 内部是 await readBody，所以按顺序触发
  return (async () => {
    // 触发读取流程
    await new Promise((r) => setTimeout(r, 0))
    if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
    await new Promise((r) => setTimeout(r, 10))
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
  console.log('=== 1 · 注册与身份 ===')
  mod.apply(ctx)
  check('注册路由数', routes.size, 10)
  checkTrue('/list 已注册', routes.has('/dsh-training/tasks/list'))
  checkTrue('/accept 已注册', routes.has('/dsh-training/tasks/accept'))

  let r = await call('GET', 'me', undefined, 'alice')
  check('未签署 → LV0', r.body.data.level, 'LV0')
  check('未签署 → E-601', r.body.data.code, 'E-601')
  check('默认身份', r.body.data.user, 'alice')

  console.log('\n=== 2 · LV0 拦截 ===')
  r = await call('POST', 'create', { title: '未签署时创建' }, 'alice')
  check('LV0 创建 → 403', r.status, 403)
  check('LV0 创建 → E-601', r.body.code, 'E-601')

  console.log('\n=== 3 · 签署后 LV1 ===')
  license.issueLicense({ subject: '测试学员', days: 30 })
  gate.resetAccessCache()
  r = await call('GET', 'me', undefined, 'bob')
  check('签署后 → LV1', r.body.data.level, 'LV1')

  r = await call('POST', 'create', { title: '补三个案例', description: '给手册补案例', tags: ['文档'], bounty: 50 }, 'bob')
  check('创建成功', r.body.ok, true)
  const t1 = r.body.data
  check('初始状态 open', t1.status, 'open')
  check('creator=bob', t1.creator, 'bob')
  check('id 形如 t-YYYYMMDD-NNNN', /^t-\d{8}-\d{4}$/.test(t1.id), true)

  r = await call('POST', 'create', { title: '' }, 'bob')
  check('非法字段 → 400', r.status, 400)
  check('非法字段 → E-803', r.body.code, 'E-803')

  console.log('\n=== 4 · 列表与详情 ===')
  r = await call('GET', 'list', undefined, 'bob')
  check('列表总数', r.body.data.total, 1)
  check('标签聚合', r.body.data.tags.join(','), '文档')
  r = await call('GET', 'list', undefined, 'bob', '?status=open&tag=文档')
  check('筛选命中', r.body.data.total, 1)
  r = await call('GET', 'list', undefined, 'bob', '?status=claimed')
  check('筛选不命中', r.body.data.total, 0)
  r = await call('GET', 'detail', undefined, 'bob', `?id=${t1.id}`)
  check('详情返回标题', r.body.data.title, '补三个案例')
  r = await call('GET', 'detail', undefined, 'bob', '?id=nope')
  check('详情不存在 → 404', r.status, 404)
  check('详情不存在 → E-804', r.body.code, 'E-804')

  console.log('\n=== 5 · 领取（权限 + 状态机）===')
  r = await call('POST', 'claim', { id: t1.id }, 'bob')
  check('不能领自己任务 → 403', r.status, 403)
  check('不能领自己任务 → E-802', r.body.code, 'E-802')

  r = await call('POST', 'claim', { id: t1.id }, 'alice')
  check('他人可领取', r.body.data.status, 'claimed')
  check('assignee=alice', r.body.data.assignee, 'alice')

  r = await call('POST', 'claim', { id: t1.id }, 'carol')
  check('重复领取 → 409', r.status, 409)
  check('重复领取 → E-801', r.body.code, 'E-801')

  console.log('\n=== 6 · 提交与验收 ===')
  r = await call('POST', 'submit', { id: t1.id }, 'bob')
  check('非领取人提交 → 403', r.status, 403)
  r = await call('POST', 'submit', { id: t1.id }, 'alice')
  check('领取人提交成功', r.body.data.status, 'submitted')

  r = await call('POST', 'accept', { id: t1.id }, 'alice')
  check('非发起人验收 → 403', r.status, 403)
  r = await call('POST', 'accept', { id: t1.id }, 'bob')
  check('发起人验收成功', r.body.data.status, 'accepted')

  console.log('\n=== 7 · 事件 ===')
  const evs = events()
  const types = evs.map((e) => e.type)
  checkTrue('task-created 已发', types.includes('dsh-training:tasks:task-created'))
  checkTrue('task-claimed 已发', types.includes('dsh-training:tasks:task-claimed'))
  checkTrue('task-submitted 已发', types.includes('dsh-training:tasks:task-submitted'))
  checkTrue('task-accepted 已发', types.includes('dsh-training:tasks:task-accepted'))
  const reward = evs.find((e) => e.type === 'dsh-training:tasks:reward')
  checkTrue('reward 事件已发', Boolean(reward))
  check('reward.coins = 赏金', reward?.payload.coins, 50)
  check('reward.to = 领取人', reward?.payload.to, 'alice')
  check('reward.from = 发起人', reward?.payload.from, 'bob')
  check('事件带信封版本', reward?.v, 1)
  check('事件 source=tasks', reward?.source, 'tasks')

  console.log('\n=== 8 · 驳回后可再领取 ===')
  r = await call('POST', 'create', { title: '第二个任务', bounty: 10 }, 'bob')
  const t2 = r.body.data
  await call('POST', 'claim', { id: t2.id }, 'alice')
  await call('POST', 'submit', { id: t2.id }, 'alice')
  r = await call('POST', 'reject', { id: t2.id, reason: '不合格' }, 'bob')
  check('驳回后回到 open', r.body.data.status, 'open')
  check('驳回清空 assignee', r.body.data.assignee, null)
  check('驳回记录原因', r.body.data.history.at(-1).reason, '不合格')
  r = await call('POST', 'claim', { id: t2.id }, 'carol')
  check('驳回后可被别人领取', r.body.data.assignee, 'carol')

  console.log('\n=== 9 · 吊销后回到 LV0 ===')
  license.revokeLicense()
  gate.resetAccessCache()
  r = await call('POST', 'claim', { id: t2.id }, 'dave')
  check('吊销后领取 → 403', r.status, 403)
  check('吊销后 → E-601', r.body.code, 'E-601')
  r = await call('GET', 'list', undefined, 'bob')
  check('吊销后仍可浏览列表', r.body.ok, true)
} finally {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* ignore */
    }
  }
  const mountEvents = existsSync(join(STATE, 'mount-events.jsonl'))
    ? readFileSync(join(STATE, 'mount-events.jsonl'), 'utf8').trim().split('\n')
    : []
  checkTrue('挂载事件已写（mounted + unmounted）', mountEvents.length >= 2, `实际 ${mountEvents.length}`)
  checkTrue('挂载事件 plugin 名正确', mountEvents[0]?.includes('dsh-training-tasks'))
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
