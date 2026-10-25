/**
 * dsh-training-exchange · HOST 半（泽元中转站）
 * ---------------------------------------------------------------------------
 * 路由（DSH webServer 只支持 exact path，故用 query/body 传 id）：
 *   POST /exchange/upload?name=<urlencoded>&                      上传（流式写盘，≤500MB）
 *   GET  /exchange/list                                           列表（隐藏过期）
 *   GET  /exchange/download?id=<id>                               下载（流式）
 *   POST /exchange/delete { id }                                  删除（上传者本人或 P6+）
 *
 * 权限：上传/删除需 LV1（canEnterLv1 语义）；下载与列表开放（匿名中转）。
 * 事件：file-uploaded / file-downloaded / file-deleted（file-expired 在清理小步）
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import { MAX_FILE_BYTES, RETENTION_DAYS, binPath, cleanupTmp, commitTmp, ensureDir, isValidId, listMetas, makeId, readMeta, removeFiles, tmpPathFor, writeMeta, type FileMeta } from './storage.js'

export const name = 'dsh-training-exchange'
export const VERSION = '0.1.0'

export const EMITTED_EVENTS = [
  'dsh-training:exchange:file-uploaded',
  'dsh-training:exchange:file-downloaded',
  'dsh-training:exchange:file-deleted',
  'dsh-training:exchange:file-expired',
] as const
export type EmittedEvent = (typeof EMITTED_EVENTS)[number]

const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
const host = (): string => (process.versions.electron ? 'electron' : 'node')
let bus: Context | null = null

function ensureState(): void {
  mkdirSync(stateDir(), { recursive: true })
}

export function emitEvent(type: EmittedEvent, payload: Record<string, unknown>): void {
  const envelope = { v: 1, id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), source: 'exchange', type, subject: {}, payload }
  try {
    ensureState()
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[exchange] 写事件日志失败：${(err as Error).message}`)
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch {
    /* ignore */
  }
  console.log(`[exchange] event ${type} ${JSON.stringify(payload)}`)
}

function writeMountEvent(event: 'mounted' | 'unmounted'): void {
  try {
    ensureState()
    appendFileSync(
      join(stateDir(), 'mount-events.jsonl'),
      JSON.stringify({ plugin: name, version: VERSION, at: new Date().toISOString(), pid: process.pid, event, host: host() }) + '\n',
      'utf8',
    )
  } catch (err) {
    console.warn(`[exchange] 写挂载标记失败：${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------- 权限
import { existsSync as fsExists, readFileSync as fsRead } from 'node:fs'

export function tierOf(userId: string): number {
  try {
    const file = join(stateDir(), 'data', 'admins.json')
    if (!fsExists(file)) return 0
    const doc = JSON.parse(fsRead(file, 'utf8')) as { admins?: { userId: string; tier: number }[] }
    return doc.admins?.find((a) => a.userId === userId)?.tier ?? 0
  } catch {
    return 0
  }
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'HttpError'
  }
}

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

// ---------------------------------------------------------------- 路由
function registerRoutes(ctx: Context): void {
  const web = (ctx as unknown as { webServer?: { register(spec: unknown): unknown } }).webServer
  if (!web?.register) return

  const route = (path: string, handler: (req: ServerRequestLike, res: ServerResponseLike) => void | Promise<void>) => {
    web.register({
      kind: 'exact',
      path,
      handler: (req: ServerRequestLike, res: ServerResponseLike) => {
        const fail = (err: unknown) => {
          if (err instanceof HttpError) return json(res, err.status, { ok: false, code: err.code, message: err.message })
          json(res, 500, { ok: false, code: 'E-1509', message: (err as Error).message })
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

  // 上传：流式写盘（边收边写，不整包进内存）
  route(`${base}/upload`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const name = decodeURIComponent(url.searchParams.get('name') ?? 'unnamed.bin').slice(0, 200)
    const mime = header(req, 'content-type') || 'application/octet-stream'
    const declared = Number(header(req, 'content-length') || '0')
    if (declared > MAX_FILE_BYTES) {
      return json(res, 413, { ok: false, code: 'E-1501', message: `单文件上限 ${MAX_FILE_BYTES / 1024 / 1024}MB。` })
    }

    ensureDir()
    const id = makeId()
    const tmp = tmpPathFor(id)
    const now = new Date()
    let size = 0
    let fd: number | null = null
    try {
      fd = openSync(tmp, 'w')
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
          size += buf.length
          if (size > MAX_FILE_BYTES) {
            reject(new HttpError(413, 'E-1501', `单文件上限 ${MAX_FILE_BYTES / 1024 / 1024}MB。`))
            return
          }
          writeSync(fd as number, buf)
        })
        req.on('end', () => resolve())
        req.on('error', () => reject(new HttpError(500, 'E-1502', '上传中断。')))
      })
    } catch (err) {
      if (fd !== null) closeSync(fd)
      cleanupTmp(tmp)
      throw err
    }
    if (fd !== null) closeSync(fd)
    if (size === 0) {
      cleanupTmp(tmp)
      throw new HttpError(400, 'E-1503', '空文件。')
    }
    commitTmp(tmp, id)
    const meta: FileMeta = {
      id,
      name,
      size,
      mime,
      uploader: actorOf(req),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 3600 * 1000).toISOString(),
    }
    writeMeta(meta)
    emitEvent('dsh-training:exchange:file-uploaded', { id, size, by: meta.uploader })
    json(res, 200, { ok: true, data: meta })
  })

  // 列表（隐藏过期）
  route(`${base}/list`, (req, res) => {
    json(res, 200, { ok: true, data: listMetas() })
  })

  // 下载（流式）
  route(`${base}/download`, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('id') ?? ''
    if (!isValidId(id)) return json(res, 400, { ok: false, code: 'E-1503', message: 'id 非法。' })
    const meta = readMeta(id)
    if (!meta || !existsSync(binPath(id))) return json(res, 404, { ok: false, code: 'E-1504', message: '文件不存在。' })
    res.writeHead(200, {
      'content-type': meta.mime || 'application/octet-stream',
      'content-length': String(meta.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'cache-control': 'no-store',
    })
    await new Promise<void>((resolve) => {
      const stream = createReadStream(binPath(id))
      stream.on('data', (chunk) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
        res.write?.(buf)
      })
      stream.on('end', () => {
        res.end()
        resolve()
      })
      stream.on('error', () => {
        res.end()
        resolve()
      })
    })
    emitEvent('dsh-training:exchange:file-downloaded', { id, by: actorOf(req) })
  })

  // 删除（上传者本人或 P6+）
  route(`${base}/delete`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1505', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await new Promise<Record<string, unknown>>((resolve) => {
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
    const id = typeof body.id === 'string' ? body.id : ''
    const actor = actorOf(req)
    const meta = readMeta(id)
    if (!meta) throw new HttpError(404, 'E-1504', '文件不存在。')
    if (meta.uploader !== actor && tierOf(actor) < 6) throw new HttpError(403, 'E-1502', '只能删除自己上传的文件（P6+ 例外）。')
    removeFiles(id)
    emitEvent('dsh-training:exchange:file-deleted', { id, by: actor })
    json(res, 200, { ok: true, data: { id, deleted: true } })
  })

  console.log(`[dsh-training-exchange] 已注册 4 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  writeMountEvent('mounted')
  const access = checkAccess()
  console.log(`[dsh-training-exchange] mounted — v${VERSION} · ${access.level} · files=${listMetas().length}`)

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

export const __internals = { listMetas, tierOf, emitEvent }
