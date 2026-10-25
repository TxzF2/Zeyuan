// 分片上传 + 断点续传测试（Node 原生 test runner）
// 验收重点：续传不丢块、幂等（重复传同一块不损坏）、合并后哈希与源一致
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = resolve(ROOT, 'plugins/zeyuan-exchange/dist')

const STATE = mkdtempSync(join(tmpdir(), 'dsh-exchange-chunk-'))
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_EXCHANGE_CHUNK = String(64 * 1024) // 测试用 64KB，便于多块
process.env.DSH_EXCHANGE_MAX_UPLOAD = String(4 * 1024 * 1024)

const load = (f) => import(pathToFileURL(resolve(DIST, f)).href)
const svc = await load('index.js')
const chunks = await load('chunks.js')
const storage = await load('storage.js')

const sha = (b) => createHash('sha256').update(b).digest('hex')

test('chunked: out-of-order upload -> resume -> idempotent resend -> complete hash equals source', async () => {
  const chunkSize = chunks.CHUNK_SIZE
  const source = randomBytes(chunkSize * 3 + 1234) // 4 块（最后一块不满）
  const total = Math.ceil(source.length / chunkSize)

  // 1. init
  const init = svc.initUpload({ name: '大文件.bin', size: source.length, mime: 'application/octet-stream', uploader: 'node-a' })
  assert.ok(init.uploadId, '应返回 uploadId')
  assert.equal(init.chunkSize, chunkSize)
  assert.deepEqual(init.received, [])

  // 2. 乱序上传：2, 0
  const slice = (i) => source.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, source.length))
  for (const i of [2, 0]) {
    const r = svc.putChunk({ uploadId: init.uploadId, index: i, data: slice(i), viewer: 'node-a' })
    assert.equal(r.index, i)
  }
  let st = svc.uploadStatus(init.uploadId)
  assert.deepEqual(st.received, [0, 2], 'received 应为 [0,2]')
  assert.deepEqual(st.missing, [1, 3], 'missing 应为 [1,3]')
  assert.equal(st.complete, false)

  // 3. “断网”后恢复：重新读状态（模拟新请求），已收块不丢
  st = svc.uploadStatus(init.uploadId)
  assert.deepEqual(st.received, [0, 2])

  // 4. 幂等：重复传同一块（同内容）
  svc.putChunk({ uploadId: init.uploadId, index: 0, data: slice(0), viewer: 'node-a' })
  st = svc.uploadStatus(init.uploadId)
  assert.deepEqual(st.received, [0, 2], '重传不应改变 received')

  // 5. 缺块时 complete 必须拒绝
  await assert.rejects(() => Promise.resolve(svc.completeUpload({ uploadId: init.uploadId, viewer: 'node-a' })), (err) => {
    assert.equal(err.code, 'E-1510')
    return true
  })

  // 6. 补齐剩余块后完成
  for (const i of [1, 3]) svc.putChunk({ uploadId: init.uploadId, index: i, data: slice(i), viewer: 'node-a' })
  const meta = await svc.completeUpload({ uploadId: init.uploadId, viewer: 'node-a' })
  assert.equal(meta.size, source.length)
  assert.equal(meta.sha256, sha(source), '合并后哈希必须与源一致')
  assert.equal(meta.name, '大文件.bin')
  assert.ok(existsSync(storage.binPath(meta.id)))
  assert.ok(!existsSync(chunks.uploadDir(init.uploadId)), '完成后应清理分片目录')

  // 7. 幂等：重复 complete 不产生第二个文件
  const again = await svc.completeUpload({ uploadId: init.uploadId, viewer: 'node-a' })
  assert.equal(again.id, meta.id, '重复 complete 应返回同一文件')
  assert.equal(svc.listFiles().filter((f) => f.id === meta.id).length, 1)
})

test('chunked: chunk hash mismatch rejected; unknown uploadId refused; oversized init rejected', async () => {
  // size=3：单块，先让长度校验通过，才能命中“哈希不符”分支
  const init = svc.initUpload({ name: 'x.bin', size: 3, mime: 'application/octet-stream', uploader: 'node-a' })
  assert.throws(
    () => svc.putChunk({ uploadId: init.uploadId, index: 0, data: Buffer.from('abc'), sha256: 'deadbeef'.repeat(8), viewer: 'node-a' }),
    (err) => {
      assert.equal(err.code, 'E-1508')
      return true
    },
  )
  assert.equal(svc.uploadStatus(init.uploadId).received.length, 0, '校验失败不得计入')

  assert.throws(() => svc.uploadStatus('00000000-0000-4000-8000-000000000000'), (err) => {
    assert.equal(err.code, 'E-1504')
    return true
  })

  assert.throws(
    () => svc.initUpload({ name: 'big.bin', size: 4 * 1024 * 1024 + 1, uploader: 'node-a' }),
    (err) => {
      assert.equal(err.code, 'E-1501')
      return true
    },
  )
})

test('chunked: stale uploads (>24h) are swept; custom chunk size honored', async () => {
  const init = svc.initUpload({ name: 'stale.bin', size: 100, uploader: 'node-a' })
  const statePath = join(chunks.uploadDir(init.uploadId), 'state.json')
  const st = JSON.parse(readFileSync(statePath, 'utf8'))
  st.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  writeFileSync(statePath, JSON.stringify(st), 'utf8')
  const swept = chunks.sweepStale()
  assert.ok(swept >= 1, '应清理至少 1 个过期上传')
  assert.ok(!existsSync(chunks.uploadDir(init.uploadId)), '过期目录应被删除')
  assert.equal(chunks.CHUNK_SIZE, 64 * 1024, '分块大小应可配置（测试为 64KB）')
})

process.on('exit', () => rmSync(STATE, { recursive: true, force: true }))
