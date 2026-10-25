// 清理与过期（sweep）测试
// 覆盖：过期文件清理 + file-expired 事件、孤儿 bin 清理 + orphan-swept、未完成上传 >24h、retentionDays 可配
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = resolve(ROOT, 'plugins/dsh-training-exchange/dist')

const STATE = mkdtempSync(join(tmpdir(), 'dsh-exchange-sweep-'))
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_EXCHANGE_MAX_UPLOAD = String(4 * 1024 * 1024)

const load = (f) => import(pathToFileURL(resolve(DIST, f)).href)
const events = await load('events.js')
const captured = []
events.setEventSink((name, meta) => captured.push({ name, id: meta.id }))

const svc = await load('index.js')
const sweep = await load('sweep.js')
const storage = await load('storage.js')
const chunks = await load('chunks.js')

const cfgDir = join(STATE, 'data', 'exchange')
const cfgFile = join(cfgDir, 'config.json')
const writeCfg = (obj) => {
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(cfgFile, JSON.stringify(obj), 'utf8')
}

test('sweep: expired file removed + file-expired emitted; fresh file untouched', async () => {
  writeCfg({ retentionDays: 30 })
  assert.equal(sweep.retentionDays(), 30, 'config 应可覆盖默认值')
  rmSync(cfgFile, { force: true })
  assert.equal(sweep.retentionDays(), 30, '默认 30 天')

  const meta = await svc.uploadStream(Readable.from([Buffer.from('expired-content')]), {
    name: '过期.txt',
    mime: 'text/plain',
    uploader: 'node-a',
  })
  const fresh = await svc.uploadStream(Readable.from([Buffer.from('fresh')]), { name: '新鲜.txt', uploader: 'node-a' })

  // 把 expiresAt 改到过去
  const metaFile = storage.metaPath(meta.id)
  const doc = JSON.parse(readFileSync(metaFile, 'utf8'))
  doc.expiresAt = new Date(Date.now() - 1000).toISOString()
  writeFileSync(metaFile, JSON.stringify(doc), 'utf8')

  // 过期但未 sweep：列表不可见、下载 410（到期→清理窗口内的防御）
  assert.ok(!svc.listFiles().some((f) => f.id === meta.id), '过期文件不应出现在列表')
  await assert.rejects(() => svc.readFile(meta.id, 'node-a'), (err) => {
    assert.equal(err.status, 410)
    assert.equal(err.code, 'E-1513')
    return true
  })

  const res = svc.runSweep()
  assert.equal(res.filesExpired, 1, '应清理 1 个过期文件')
  assert.ok(!existsSync(storage.binPath(meta.id)), '过期 bin 应删除')
  assert.ok(!existsSync(storage.metaPath(meta.id)), '过期 meta 应删除')
  assert.ok(existsSync(storage.binPath(fresh.id)), '未过期文件必须保留')
  assert.ok(captured.some((e) => e.name === 'expired' && e.id === meta.id), '应发 file-expired')
})

test('sweep: orphan bin (bin without meta) removed and counted', async () => {
  mkdirSync(storage.exchangeDir(), { recursive: true })
  const orphanId = '11111111-1111-4111-8111-111111111111'
  writeFileSync(storage.binPath(orphanId), randomBytes(64))
  const res = svc.runSweep()
  assert.ok(res.orphans >= 1, '应发现孤儿')
  assert.ok(!existsSync(storage.binPath(orphanId)), '孤儿 bin 应删除')
  assert.ok(captured.some((e) => e.name === 'orphan-swept' && e.id === orphanId), '应发 orphan-swept')
})

test('sweep: pending upload older than 24h removed; fresh upload kept', async () => {
  const old = svc.initUpload({ name: 'old.bin', size: 10, uploader: 'node-a' })
  const fresh = svc.initUpload({ name: 'new.bin', size: 10, uploader: 'node-a' })
  const stateFile = join(chunks.uploadDir(old.uploadId), 'state.json')
  const st = JSON.parse(readFileSync(stateFile, 'utf8'))
  st.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  writeFileSync(stateFile, JSON.stringify(st), 'utf8')

  const res = svc.runSweep()
  assert.ok(res.uploadsExpired >= 1, '应清理超 24h 的未完成上传')
  assert.ok(!existsSync(chunks.uploadDir(old.uploadId)), '旧的应删')
  assert.ok(existsSync(chunks.uploadDir(fresh.uploadId)), '新的应保留')
})

test('sweep: config-driven retentionDays applies to new uploads', async () => {
  writeCfg({ retentionDays: 1 })
  assert.equal(sweep.retentionDays(), 1)
  const meta = await svc.uploadStream(Readable.from([Buffer.from('x')]), { name: 'r.txt', uploader: 'node-a' })
  const days = (Date.parse(meta.expiresAt) - Date.parse(meta.createdAt)) / 86400000
  assert.ok(Math.abs(days - 1) < 1e-6, `expiresAt 应按 1 天计算，实际 ${days}`)
  rmSync(cfgFile, { force: true })
})

process.on('exit', () => rmSync(STATE, { recursive: true, force: true }))
