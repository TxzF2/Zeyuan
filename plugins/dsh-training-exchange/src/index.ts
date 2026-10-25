/**
 * dsh-training-exchange · HOST 半（泽元中转站 · P0 闭环）
 * ---------------------------------------------------------------------------
 * 服务层（可被测试直接调用，不必起 HTTP）：
 *   uploadStream(stream, {name,mime,uploader}) -> FileMeta
 *   listFiles() -> FileMeta[]（只列 meta+bin 都存在的）
 *   readFile(id, viewer) -> { meta, stream }（下载前校验 sha256）
 *   deleteFile(id, viewer) -> void（先删 meta 再删 bin）
 *
 * 路由（DSH webServer 只支持 exact path，用 query/body 传 id）：
 *   POST /exchange/upload?name=  | GET /exchange/list
 *   GET  /exchange/download?id=  | POST /exchange/delete {id}
 *
 * 提交顺序：bin 先落 → meta 后落（meta 是提交点）
 * 删除顺序：meta 先删（立刻不可见）→ bin 后删
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Readable } from 'node:stream'

import { checkAccess, stateDir } from './license-gate.js'
import { MAX_UPLOAD_BYTES, maxUploadBytes, RETENTION_DAYS, binPath, commit, ensureDir, exchangeDir, isValidId, newId, putTemp, readStream, removeBin } from './storage.js'
import { NAME_MAX, readMeta, removeMeta, stateOf, validateName, writeMeta, type FileMeta } from './meta.js'
import { assertCanDelete, assertCanDownload, defaultAuthz, type Authz, type NodeId } from './auth.js'
import { emitFileEvent } from './events.js'
import { retentionDays, startSweeper, sweepNow, tierOf } from './sweep.js'
import { CHUNK_SIZE, PENDING_TTL_MS, assemble, isValidUploadId, newUploadState, readState, removeUpload, saveChunk, sweepStale, totalChunks, uploadsDir, writeState, type UploadState } from './chunks.js'

export const name = 'dsh-training-exchange'
export const VERSION = '0.1.0'
export const EMITTED_EVENTS = [
  'dsh-training:exchange:file-uploaded',
  'dsh-training:exchange:file-downloaded',
  'dsh-training:exchange:file-deleted',
  'dsh-training:exchange:file-expired',
] as const

const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
const host = (): string => (process.versions.electron ? 'electron' : 'node')
let bus: Context | null = null
let authz: Authz = defaultAuthz

/** 测试/上层可替换鉴权实现（P0 默认最严删除） */
export function setAuthz(next: Authz): void {
  authz = next
}

export function emitBus(type: string, payload: Record<string, unknown>): void {
  const envelope = {
    event: type,
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    actor: (payload as Record<string, unknown> | null)?.by ?? null,
    payload,
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch (err) {
    console.warn(`[exchange] 总线广播失败：${(err as Error).message}`)
  }
}

function writeMountEvent(event: 'mounted' | 'unmounted'): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(
      join(stateDir(), 'mount-events.jsonl'),
      JSON.stringify({ plugin: name, version: VERSION, at: new Date().toISOString(), pid: process.pid, event, host: host() }) + '\n',
      'utf8',
    )
  } catch (err) {
    console.warn(`[exchange] 写挂载标记失败：${(err as Error).message}`)
  }
}

/** 供测试与维护接口调用的扫描入口 */
export function runSweep(now: number = Date.now()): ReturnType<typeof sweepNow> {
  return sweepNow(now)
}

export class ServiceError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'ServiceError'
  }
}

// ---------------------------------------------------------------- 服务层
export interface UploadInput {
  name: unknown
  mime?: string
  uploader: NodeId
}

