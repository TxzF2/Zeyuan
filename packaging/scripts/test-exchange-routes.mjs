#!/usr/bin/env node
/** test-exchange-routes.mjs · 中转站：流式上传/列表/下载/删除/越权/上限/匿名 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-exchange-'))
process.env.DSH_TRAINING_STATE_DIR = STATE
mkdirSync(join(STATE, 'data'), { recursive: true })

const license = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-exchange/dist/license-gate.js')).href)
const mod = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-exchange/dist/index.js')).href)
const storage = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-exchange/dist/storage.js')).href)

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

async function upload(bytes, name, actor, extraHeaders = {}) {
  const handler = routes.get('/zeyuan/exchange/upload')
  const L = {}
  const req = {
    method: 'POST',
    url: `/zeyuan/exchange/upload?name=${encodeURIComponent(name)}`,
    headers: { 'x-dsh-user': actor, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...extraHeaders },
    on(ev, cb) { L[ev] = cb },
  }
  const res = { status: 0, body: null, writeHead(s) { res.status = s }, end(b) { res.body = b ? JSON.parse(b) : null } }
  const p = Promise.resolve(handler(req, res))
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < bytes.length; i += 64 * 1024) L.data?.(bytes.subarray(i, i + 64 * 1024))
  L.end?.()
  await p.catch(() => {})
  await new Promise((r) => setTimeout(r, 5))
  return res
}

async function download(id, actor = 'dave') {
  const handler = routes.get('/zeyuan/exchange/download')
  const req = { method: 'GET', url: `/zeyuan/exchange/download?id=${id}`, headers: { 'x-dsh-user': actor }, on() {} }
  const chunks = []
  const res = {
    status: 0,
    headers: {},
    writeHead(s, h) { res.status = s; Object.assign(res.headers, h ?? {}) },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))) },
    end(b) { if (b) chunks.push(Buffer.from(b)) },
  }
  await Promise.resolve(handler(req, res)).catch(() => {})
  await new Promise((r) => setTimeout(r, 10))
  return { status: res.status, bytes: Buffer.concat(chunks), headers: res.headers }
}

async function call(method, path, body, actor) {
  const handler = routes.get(`/zeyuan/exchange/${path}`)
  const L = {}
  const req = { method, url: `/zeyuan/exchange/${path}`, headers: actor ? { 'x-dsh-user': actor } : {}, on(ev, cb) { L[ev] = cb } }
  const res = { status: 0, body: null, writeHead(s) { res.status = s }, end(b) { res.body = b ? JSON.parse(b) : null } }
  const p = Promise.resolve(handler(req, res))
  await new Promise((r) => setTimeout(r, 0))
  if (body !== undefined) L.data?.(Buffer.from(JSON.stringify(body)))
  L.end?.()
  await p.catch(() => {})
  await new Promise((r) => setTimeout(r, 5))
  return res
}

try {
  console.log('=== 1 · LV1 闸门 ===')
  mod.apply(ctx)
  check('路由数 9', routes.size, 9)
  let r = await upload(Buffer.from('hello'), 'a.txt', 'bob')
  check('未签上传 → 403', r.status, 403)

  license.issueLicense({ subject: '学员', days: 30 })
  gate.resetAccessCache()

  console.log('\n=== 2 · 上传（流式写盘）===')
  const content = Buffer.from('泽元中转站真机测试内容'.repeat(1000))
  r = await upload(content, '测试 文件.txt', 'bob')
  check('上传成功', r.status, 200)
  const meta = r.body.data
  check('记录大小', meta.size, content.length)
  check('上传者=节点 ID（匿名）', meta.uploader, 'bob')
  checkTrue('meta 不含真人信息字段', !('realName' in meta) && !('email' in meta))
  checkTrue('过期时间 = +30 天', Date.parse(meta.expiresAt) - Date.parse(meta.createdAt) === 30 * 24 * 3600 * 1000)
  checkTrue('bin 文件落盘', existsSync(storage.binPath(meta.id)))
  checkTrue('meta 文件落盘', existsSync(storage.metaPath(meta.id)))

  console.log('\n=== 3 · 列表 ===')
  r = await call('GET', 'list')
  check('列表 1 条', r.body.data.length, 1)
  check('列表含文件名', r.body.data[0].name, '测试 文件.txt')

  console.log('\n=== 4 · 下载（流式，字节一致）===')
  const dl = await download(meta.id)
  check('下载 200', dl.status, 200)
  check('字节数一致', dl.bytes.length, content.length)
  checkTrue('内容一致', dl.bytes.equals(content))
  checkTrue('有 Content-Disposition', String(dl.headers['content-disposition'] ?? '').includes('attachment'))
  check('格式合法但不存在 → 404', (await download('00000000-0000-4000-8000-000000000000')).status, 404)
  check('格式非法 → 400', (await download('x-nope-nope')).status, 400)
  check('非法 id → 400', (await download('bad id')).status, 400)

  console.log('\n=== 5 · 删除权限 ===')
  r = await call('POST', 'delete', { id: meta.id }, 'alice')
  check('他人删 → 403', r.status, 403)
  writeFileSync(join(STATE, 'data', 'admins.json'), JSON.stringify({ schemaVersion: 1, admins: [{ userId: 'mod', tier: 6 }] }), 'utf8')
  r = await call('POST', 'delete', { id: meta.id }, 'bob')
  check('上传者删除成功', r.body.data.deleted, true)
  checkTrue('bin 已删除', !existsSync(storage.binPath(meta.id)))

  const r2 = await upload(Buffer.from('x'.repeat(1024)), 'b.bin', 'bob')
  r = await call('POST', 'delete', { id: r2.body.data.id }, 'mod')
  check('P6 删他人 → 403（TODO(总控裁决) 未开）', r.status, 403)

  console.log('\n=== 6 · 边界 ===')
  r = await upload(Buffer.alloc(0), 'empty.bin', 'bob')
  check('空文件 → 400', r.status, 400)
  r = await upload(Buffer.from('x'), 'big.bin', 'bob', { 'content-length': String(storage.MAX_UPLOAD_BYTES + 1) })
  check('超 500MB → 413', r.status, 413)

  console.log('\n=== 7 · 事件 ===')
  const log = join(STATE, 'event-log.jsonl')
  const types = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).event)
  checkTrue('file-uploaded 已发', types.includes('zeyuan:exchange:file-uploaded'))
  checkTrue('file-downloaded 已发', types.includes('zeyuan:exchange:file-downloaded'))
  checkTrue('file-deleted 已发', types.includes('zeyuan:exchange:file-deleted'))

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail === 0 ? 0 : 1
} finally {
  rmSync(STATE, { recursive: true, force: true })
}
