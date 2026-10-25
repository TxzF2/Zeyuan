#!/usr/bin/env node
/** test-community-routes.mjs · 社区路由 / 可见性矩阵 / 权限 / 点赞 / 管理员 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-community-routes-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

/** 写控制面板用户表（社区 admin 现在按角色判定） */
function writeUsers(rows) {
  const dir = join(STATE, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'users.json'),
    JSON.stringify({ schemaVersion: 1, bootstrapAt: new Date().toISOString(), users: rows }, null, 2),
    'utf8',
  )
}
const trainee = (id) => ({ id, displayName: id, roles: ['trainee'], disabled: false, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
const adminUser = (id) => ({ ...trainee(id), roles: ['admin'] })

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-community/dist/license-gate.js')).href)
const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-community/dist/index.js')).href)

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
    listeners.get(type)?.(payload)
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
  const handler = routes.get(`/dsh-training/community/${path}`)
  if (!handler) throw new Error(`路由不存在：${path}`)
  const reqListeners = {}
  const req = {
    method,
    url: `/dsh-training/community/${path}${query}`,
    headers: actor ? { 'x-dsh-user': actor } : {},
    on(ev, cb) {
      reqListeners[ev] = cb
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
    if (body !== undefined) reqListeners.data?.(Buffer.from(JSON.stringify(body)))
    reqListeners.end?.()
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    return res
  })()
}

try {
  console.log('=== 1 · 注册与等级 ===')
  mod.apply(ctx)
  check('注册路由数', routes.size, 15)
  checkTrue('已订阅 draft-published', listeners.has('dsh-training:feature-workbench:draft-published'))
  let r = await call('GET', 'me', undefined, 'alice')
  check('未签署 → LV0', r.body.data.level, 'LV0')
  check('未签署 → 非管理员', r.body.data.isAdmin, false)
  r = await call('POST', 'draft', { title: 'x' }, 'alice')
  check('LV0 发帖 → 403', r.status, 403)
  check('LV0 → E-601', r.body.code, 'E-601')

  console.log('\n=== 2 · 签署后创建与可见性 ===')
  license.issueLicense({ subject: '测试学员', days: 30 })
  gate.resetAccessCache()
  r = await call('POST', 'draft', { title: '我的帖子', body: '正文', tags: ['公告'] }, 'alice')
  check('创建帖子草稿', r.body.data.status, 'draft')
  const p1 = r.body.data

  r = await call('GET', 'list', undefined, 'alice')
  check('作者能看到自己的草稿', r.body.data.total, 1)
  r = await call('GET', 'list', undefined, 'bob')
  check('他人看不到草稿', r.body.data.total, 0)
  r = await call('GET', 'detail', undefined, 'bob', `?id=${p1.id}`)
  check('他人看详情 → 404（不泄漏）', r.status, 404)
  r = await call('POST', 'save', { id: p1.id, title: '改标题' }, 'bob')
  check('他人保存 → 403', r.status, 403)
  r = await call('POST', 'save', { id: p1.id, title: '我的帖子 v2' }, 'alice')
  check('作者保存成功', r.body.data.title, '我的帖子 v2')

  console.log('\n=== 3 · 发布 ===')
  r = await call('POST', 'publish', { id: p1.id }, 'alice')
  check('发布成功', r.body.data.status, 'published')
  r = await call('GET', 'list', undefined, 'bob')
  check('发布后他人可见', r.body.data.total, 1)
  r = await call('POST', 'save', { id: p1.id, title: '再改' }, 'alice')
  check('已发布不可编辑 → 409', r.status, 409)
  check('已发布 → E-1001', r.body.code, 'E-1001')

  console.log('\n=== 4 · 点赞（不限身份，可 toggle）===')
  r = await call('POST', 'like', { id: p1.id }, 'bob')
  check('bob 点赞', r.body.data.liked, true)
  check('点赞数 1', r.body.data.post.likes, 1)
  r = await call('POST', 'like', { id: p1.id }, 'bob')
  check('再次点赞取消', r.body.data.liked, false)
  check('点赞数归零', r.body.data.post.likes, 0)
  r = await call('POST', 'like', { id: p1.id }, 'carol')
  check('carol 点赞', r.body.data.post.likes, 1)

  console.log('\n=== 5 · 草稿不可点赞 / 删除权限 ===')
  r = await call('POST', 'draft', { title: '草稿2', body: 'x' }, 'alice')
  const p2 = r.body.data
  r = await call('POST', 'like', { id: p2.id }, 'alice')
  check('草稿不能点赞 → 409', r.status, 409)
  r = await call('POST', 'delete', { id: p2.id }, 'bob')
  check('他人删除 → 403', r.status, 403)
  r = await call('POST', 'delete', { id: p2.id }, 'alice')
  check('作者删除成功', r.body.data.deleted, true)
  r = await call('GET', 'detail', undefined, 'alice', `?id=${p2.id}`)
  check('删除后 404', r.status, 404)

  console.log('\n=== 6 · 管理员隐藏（scope 校验）===')
  writeUsers([trainee('alice'), trainee('bob'), trainee('carol')])
  r = await call('POST', 'hide', { id: p1.id }, 'bob')
  check('非 admin 角色 → 403', r.status, 403)
  check('无权限 → E-1005', r.body.code, 'E-1005')

  writeUsers([trainee('alice'), trainee('bob'), trainee('carol'), adminUser('root')])
  r = await call('GET', 'me', undefined, 'root')
  check('admin 角色 → isAdmin', r.body.data.isAdmin, true)
  r = await call('POST', 'hide', { id: p1.id }, 'root')
  check('隐藏成功', r.body.data.status, 'hidden')
  // 注意：admin 判定来自**整机 license** 的 scope，不是按用户（当前单机模型）
  // 所以要先退回非 admin 许可，才能验证「隐藏后他人看不到」
  license.issueLicense({ subject: '普通学员', days: 30, scopes: ['training:playground'] })
  gate.resetAccessCache()
  r = await call('GET', 'me', undefined, 'bob')
  check('退回普通许可 → 非管理员', r.body.data.isAdmin, false)
  r = await call('GET', 'list', undefined, 'bob')
  check('隐藏后他人看不到', r.body.data.total, 0)
  r = await call('GET', 'list', undefined, 'alice')
  check('作者仍能看到（带 hidden 状态）', r.body.data.total, 1)
  check('作者看到的正是 hidden 状态', r.body.data.posts[0].status, 'hidden')

  // 恢复管理员许可，测试恢复隐藏
  license.issueLicense({ subject: '管理员', days: 30, scopes: ['training:playground', 'training:admin'] })
  gate.resetAccessCache()
  r = await call('GET', 'list', undefined, 'root')
  check('管理员能看到隐藏帖', r.body.data.total, 1)
  r = await call('POST', 'unhide', { id: p1.id }, 'root')
  check('恢复成功', r.body.data.status, 'published')

  console.log('\n=== 7 · 总线联动（草稿发布 → 帖子草稿）===')
  // 退回普通许可：验证「他人看不到别人的帖子草稿」
  license.issueLicense({ subject: '普通学员', days: 30, scopes: ['training:playground'] })
  gate.resetAccessCache()
  mkdirSync(join(STATE, 'data'), { recursive: true })
  writeFileSync(
    join(STATE, 'data', 'drafts.json'),
    JSON.stringify(
      { schemaVersion: 1, updatedAt: new Date().toISOString(), seq: 1, drafts: [{ id: 'd-x', title: '来自工作台', body: '内容', tags: ['t'], owner: 'dave' }], consumed: [] },
      null,
      2,
    ),
    'utf8',
  )
  const before = (await call('GET', 'list', undefined, 'dave')).body.data.total
  ctx.emit('dsh-training:feature-workbench:draft-published', {
    v: 1,
    id: 'ev-x',
    type: 'dsh-training:feature-workbench:draft-published',
    payload: { draftId: 'd-x', owner: 'dave' },
  })
  const after = (await call('GET', 'list', undefined, 'dave')).body.data.total
  check('自动生成帖子草稿', after, before + 1)
  const auto = (await call('GET', 'list', undefined, 'dave')).body.data.posts.find((p) => p.sourceDraftId === 'd-x')
  check('自动稿状态 draft（不直接公开）', auto?.status, 'draft')
  check('自动稿标题继承草稿', auto?.title, '来自工作台')
  check('他人看不到自动稿', (await call('GET', 'list', undefined, 'alice')).body.data.posts.some((p) => p.sourceDraftId === 'd-x'), false)

  console.log('\n=== 8 · replay 幂等 ===')
  const r1 = await call('POST', 'replay', {}, 'dave')
  check('replay 可用', r1.status, 200)
  const r2 = await call('POST', 'replay', {}, 'dave')
  check('replay 幂等', r2.body.data.created, 0)
  checkTrue('replay 只接受 POST', (await call('GET', 'replay', undefined, 'dave')).status === 405)
} finally {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(STATE, 'event-log.jsonl'))) {
    const types = readFileSync(join(STATE, 'event-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).type)
    checkTrue('post-drafted 已发', types.includes('dsh-training:feature-community:post-drafted'))
    checkTrue('post-published 已发', types.includes('dsh-training:feature-community:post-published'))
    checkTrue('post-liked 已发', types.includes('dsh-training:feature-community:post-liked'))
    checkTrue('post-hidden 已发', types.includes('dsh-training:feature-community:post-hidden'))
    checkTrue('post-deleted 已发', types.includes('dsh-training:feature-community:post-deleted'))
  }
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