export async function uploadStream(stream: Readable | AsyncIterable<unknown>, input: UploadInput): Promise<FileMeta> {
  const name = validateName(input.name)
  const tmp = await putTemp(stream) // 超限/空文件在此抛错
  const id = newId()
  // 提交顺序：bin 先、meta 后
  commit(tmp.tmpPath, id)
  const now = new Date()
  const meta: FileMeta = {
    id,
    name,
    size: tmp.size,
    sha256: tmp.sha256,
    mime: (input.mime ?? 'application/octet-stream').slice(0, 128),
    uploader: input.uploader,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + retentionDays() * 24 * 3600 * 1000).toISOString(), // TODO(总控裁决): 保留期策略（可用 config.json 覆盖）
  }
  writeMeta(meta)
  await emitFileEvent('uploaded', meta, input.uploader)
  emitBus('dsh-training:exchange:file-uploaded', { id, size: meta.size, by: input.uploader })
  return meta
}

/** 只列 meta 与 bin 都在的；孤儿（bin 无 meta）不可见 */
export function listFiles(): FileMeta[] {
  const dir = exchangeDir()
  if (!existsSync(dir)) return []
  const rows: FileMeta[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue
    const id = f.replace(/\.meta\.json$/, '')
    if (!isValidId(id)) continue
    if (stateOf(id) !== 'ok') continue
    const meta = readMeta(id)
    if (!meta) continue
    // 过期即视为不可见（不等 sweep；防御性，避免到期到清理之间的窗口）
    if (Date.parse(meta.expiresAt) <= Date.now()) continue
    rows.push(meta)
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/** 下载前校验：损坏拒绝、越权 403、sha256 不符拒绝 */
export async function readFile(id: string, viewer: NodeId): Promise<{ meta: FileMeta; stream: Readable }> {
  if (!isValidId(id)) throw new ServiceError(400, 'E-1503', 'id 非法')
  const state = stateOf(id)
  const meta = readMeta(id)
  if (state === 'missing-meta' || !meta) throw new ServiceError(404, 'E-1504', '文件不存在')
  if (state === 'missing-bin') throw new ServiceError(500, 'E-1507', '文件数据缺失（meta 在、bin 不在），拒绝访问')
  if (Date.parse(meta.expiresAt) <= Date.now()) throw new ServiceError(410, 'E-1513', '文件已过期（保留期结束）')
  await assertCanDownload(authz, viewer, meta)
  if (!(await verifySha(id, meta.sha256))) throw new ServiceError(500, 'E-1506', '文件校验失败（sha256 不符），拒绝下发')
  await emitFileEvent('downloaded', meta, viewer)
  emitBus('dsh-training:exchange:file-downloaded', { id, by: viewer })
  return { meta, stream: readStream(id) }
}

export async function deleteFile(id: string, viewer: NodeId): Promise<void> {
  if (!isValidId(id)) throw new ServiceError(400, 'E-1503', 'id 非法')
  const meta = readMeta(id)
  if (!meta) throw new ServiceError(404, 'E-1504', '文件不存在')
  await assertCanDelete(authz, viewer, meta)
  // 先删 meta：文件立刻对外不可见
  removeMeta(id)
  removeBin(id)
  await emitFileEvent('deleted', meta, viewer)
  emitBus('dsh-training:exchange:file-deleted', { id, by: viewer })
}

// ---------------------------------------------------------------- 分片上传（P0.5）
const DONE_MARKER = (uploadId: string): string => `${uploadsDir()}/${uploadId}.done.json`

function readDoneMarker(uploadId: string): { uploadId: string; fileId: string; at: string } | null {
  try {
    const file = DONE_MARKER(uploadId)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as { uploadId: string; fileId: string; at: string }
  } catch {
    return null
  }
}

function writeDoneMarker(uploadId: string, fileId: string): void {
  mkdirSync(uploadsDir(), { recursive: true })
  writeFileSync(DONE_MARKER(uploadId), JSON.stringify({ uploadId, fileId, at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
}

export function initUpload(input: { name: unknown; size: unknown; mime?: string; uploader: NodeId }): {
  uploadId: string
  chunkSize: number
  size: number
  received: number[]
} {
  const name = validateName(input.name)
  const size = Number(input.size)
  if (!Number.isInteger(size) || size <= 0) throw new ServiceError(400, 'E-1503', 'size 必须是正整数')
  const cap = maxUploadBytes()
  if (size > cap) throw new ServiceError(413, 'E-1501', `单文件上限 ${Math.floor(cap / 1024 / 1024)}MB`)
  sweepStale() // 顺手清理过期未完成上传（24h）
  const st = newUploadState({ name, size, mime: (input.mime ?? 'application/octet-stream').slice(0, 128), uploader: input.uploader })
  writeState(st)
  return { uploadId: st.uploadId, chunkSize: st.chunkSize, size, received: [] }
}

export function putChunk(input: { uploadId: string; index: number | string; data: unknown; sha256?: string; viewer: NodeId }): {
  index: number
  received: number[]
} {
  const st = readState(input.uploadId)
  if (!st) throw new ServiceError(404, 'E-1504', '上传会话不存在或已过期')
  if (st.status === 'completed') throw new ServiceError(409, 'E-1511', '该上传已完成')
  const total = totalChunks(st.size, st.chunkSize)
  const index = Number(input.index)
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new ServiceError(400, 'E-1503', `分片序号应在 0..${total - 1}`)
  const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(String(input.data ?? ''))
  const expected = index === total - 1 ? st.size - st.chunkSize * (total - 1) : st.chunkSize
  if (data.length !== expected) throw new ServiceError(400, 'E-1503', `分片 ${index} 长度应为 ${expected}，实际 ${data.length}`)
  const got = createHash('sha256').update(data).digest('hex')
  if (input.sha256 && input.sha256.toLowerCase() !== got) throw new ServiceError(400, 'E-1508', '分片哈希不符')
  const rec = saveChunk(st.uploadId, index, data)
  const chunks = [...st.chunks.filter((c) => c.index !== index), rec].sort((a, b) => a.index - b.index)
  writeState({ ...st, chunks, updatedAt: new Date().toISOString() })
  return { index, received: chunks.map((c) => c.index) }
}

export function uploadStatus(uploadId: string): {
  uploadId: string
  chunkSize: number
  size: number
  total: number
  received: number[]
  missing: number[]
  complete: boolean
} {
  const st: UploadState | null = readState(uploadId)
  if (!st) throw new ServiceError(404, 'E-1504', '上传会话不存在或已过期')
  const total = totalChunks(st.size, st.chunkSize)
  const got = new Set(st.chunks.map((c) => c.index))
  const received = [...got].sort((a, b) => a - b)
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !got.has(i))
  return { uploadId: st.uploadId, chunkSize: st.chunkSize, size: st.size, total, received, missing, complete: missing.length === 0 }
}

export async function completeUpload(input: { uploadId: string; viewer: NodeId }): Promise<FileMeta> {
  // 幂等：已完成的上传再次 complete → 返回同一文件
  const done = readDoneMarker(input.uploadId)
  if (done) {
    const meta = readMeta(done.fileId)
    if (meta) return meta
    throw new ServiceError(404, 'E-1504', '文件已被清理')
  }
  const st = readState(input.uploadId)
  if (!st) throw new ServiceError(404, 'E-1504', '上传会话不存在或已过期')
  const total = totalChunks(st.size, st.chunkSize)
  const got = new Set(st.chunks.map((c) => c.index))
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !got.has(i))
  if (missing.length > 0) throw new ServiceError(409, 'E-1510', `缺少分片：${missing.join(',')}`)
  const sum = st.chunks.reduce((acc, c) => acc + c.size, 0)
  if (sum !== st.size) throw new ServiceError(409, 'E-1510', `分片总大小不符（${sum} ≠ ${st.size}）`)

  const asm = assemble(st.uploadId, st)
  const id = newId()
  commit(asm.tmpPath, id) // bin 先落
  const now = new Date()
  const meta: FileMeta = {
    id,
    name: st.name,
    size: asm.size,
    sha256: asm.sha256, // 合并后哈希（应与源文件一致）
    mime: st.mime,
    uploader: st.uploader,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + retentionDays() * 24 * 3600 * 1000).toISOString(), // TODO(总控裁决)（config 可覆盖）
  }
  writeMeta(meta) // meta 提交点
  writeDoneMarker(st.uploadId, id)
  removeUpload(st.uploadId)
  await emitFileEvent('uploaded', meta, input.viewer)
  emitBus('dsh-training:exchange:file-uploaded', { id, size: meta.size, by: input.viewer, via: 'chunked' })
  return meta
}

async function verifySha(id: string, expected: string): Promise<boolean> {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  const stream = readStream(id)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex') === expected
}

// ---------------------------------------------------------------- HTTP
interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  write?(chunk: unknown): void
  end(body?: string): void
}
interface ServerRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data' | 'end' | 'error', cb: (chunk?: unknown) => void): void
}

