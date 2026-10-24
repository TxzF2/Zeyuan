#!/usr/bin/env node
/** test-collab-routes.mjs · 分组路由（建组/加入/满编/激活/权限/评审/金币申请）+ 金币审批 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASE = mkdtempSync(join(tmpdir(), 'dsh-collab-routes-'))
const STATE = join(BASE, 'state')
const PROFILE = join(BASE, 'profile')
mkdirSync(STATE, { recursive: true })
mkdirSync(PROFILE, { recursive: true })
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_TRAINING_PROFILE_DIR = PROFILE
mkdirSync(join(STATE, 'data'), { recursive: true })

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-collab/dist/license-gate.js')).href)
const collab = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-collab/dist/index.js')).href)
const consoleMod = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/index.js')).href)
const consoleGate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/license-gate.js')).href)
const wallet = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/wallet.js')).href)
const admins = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/admins.js')).href)

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

function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect(fn) {
      const d = fn()
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
  return { ctx, routes }
}

function caller(routes, prefix) {
  return async function call(method, path, body, actor) {
    const [routePath, query] = String(path).split('?')
    const handler = routes.get(`${prefix}/${routePath}`)
    if (!handler) throw new Error(`路由不存在：${path}`)
    const L = {}
    const req = { method, url: `${prefix}/${routePath}${query ? '?' + query : ''}`, headers: actor ? { 'x-dsh-user': actor } : {}, on(ev, cb) { L[ev] = cb } }
    const res = { status: 0, body: null, writeHead(s) { res.status = s }, end(b) { res.body = b ? JSON.parse(b) : null } }
    const p = Promise.resolve(handler(req, res))
    await new Promise((r) => setTimeout(r, 0))
    if (body !== undefined) L.data?.(Buffer.from(JSON.stringify(body)))
    L.end?.()
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    return res
  }
}

try {
  license.issueLicense({ subject: '学员', days: 30 })
  gate.resetAccessCache()
  consoleGate.resetAccessCache()

  const { ctx, routes } = makeCtx()
  collab.apply(ctx)
  const call = caller(routes, '/dsh-training/collab')
  check('collab 路由数 17', routes.size, 17)

  console.log('=== 1 · 建组与加入 ===')
  let r = await call('POST', 'group/create', { name: '第一小组', topic: '结项' }, 'bob')
  check('建组成功', r.status, 200)
  const gid = r.body.data.id
  check('1 人（组长）', r.body.data.members.length, 1)
  r = await call('POST', 'group/create', { name: '第二组' }, 'bob')
  check('重复建组 → 409', r.status, 409)
  for (const [u, d] of [['alice', 'training'], ['carol', 'ops']]) {
    r = await call('POST', 'group/join', { id: gid, duty: d }, u)
    check(`${u} 加入`, r.status, 200)
  }
  r = await call('POST', 'group/join', { id: gid, duty: 'build' }, 'dave')
  check('dave 加入至满编', r.body.data.members.length, 4)
  r = await call('POST', 'group/join', { id: gid, duty: 'ops' }, 'eve')
  check('满编后加入 → 409', r.status, 409)
  check('→ E-1301', r.body.code, 'E-1301')
  r = await call('GET', `group/ready?id=${gid}`)
  check('ready 可激活', r.body.data.canActivate.ok, true)

  console.log('\n=== 2 · 激活与权限 ===')
  r = await call('POST', 'group/activate', { id: gid }, 'alice')
  check('非组长激活 → 403', r.status, 403)
  r = await call('POST', 'group/activate', { id: gid }, 'bob')
  check('组长激活成功', r.body.data.status, 'active')
  r = await call('POST', 'group/duty', { id: gid, user: 'alice', duty: '运营' }, 'alice')
  check('组员改分工 → 403', r.status, 403)
  r = await call('POST', 'group/duty', { id: gid, user: 'alice', duty: '运营' }, 'bob')
  check('组长改分工成功', r.status, 200)
  r = await call('POST', 'group/leave', { id: gid }, 'bob')
  check('组长直接退出 → 409', r.status, 409)

  console.log('\n=== 3 · 评审批次 ===')
  r = await call('POST', 'review/request', { groupId: gid, draftId: 'd-1' }, 'alice')
  check('组员发起评审', r.status, 200)
  const rid = r.body.data.reviewRequests.at(-1).id
  r = await call('POST', 'review/done', { groupId: gid, reviewId: rid }, 'carol')
  check('组员完成评审', r.status, 200)
  r = await call('POST', 'review/request', { groupId: gid, draftId: 'd-2' }, 'ghost')
  check('非成员评审 → 403', r.status, 403)

  console.log('\n=== 4 · 金币申请（组长；不碰钱包）===')
  r = await call('POST', 'coin-request', { groupId: gid, amount: 100, reason: '组内结项奖金' }, 'alice')
  check('组员申请 → 403', r.status, 403)
  r = await call('POST', 'coin-request', { groupId: gid, amount: 100, reason: '组内结项奖金' }, 'bob')
  check('组长申请成功', r.status, 200)
  const crId = r.body.data.id
  check('单据 pending', r.body.data.status, 'pending')
  check('钱包未被组长改动', wallet.balanceOf('bob'), 0)
  r = await call('GET', `coin-requests?groupId=${gid}`)
  check('申请列表可见', r.body.data.length, 1)

  console.log('\n=== 5 · 控制台审批（P7+；通过才入账）===')
  const { ctx: cctx, routes: croutes } = makeCtx()
  consoleMod.apply(cctx)
  const ccall = caller(croutes, '/dsh-training/console')
  check('console 路由数 22', croutes.size, 22)
  r = await ccall('GET', 'coin-requests', undefined, 'bob')
  check('P0 看申请 → 403', r.status, 403)
  admins.grantTier('root', 8, 'root', 8, 'test')
  r = await ccall('POST', 'coin-requests/review', { id: crId, approve: true, confirm: true, reason: '组经费审批通过' }, 'root')
  check('P8 审批通过', r.status, 200)
  check('单据 approved', r.body.data.status, 'approved')
  check('钱包到账 100（发给组长）', wallet.balanceOf('bob'), 100)
  r = await ccall('POST', 'coin-requests/review', { id: crId, approve: true, confirm: true, reason: '重复审批' }, 'root')
  check('重复审批 → 409', r.status, 409)
  check('余额未重复增加', wallet.balanceOf('bob'), 100)
  const auditFile = join(STATE, 'data', 'audit-log.jsonl')
  checkTrue('审批已入审计', existsSync(auditFile) && readFileSync(auditFile, 'utf8').includes('coin-request-approve'))
} finally {
  rmSync(BASE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
