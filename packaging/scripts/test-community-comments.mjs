#!/usr/bin/env node
/** test-community-comments.mjs · 一级评论（LV1 发/作者删/P6+ 隐藏/可见性/事件不带正文） */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-comments-'))
process.env.DSH_TRAINING_STATE_DIR = STATE
mkdirSync(join(STATE, 'data'), { recursive: true })

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-community/dist/license-gate.js')).href)
const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-community/dist/index.js')).href)

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
const ctx = { effect(fn) { return fn() }, on() {}, inject(d, cb) { cb({ effect: ctx.effect, webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } } }) } }

async function call(method, path, body, actor) {
  const [p, q] = String(path).split('?')
  const handler = routes.get(`/zeyuan/community/${p}`)
  if (!handler) throw new Error(`路由不存在：${path}`)
  const L = {}
  const req = { method, url: `/zeyuan/community/${p}${q ? '?' + q : ''}`, headers: actor ? { 'x-dsh-user': actor } : {}, on(ev, cb) { L[ev] = cb } }
  const res = { status: 0, body: null, writeHead(s) { res.status = s }, end(b) { res.body = b ? JSON.parse(b) : null } }
  const pr = Promise.resolve(handler(req, res))
  await new Promise((r) => setTimeout(r, 0))
  if (body !== undefined) L.data?.(Buffer.from(JSON.stringify(body)))
  L.end?.()
  await pr.catch(() => {})
  await new Promise((r) => setTimeout(r, 5))
  return res
}

const events = () =>
  existsSync(join(STATE, 'event-log.jsonl'))
    ? readFileSync(join(STATE, 'event-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []

try {
  console.log('=== 0 · 准备：帖子 + 权限 ===')
  mod.apply(ctx)
  check('community 路由数 15', routes.size, 15)

  let r = await call('POST', 'draft', { title: '帖子', body: 'x' }, 'bob')
  check('未签 → 发帖 403', r.status, 403)

  license.issueLicense({ subject: '学员', days: 30 })
  gate.resetAccessCache()
  r = await call('POST', 'draft', { title: '帖子', body: '正文' }, 'bob')
  const post = r.body.data
  await call('POST', 'publish', { id: post.id }, 'bob')
  writeFileSync(join(STATE, 'data', 'admins.json'), JSON.stringify({ schemaVersion: 1, admins: [{ userId: 'mod', tier: 6 }] }), 'utf8')
  checkTrue('准备完成', Boolean(post.id))

  console.log('\n=== 1 · 发评论（LV1）===')
  r = await call('POST', 'comments/add', { postId: post.id, body: '  第一条评论  ' }, 'alice')
  check('发评论成功', r.status, 200)
  const c1 = r.body.data
  check('正文已 trim', c1.body, '第一条评论')
  check('初始 visible', c1.status, 'visible')
  check('空评论 → 400', (await call('POST', 'comments/add', { postId: post.id, body: '   ' }, 'alice')).status, 400)
  check('超长 → 400', (await call('POST', 'comments/add', { postId: post.id, body: 'x'.repeat(501) }, 'alice')).status, 400)

  console.log('\n=== 2 · 列表与时间序 ===')
  await call('POST', 'comments/add', { postId: post.id, body: '第二条' }, 'carol')
  r = await call('GET', `comments?postId=${post.id}`, undefined, 'alice')
  check('列表 2 条', r.body.data.total, 2)
  check('时间正序（第一条在前）', r.body.data.comments[0].body, '第一条评论')
  check('作者可删标记', r.body.data.comments[0].canDelete, true)
  check('非作者无删标记', r.body.data.comments[1].canDelete, false)
  check('普通用户 canHide=false', r.body.data.comments[0].canHide, false)

  console.log('\n=== 3 · 软删（仅作者）===')
  check('非作者删 → 403', (await call('POST', 'comments/delete', { id: c1.id }, 'carol')).status, 403)
  r = await call('POST', 'comments/delete', { id: c1.id }, 'alice')
  check('作者删除成功', r.body.data.status, 'deleted')
  r = await call('GET', `comments?postId=${post.id}`, undefined, 'alice')
  check('列表只剩 1 条', r.body.data.total, 1)
  const raw = JSON.parse(readFileSync(join(STATE, 'data', 'comments.json'), 'utf8'))
  check('软删记录保留', raw.comments.find((c) => c.id === c1.id).status, 'deleted')
  check('重复删除 → 404', (await call('POST', 'comments/delete', { id: c1.id }, 'alice')).status, 404)

  console.log('\n=== 4 · P6 隐藏与可见性 ===')
  const c2 = (await call('GET', `comments?postId=${post.id}`, undefined, 'alice')).body.data.comments[0]
  check('普通用户隐藏 → 403', (await call('POST', 'comments/hide', { id: c2.id }, 'alice')).status, 403)
  r = await call('POST', 'comments/hide', { id: c2.id, hidden: true }, 'mod')
  check('P6 隐藏成功', r.body.data.status, 'hidden')
  check('他人看不到', (await call('GET', `comments?postId=${post.id}`, undefined, 'bob')).body.data.total, 0)
  check('作者仍可见', (await call('GET', `comments?postId=${post.id}`, undefined, 'carol')).body.data.total, 1)
  check('P6 可见', (await call('GET', `comments?postId=${post.id}`, undefined, 'mod')).body.data.total, 1)
  r = await call('POST', 'comments/hide', { id: c2.id, hidden: false }, 'mod')
  check('恢复 visible', r.body.data.status, 'visible')
  check('恢复后他人可见', (await call('GET', `comments?postId=${post.id}`, undefined, 'bob')).body.data.total, 1)

  console.log('\n=== 5 · 帖子不可见 → 评论 404 ===')
  r = await call('POST', 'draft', { title: '草稿帖', body: 'x' }, 'bob')
  const draftId = r.body.data.id
  check('草稿帖评论列表 → 404', (await call('GET', `comments?postId=${draftId}`, undefined, 'alice')).status, 404)
  check('草稿帖发评论 → 404', (await call('POST', 'comments/add', { postId: draftId, body: 'x' }, 'alice')).status, 404)

  console.log('\n=== 6 · 事件（不带正文）===')
  const types = events().map((e) => e.event)
  checkTrue('comment-added 已发', types.includes('zeyuan:feature-community:comment-added'))
  checkTrue('comment-removed 已发', types.includes('zeyuan:feature-community:comment-removed'))
  checkTrue('comment-hidden 已发', types.includes('zeyuan:feature-community:comment-hidden'))
  const added = events().find((e) => e.event.endsWith('comment-added'))
  checkTrue('事件不含正文', !JSON.stringify(added.payload).includes('第一条评论'), JSON.stringify(added.payload))
  check('事件带 commentId', Boolean(added.payload.commentId), true)

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail === 0 ? 0 : 1
} finally {
  rmSync(STATE, { recursive: true, force: true })
}