function json(res: ServerResponseLike, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function actorOf(req: ServerRequestLike): string {
  const raw = req.headers[ACTOR_HEADER]
  const v = Array.isArray(raw) ? raw[0] : raw
  return (typeof v === 'string' ? v.trim() : '') || DEFAULT_ACTOR
}

function header(req: ServerRequestLike, key: string): string {
  const raw = req.headers[key]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' ? v : ''
}

function requireLv1(res: ServerResponseLike): boolean {
  const access = checkAccess()
  if (!access.ok) {
    json(res, 403, { ok: false, code: access.code, message: `${access.reason}（LV1 才能上传/删除）` })
    return false
  }
  return true
}

function readBody(req: ServerRequestLike): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c ?? ''))))
    req.on('end', () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function registerRoutes(ctx: Context): void {
  const web = (ctx as unknown as { webServer?: { register(spec: unknown): unknown } }).webServer
  if (!web?.register) return

  const route = (path: string, handler: (req: ServerRequestLike, res: ServerResponseLike) => void | Promise<void>) => {
    web.register({
      kind: 'exact',
      path,
      handler: (req: ServerRequestLike, res: ServerResponseLike) => {
        const fail = (err: unknown) => {
          const status = (err as { status?: number }).status ?? 500
          const code = (err as { code?: string }).code ?? 'E-1509'
          json(res, status, { ok: false, code, message: (err as Error).message })
        }
        try {
          Promise.resolve(handler(req, res)).catch(fail)
        } catch (err) {
          fail(err)
        }
      },
    })
  }

  const base = '/dsh-training/exchange'

  route(`${base}/upload`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const declared = Number(header(req, 'content-length') || '0')
    const cap = maxUploadBytes()
    if (declared > cap) {
      return json(res, 413, { ok: false, code: 'E-1501', message: `单文件上限 ${Math.floor(cap / 1024 / 1024)}MB。` })
    }
    const meta = await uploadStream(req as unknown as AsyncIterable<unknown>, {
      name: decodeURIComponent(url.searchParams.get('name') ?? ''),
      mime: header(req, 'content-type'),
      uploader: actorOf(req),
    })
    json(res, 200, { ok: true, data: meta })
  })

  route(`${base}/list`, (_req, res) => {
    json(res, 200, { ok: true, data: listFiles() })
  })

  route(`${base}/download`, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('id') ?? ''
    const { meta, stream } = await readFile(id, actorOf(req))
    res.writeHead(200, {
      'content-type': meta.mime || 'application/octet-stream',
      'content-length': String(meta.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'cache-control': 'no-store',
    })
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk) => res.write?.(chunk))
      stream.on('end', () => {
        res.end()
        resolve()
      })
      stream.on('error', () => {
        res.end()
        resolve()
      })
    })
  })

  route(`${base}/delete`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    await deleteFile(String(body.id ?? ''), actorOf(req))
    json(res, 200, { ok: true, data: { id: body.id, deleted: true } })
  })

  // ---------------- 分片上传 / 断点续传 ----------------
  const readRaw = (req: ServerRequestLike, maxBytes = CHUNK_SIZE + 1024): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = []
      let size = 0
      req.on('data', (c) => {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c ?? ''))
        size += buf.length
        if (size > maxBytes) {
          reject(new ServiceError(413, 'E-1501', '分片超出大小上限'))
          return
        }
        parts.push(buf)
      })
      req.on('end', () => resolve(Buffer.concat(parts)))
      req.on('error', () => reject(new ServiceError(500, 'E-1502', '读取失败')))
    })

  route(`${base}/upload/init`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const data = initUpload({ name: body.name, size: body.size, mime: typeof body.mime === 'string' ? body.mime : undefined, uploader: actorOf(req) })
    json(res, 200, { ok: true, data })
  })

  route(`${base}/upload/chunk`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const uploadId = url.searchParams.get('uploadId') ?? ''
    if (!isValidUploadId(uploadId)) return json(res, 400, { ok: false, code: 'E-1503', message: 'uploadId 非法' })
    const data = await readRaw(req)
    const data2 = putChunk({
      uploadId,
      index: url.searchParams.get('index') ?? '',
      data,
      sha256: header(req, 'x-chunk-sha256') || undefined,
      viewer: actorOf(req),
    })
    json(res, 200, { ok: true, data: data2 })
  })

  route(`${base}/upload/status`, (req, res) => {
    if (!requireLv1(res)) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    json(res, 200, { ok: true, data: uploadStatus(url.searchParams.get('uploadId') ?? '') })
  })

  route(`${base}/upload/complete`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const meta = await completeUpload({ uploadId: String(body.uploadId ?? ''), viewer: actorOf(req) })
    json(res, 200, { ok: true, data: meta })
  })

  // 维护：立即扫描一次（P6+）
  route(`${base}/sweep`, (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    const actor = actorOf(req)
    if (tierOf(actor) < 6) return json(res, 403, { ok: false, code: 'E-1502', message: '需要 P6 及以上档位。' })
    json(res, 200, { ok: true, data: sweepNow() })
  })

  console.log(`[dsh-training-exchange] 已注册 9 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  writeMountEvent('mounted')
  try {
    const swept = sweepStale() // 启动清理：未完成上传超 24h 丢弃
    if (swept > 0) console.log(`[dsh-training-exchange] 清理过期未完成上传 ${swept} 个`)
  } catch (err) {
    console.warn(`[exchange] 启动清理失败：${(err as Error).message}`)
  }
  console.log(`[exchange] chunk=${Math.floor(CHUNK_SIZE / 1024 / 1024)}MB · 未完成上传保留 ${Math.floor(PENDING_TTL_MS / 3600000)}h`)
  const access = checkAccess()
  console.log(`[dsh-training-exchange] mounted — v${VERSION} · ${access.level} · files=${listFiles().length} · max=${Math.floor(maxUploadBytes() / 1024 / 1024)}MB`)

  startSweeper(ctx) // 启动扫描 + 每小时定时器

  ctx.effect(() => {
    console.log('[dsh-training-exchange] ready')
    return () => {
      writeMountEvent('unmounted')
      console.log('[dsh-training-exchange] DISPOSED — listeners removed')
    }
  }, 'dsh-training-exchange: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-exchange] 注册路由失败：${(err as Error).message}`)
        }
      })
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    }
  } catch (err) {
    console.warn(`[dsh-training-exchange] 等待 webServer 失败：${(err as Error).message}`)
  }
}

export const __internals = { ensureDir, exchangeDir, binPath, NAME_MAX }
export type { FileMeta }
