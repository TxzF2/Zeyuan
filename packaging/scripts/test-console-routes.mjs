#!/usr/bin/env node
/** test-console-routes.mjs · 控制面板路由 / bootstrap / 权限矩阵 / 审计 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-routes-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/index.js')).href)

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

function call(method, path, body, actor) {
  const handler = routes.get(`/dsh-training/console/${path}`)
  if (!handler) throw new Error(`路由不存在：${path}`)
  const reqL = {}
  const req = {
    method,
    url: `/dsh-training/console/${path}`,
    headers: actor ? { 'x-dsh-user': actor } : {},
    on(ev, cb) {
      reqL[ev] = cb
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
    if (body !== undefined) reqL.data?.(Buffer.from(JSON.stringify(body)))
    reqL.end?.()
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    return res
  })()
}

try {
  console.log('=== 1 · 注册与身份自动登记 ===')
  mod.apply(ctx)
  check('注册路由数', routes.size, 11)
  let r = await call('GET', 'me', undefined, 'alice')
  check('me 返回身份', r.body.data.user, 'alice')
  check('默认角色 trainee', r.body.data.roles.join(','), 'trainee')
  check('非管理员', r.body.data.isAdmin, false)

  console.log('\n=== 2 · bootstrap ===')
  r = await call('POST', 'bootstrap', { confirm: false }, 'root')
  check('缺 confirm → 400', r.status, 400)
  r = await call('POST', 'bootstrap', { confirm: true }, 'root')
  check('bootstrap 成功', r.body.data.roles.includes('admin'), true)
  r = await call('POST', 'bootstrap', { confirm: true }, 'other')
  check('重复 bootstrap → 409', r.status, 409)
  check('重复 bootstrap → E-1101', r.body.code, 'E-1101')

  console.log('\n=== 3 · 权限矩阵 ===')
  for (const [path, method] of [['users', 'GET'], ['users/create', 'POST'], ['users/role', 'POST'], ['users/disable', 'POST'], ['boards/toggle', 'POST'], ['audit', 'GET']]) {
    const res = await call(method, path, method === 'GET' ? undefined : {}, 'alice')
    check(`非管理员 ${path} → 403`, res.status, 403)
  }
  r = await call('GET', 'dashboard', undefined, 'alice')
  check('非管理员可看仪表盘', r.status, 200)
  r = await call('GET', 'boards', undefined, 'alice')
  check('非管理员可看板块状态', r.status, 200)
  r = await call('GET', 'health', undefined, 'alice')
  check('健康检查可读', r.status, 200)

  console.log('\n=== 4 · 用户管理（admin）===')
  r = await call('POST', 'users/create', { id: 'bob', displayName: '鲍勃' }, 'root')
  check('建用户', r.status, 200)
  r = await call('POST', 'users/create', { id: 'bob' }, 'root')
  check('重复建用户 → 409', r.status, 409)
  r = await call('GET', 'users', undefined, 'root')
  checkTrue('用户表含 bob', r.body.data.users.some((u) => u.id === 'bob'))

  // 仅 root 一个 admin 时：撤销/禁用都应被拒（防自锁）
  r = await call('POST', 'users/role', { id: 'root', role: 'admin', grant: false }, 'root')
  check('撤销最后一个 admin → 409', r.status, 409)
  check('→ E-1107', r.body.code, 'E-1107')
  r = await call('POST', 'users/disable', { id: 'root', disabled: true }, 'root')
  check('禁用最后一个 admin → 409', r.status, 409)

  // 授予 bob admin → 此时两个 admin，撤 root 允许，但保留 root 便于后续用例
  r = await call('POST', 'users/role', { id: 'bob', role: 'admin', grant: true }, 'root')
  check('授予 bob admin', r.body.data.roles.includes('admin'), true)
  r = await call('GET', 'me', undefined, 'bob')
  check('bob 现在是 admin', r.body.data.isAdmin, true)

  // 禁用 bob → bob 自己的请求被拒（E-1108）
  r = await call('POST', 'users/disable', { id: 'bob', disabled: true }, 'root')
  check('禁用 bob', r.body.data.disabled, true)
  r = await call('GET', 'me', undefined, 'bob')
  check('被禁用身份 → 403', r.status, 403)
  check('→ E-1108', r.body.code, 'E-1108')
  r = await call('POST', 'users/disable', { id: 'bob', disabled: false }, 'root')
  check('恢复 bob', r.body.data.disabled, false)

  // 撤销 bob 的 admin（root 仍在，属允许）
  r = await call('POST', 'users/role', { id: 'bob', role: 'admin', grant: false }, 'root')
  check('撤销 bob admin', r.body.data.roles.includes('admin'), false)

  console.log('\n=== 5 · 板块开关 ===')
  r = await call('GET', 'boards', undefined, 'root')
  checkTrue('返回板块列表', Array.isArray(r.body.data) && r.body.data.length > 0)
  r = await call('POST', 'boards/toggle', { id: 'tasks', enabled: false }, 'root')
  check('停用 tasks', r.status, 200)
  check('落盘 enabled.tasks', r.body.data.enabled.tasks, false)
  r = await call('POST', 'boards/toggle', { id: 'core', enabled: false }, 'root')
  check('停用 core → 409', r.status, 409)
  check('→ E-1106', r.body.code, 'E-1106')
  r = await call('POST', 'boards/toggle', { id: 'tasks', enabled: true }, 'root')
  check('重新启用 tasks', r.status, 200)

  console.log('\n=== 6 · 审计 ===')
  r = await call('GET', 'audit', undefined, 'root')
  checkTrue('审计有记录', r.body.data.total > 0, String(r.body.data.total))
  const types = r.body.data.rows.map((x) => x.type)
  checkTrue('包含 bootstrap', types.some((t) => t.endsWith('admin-bootstrapped')))
  checkTrue('包含角色变更', types.some((t) => t.endsWith('user-role-changed')))
  checkTrue('包含板块开关', types.some((t) => t.endsWith('board-toggled')))
  checkTrue('最新在前', r.body.data.rows[0].at >= r.body.data.rows[r.body.data.rows.length - 1].at)
} finally {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(STATE, 'mount-events.jsonl'))) {
    checkTrue('挂载事件已写', true)
  }
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
