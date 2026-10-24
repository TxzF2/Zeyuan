#!/usr/bin/env node
/** test-console-routes.mjs · 控制台 20 路由 × 权限矩阵（LV0/LV1 + P0/P6/P7/P8） */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASE = mkdtempSync(join(tmpdir(), 'dsh-console-routes-'))
const STATE = join(BASE, 'state')
const PROFILE = join(BASE, 'profile')
mkdirSync(STATE, { recursive: true })
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_TRAINING_PROFILE_DIR = PROFILE
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
mkdirSync(join(STATE, 'app', 'plugins', 'dsh-training-tasks', 'dist'), { recursive: true })
writeFileSync(join(STATE, 'app', 'plugins', 'dsh-training-tasks', 'dist', 'index.js'), 'export function apply(){}\n', 'utf8')

const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/index.js')).href)
const audit = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/audit.js')).href)

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
  const L = {}
  const req = {
    method,
    url: `/dsh-training/console/${path}`,
    headers: actor ? { 'x-dsh-user': actor } : {},
    on(ev, cb) {
      L[ev] = cb
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
    if (body !== undefined) L.data?.(Buffer.from(JSON.stringify(body)))
    L.end?.()
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    return res
  })()
}

const auditRows = () => audit.listAudit(200).rows

try {
  console.log('=== 1 · 注册 ===')
  mod.apply(ctx)
  check('路由数 22', routes.size, 22)
  let r = await call('GET', 'me', undefined, 'alice')
  check('初始 P0', r.body.data.adminTier, 0)
  check('无 license → LV0', r.body.data.businessLevel, 'LV0')

  console.log('\n=== 2 · bootstrap ===')
  r = await call('POST', 'bootstrap', { confirm: true }, 'alice')
  check('缺 reason → 400', r.status, 400)
  r = await call('POST', 'bootstrap', { confirm: true, reason: '初始化总师' }, 'alice')
  check('bootstrap 成功', r.status, 200)
  check('alice 为 P8', r.body.data.tier, 8)
  r = await call('POST', 'bootstrap', { confirm: true, reason: '再次初始化尝试' }, 'eve')
  check('重复 bootstrap → 409', r.status, 409)
  r = await call('GET', 'me', undefined, 'alice')
  check('capabilities.grantCoins', r.body.data.capabilities.grantCoins, true)

  console.log('\n=== 3 · P0 越权 ===')
  for (const [path, method] of [['dashboard', 'GET'], ['audit', 'GET'], ['boards', 'GET'], ['users', 'GET']]) {
    const res = await call(method, path, undefined, 'dave')
    check(`P0 ${path} → 403`, res.status, 403)
  }
  r = await call('GET', 'health', undefined, 'dave')
  check('P0 可看 health', r.status, 200)

  console.log('\n=== 4 · 用户与档位 ===')
  r = await call('POST', 'users/create', { id: 'bob', displayName: '鲍勃' }, 'alice')
  check('建 bob', r.status, 200)
  r = await call('POST', 'admins/grant', { id: 'bob', tier: 7, confirm: true, reason: '项目负责人授权' }, 'alice')
  check('授 bob P7', r.body.data.tier, 7)
  r = await call('POST', 'admins/grant', { id: 'carol', tier: 6, confirm: true, reason: '工作区负责人授权' }, 'alice')
  check('授 carol P6', r.body.data.tier, 6)
  r = await call('POST', 'admins/grant', { id: 'carol', tier: 8, confirm: true, reason: '尝试越级授权' }, 'bob')
  check('P7 授 P8 → 403', r.status, 403)
  check('→ E-1202', r.body.code, 'E-1202')
  r = await call('POST', 'admins/revoke', { id: 'alice', confirm: true, reason: '自锁保护测试' }, 'alice')
  check('撤销最后 P8 → 409', r.status, 409)
  check('→ E-1215', r.body.code, 'E-1215')

  console.log('\n=== 5 · scope 下发 ===')
  r = await call('POST', 'scopes/grant', { id: 'bob', scope: 'training:admin', confirm: true, reason: '尝试越级下发' }, 'bob')
  check('P7 发 admin → 403', r.status, 403)
  r = await call('POST', 'scopes/grant', { id: 'bob', scope: 'training:review', confirm: true, reason: '评审权限' }, 'bob')
  check('P7 发 review 成功', r.status, 200)
  r = await call('POST', 'scopes/grant', { id: 'carol', scope: 'training:admin', confirm: true, reason: '授予管理员' }, 'alice')
  check('P8 发 admin 成功', r.status, 200)
  r = await call('GET', 'scopes', undefined, 'carol')
  checkTrue('scope 列表含 carol', r.body.data.some((x) => x.userId === 'carol'), JSON.stringify(r.body.data))

  console.log('\n=== 6 · 板块启停（真写 profile）===')
  r = await call('POST', 'boards/toggle', { board: 'tasks', enabled: true, confirm: true, reason: '启用任务板块' }, 'carol')
  check('P6 启用 tasks 成功', r.status, 200)
  check('返回 restartRequired', r.body.data.restartRequired, true)
  const profileOn = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  check('profile 写入 tasks 依赖', 'dsh-training-tasks' in profileOn.dependencies, true)
  check('profile bundles 含 tasks', profileOn.dsh.profile.bundles.includes('dsh-training-tasks'), true)

  r = await call('POST', 'boards/toggle', { board: 'tasks', enabled: false, confirm: true, reason: '维护任务板块' }, 'carol')
  check('P6 停 tasks 成功', r.status, 200)
  const profileOff = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  check('profile 已移除 tasks 依赖', 'dsh-training-tasks' in profileOff.dependencies, false)

  r = await call('POST', 'boards/toggle', { board: 'core', enabled: false, confirm: true, reason: '尝试停核心' }, 'carol')
  check('P6 停 core → 409', r.status, 409)
  check('→ E-1106', r.body.code, 'E-1106')
  const coreAudit = auditRows().find((x) => x.action === 'board-toggle' && x.target === 'core')
  checkTrue('core 停用尝试已入审计', Boolean(coreAudit), JSON.stringify(coreAudit))
  check('审计记录失败结果', coreAudit?.result, 'error')
  checkTrue('审计记录原因', coreAudit?.reason === '尝试停核心', coreAudit?.reason)

  r = await call('POST', 'boards/toggle', { board: 'tasks', enabled: true, confirm: true, reason: '恢复任务板块' }, 'carol')
  check('恢复 tasks', r.status, 200)
  check(
    'profile 重新写入依赖',
    'dsh-training-tasks' in JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies,
    true,
  )

  console.log('\n=== 7 · 钱包 ===')
  r = await call('POST', 'wallet/grant', { id: 'bob', amount: 100, confirm: true, reason: '新人奖励发放' }, 'carol')
  check('P6 发币 → 403', r.status, 403)
  r = await call('POST', 'wallet/grant', { id: 'bob', amount: 100, confirm: true, reason: '新人奖励' }, 'alice')
  check('P8 发币成功', r.status, 200)
  check('余额 100', r.body.data.balance, 100)
  r = await call('GET', 'wallet/balance', undefined, 'alice')
  check('查询余额接口', r.status, 200)
  r = await call('GET', 'wallet/ledger', undefined, 'alice')
  check('流水非空', r.body.data.length >= 1, true)

  console.log('\n=== 8 · 审计与仪表盘 ===')
  r = await call('GET', 'audit', undefined, 'alice')
  checkTrue('审计有记录', r.body.data.total > 0, String(r.body.data.total))
  const actions = r.body.data.rows.map((x) => x.action)
  checkTrue('含 bootstrap', actions.includes('bootstrap'))
  checkTrue('含 board-toggle', actions.includes('board-toggle'))
  checkTrue('含 coins-grant', actions.includes('coins-grant'))
  checkTrue('含 scope-grant', actions.includes('scope-grant'))
  r = await call('GET', 'dashboard', undefined, 'alice')
  check('仪表盘可读', r.status, 200)
  checkTrue('含在线用户字段', typeof r.body.data.online.current === 'number')
  checkTrue('含金币字段', typeof r.body.data.coins.today === 'number')
  r = await call('GET', 'health', undefined, 'alice')
  checkTrue('健康含对账', typeof r.body.data.reconcile.ok === 'boolean')

  console.log('\n=== 9 · 高危缺确认 ===')
  r = await call('POST', 'boards/toggle', { board: 'tasks', enabled: false }, 'carol')
  check('缺 confirm → 400', r.status, 400)
  check('→ E-1203', r.body.code, 'E-1203')
  const missing = auditRows().find((x) => x.action === 'board-toggle' && x.result === 'error' && x.target === 'tasks')
  checkTrue('缺确认也入审计（error）', Boolean(missing))
} finally {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* ignore */
    }
  }
  rmSync(BASE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
