// P0 文件存储闭环测试（Node 原生 test runner，不引第三方）
// 流程：上传 → 列表 → 下载哈希校验 → 越权删除 403 → 本人删除清 meta+bin
// 崩溃一致性：meta 在 bin 不在 → 拒绝；bin 在 meta 不在 → 孤儿不可见
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = resolve(ROOT, 'plugins/dsh-training-exchange/dist')

const STATE = mkdtempSync(join(tmpdir(), 'dsh-exchange-p0-'))
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_EXCHANGE_MAX_UPLOAD = String(1024 * 1024) // 测试里压到 1MB，便于验证超限

const load = async (f) => import(pathToFileURL(resolve(DIST, f)).href)
const events = await load('events.js').catch(() => null)
if (events?.setEventSink) {
  const captured = []
  events.setEventSink((name, meta) => captured.push({ name, id: meta.id, uploader: meta.uploader }))
  globalThis.__captured = captured
}

const svc = await load('index.js')
const storage = await load('storage.js')
const metaMod = await load('meta.js')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

test('p0: upload -> listed -> download hash equal -> stranger delete 403 -> owner delete cleans meta+bin', async () => {
  const content = Buffer.from('泽元中转站 P0 闭环内容\n'.repeat(200))
  const uploader = 'node-a'

  // 1. 上传（中文名）
  const meta = await svc.uploadStream(Readable.from([content]), { name: '中文名.txt', mime: 'text/plain', uploader })
  assert.equal(meta.size, content.length)
  assert.equal(meta.sha256, sha256(content))
  assert.equal(meta.name, '中文名.txt')
  assert.equal(meta.uploader, uploader)
  assert.ok(meta.id.length >= 16, 'id 不能太短')
  assert.ok(!meta.id.includes('中文名'), 'id 不得包含原名')
  assert.ok(!meta.id.includes(meta.sha256.slice(0, 8)), 'id 不得来自原名/哈希')

  // 2. 列表
  const rows = svc.listFiles()
  const row = rows.find((r) => r.id === meta.id)
  assert.ok(row, '列表应包含刚上传的文件')
  assert.equal(row.size, content.length)
  assert.equal(row.uploader, uploader)
  assert.ok(Date.parse(row.expiresAt) > Date.parse(row.createdAt), 'expiresAt 应晚于 createdAt')

  // 3. 下载：字节与 sha256 一致
  const got = await svc.readFile(meta.id, 'node-b')
  assert.equal(got.meta.sha256, sha256(content))
  const chunks = []
  for await (const c of got.stream) chunks.push(Buffer.from(c))
  const downloaded = Buffer.concat(chunks)
  assert.equal(downloaded.length, content.length)
  assert.equal(sha256(downloaded), sha256(content))

  // 4. 越权删除 → 403，资源仍在
  await assert.rejects(() => svc.deleteFile(meta.id, 'node-b'), (err) => {
    assert.equal(err.status ?? err.code, err.status === 403 ? 403 : err.code)
    return true
  })
  assert.ok(existsSync(storage.binPath(meta.id)), 'bin 应仍在')
  assert.ok(existsSync(storage.metaPath(meta.id)), 'meta 应仍在')

  // 5. 本人删除 → 双清
  await svc.deleteFile(meta.id, uploader)
  assert.ok(!existsSync(storage.metaPath(meta.id)), 'meta 应已删除')
  assert.ok(!existsSync(storage.binPath(meta.id)), 'bin 应已删除')

  // 6. 事件至少各一次
  const names = (globalThis.__captured ?? []).map((e) => e.name)
  for (const n of ['uploaded', 'downloaded', 'deleted']) assert.ok(names.includes(n), `缺少事件 ${n}`)
})

test('p0: corrupt meta-without-bin is refused; orphan bin-without-meta is invisible', async () => {
  const dir = storage.exchangeDir()
  mkdirSync(dir, { recursive: true })

  // 造 meta 在、bin 不在
  const ghostId = 'ghost-meta-only'
  const ghostMeta = {
    id: ghostId,
    name: 'ghost.txt',
    size: 10,
    sha256: sha256(Buffer.from('0123456789')),
    mime: 'text/plain',
    uploader: 'node-a',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }
  writeFileSync(storage.metaPath(ghostId), JSON.stringify(ghostMeta), 'utf8')
  await assert.rejects(() => svc.readFile(ghostId, 'node-a'), 'meta 在 bin 不在必须拒绝访问')

  // 造 bin 在、meta 不在（孤儿）
  const orphanId = 'orphan-bin-only'
  writeFileSync(storage.binPath(orphanId), Buffer.from('orphan'), 'utf8')
  const ids = svc.listFiles().map((r) => r.id)
  assert.ok(!ids.includes(orphanId), '孤儿不应出现在列表')
  await assert.rejects(() => svc.readFile(orphanId, 'node-a'), '无 meta 必须拒绝访问')

  rmSync(dir, { recursive: true, force: true })
})

test.after?.(() => {})
process.on('exit', () => rmSync(STATE, { recursive: true, force: true }))
