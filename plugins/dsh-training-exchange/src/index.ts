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

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Readable } from 'node:stream'

import { checkAccess, stateDir } from './license-gate.js'
import { MAX_UPLOAD_BYTES, RETENTION_DAYS, binPath, commit, ensureDir, exchangeDir, isValidId, newId, putTemp, readStream, removeBin } from './storage.js'
import { NAME_MAX, readMeta, removeMeta, stateOf, validateName, writeMeta, type FileMeta } from './meta.js'
import { assertCanDelete, assertCanDownload, defaultAuthz, type Authz, type NodeId } from './auth.js'
import { emitFileEvent } from './events.js'

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
  const envelope = { v: 1, id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), source: 'exchange', type, subject: {}, payload }
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
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 3600 * 1000).toISOString(), // TODO(总控裁决): 保留期策略
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
    if (meta) rows.push(meta)
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
    if (declared > MAX_UPLOAD_BYTES) {
      return json(res, 413, { ok: false, code: 'E-1501', message: `单文件上限 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB。` })
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

  console.log(`[dsh-training-exchange] 已注册 4 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  writeMountEvent('mounted')
  const access = checkAccess()
  console.log(`[dsh-training-exchange] mounted — v${VERSION} · ${access.level} · files=${listFiles().length} · max=${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`)

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
