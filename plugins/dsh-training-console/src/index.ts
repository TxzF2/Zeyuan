/**
 * dsh-training-console · HOST 半
 * ---------------------------------------------------------------------------
 * 控制面板：身份/角色（收口 D-007）、板块启停、仪表盘、健康检查、审计。
 *
 * 权限判定顺序（固定）：
 *   身份合法（自动登记）→ disabled? 拒 → 角色（admin）→ LV1 门禁（license scope）→ 业务规则
 *
 * 路由 11 条：me / bootstrap / dashboard / health / users / users/create / users/role
 *             / users/disable / boards / boards/toggle / audit
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import {
  UsersError,
  bootstrapAdmin,
  isAdmin,
  listUsers,
  resolveUser,
  setDisabled,
  setRole,
  type Role,
  type User,
} from './users.js'
import { BoardsError, boardStatus, toggleBoard } from './boards.js'
import { dashboard, health } from './dashboard.js'

export const name = 'dsh-training-console'
export const VERSION = '0.1.0'

export const EMITTED_EVENTS = [
  'dsh-training:feature-console:dashboard-invalidate',
  'dsh-training:feature-console:board-toggled',
  'dsh-training:feature-console:user-created',
  'dsh-training:feature-console:user-role-changed',
  'dsh-training:feature-console:user-disabled',
  'dsh-training:feature-console:admin-bootstrapped',
] as const
export type EmittedEvent = (typeof EMITTED_EVENTS)[number]

const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
const MAX_BODY_BYTES = 64 * 1024

const host = (): string => (process.versions.electron ? 'electron' : 'node')
let bus: Context | null = null

function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true })
}

export function emitEvent(type: EmittedEvent, payload: Record<string, unknown>, subject: Record<string, unknown> = {}): void {
  const envelope = {
    v: 1,
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source: 'feature-console',
    type,
    subject,
    payload,
  }
  try {
    ensureStateDir()
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[dsh-training-console] 写事件日志失败：${(err as Error).message}`)
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch (err) {
    console.warn(`[dsh-training-console] 总线广播失败：${(err as Error).message}`)
  }
  console.log(`[dsh-training-console] event ${type} ${JSON.stringify(payload)}`)
}

function writeMountEvent(event: 'mounted' | 'unmounted'): void {
  try {
    ensureStateDir()
    appendFileSync(
      join(stateDir(), 'mount-events.jsonl'),
      JSON.stringify({ plugin: name, version: VERSION, at: new Date().toISOString(), pid: process.pid, event, host: host() }) + '\n',
      'utf8',
    )
  } catch (err) {
    console.warn(`[dsh-training-console] 写挂载标记失败：${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------- HTTP
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

const STATUS_BY_CODE: Record<string, number> = {
  'E-1101': 409,
  'E-1102': 403,
  'E-1103': 400,
  'E-1104': 404,
  'E-1105': 403,
  'E-1106': 409,
  'E-1107': 409,
  'E-1108': 403,
  'E-1110': 500,
  'E-1111': 503,
  'E-1112': 500,
}

interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
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

function readBody(req: ServerRequestLike): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buf.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (!size) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', () => reject(new Error('read error')))
  })
}

/** 解析身份（未知自动登记） */
function resolveOrThrow(req: ServerRequestLike): User {
  try {
    return resolveUser(actorOf(req)).user
  } catch (err) {
    if (err instanceof UsersError) throw new HttpError(STATUS_BY_CODE[err.code] ?? 400, err.code, err.message)
    throw err
  }
}

function requireAdmin(req: ServerRequestLike): User {
  const user = resolveOrThrow(req)
  if (!user.roles.includes('admin')) throw new HttpError(403, 'E-1105', '需要管理员权限（角色 admin）。')
  return user
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
          if (err instanceof UsersError || err instanceof BoardsError) {
            return json(res, STATUS_BY_CODE[err.code] ?? 400, { ok: false, code: err.code, message: err.message })
          }
          json(res, 500, { ok: false, code: 'E-1109', message: (err as Error).message })
        }
        try {
          Promise.resolve(handler(req, res)).catch(fail)
        } catch (err) {
          fail(err)
        }
      },
    })
  }

  const base = '/dsh-training/console'

  route(`${base}/me`, (req, res) => {
    const user = resolveOrThrow(req)
    const access = checkAccess()
    json(res, 200, {
      ok: true,
      data: { user: user.id, roles: user.roles, isAdmin: user.roles.includes('admin'), level: access.level, code: access.code },
    })
  })

  route(`${base}/bootstrap`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const body = await readBody(req)
    const user = bootstrapAdmin(actorOf(req), body.confirm)
    emitEvent('dsh-training:feature-console:admin-bootstrapped', { user: user.id }, { userId: user.id })
    json(res, 200, { ok: true, data: user })
  })

  route(`${base}/dashboard`, (req, res) => {
    resolveOrThrow(req)
    json(res, 200, { ok: true, data: dashboard() })
  })

  route(`${base}/health`, (req, res) => {
    resolveOrThrow(req)
    json(res, 200, { ok: true, data: health() })
  })

  route(`${base}/users`, (req, res) => {
    requireAdmin(req)
    json(res, 200, { ok: true, data: listUsers() })
  })

  route(`${base}/users/create`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    requireAdmin(req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : id
    // 复用 resolveUser 的校验与自动登记，再补 displayName
    const created = resolveUser(id)
    const user: User = { ...created.user, displayName }
    if (!created.created) throw new HttpError(409, 'E-1101', `用户已存在：${id}`)
    setRole(id, 'trainee', true)
    emitEvent('dsh-training:feature-console:user-created', { user: id, by: actorOf(req) }, { userId: id })
    void user
    json(res, 200, { ok: true, data: { id, displayName } })
  })

  route(`${base}/users/role`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    requireAdmin(req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    const role = (typeof body.role === 'string' ? body.role : 'admin') as Role
    const grant = body.grant !== false
    const user = setRole(id, role, grant)
    emitEvent('dsh-training:feature-console:user-role-changed', { user: user.id, role, grant, by: actorOf(req) }, { userId: user.id })
    emitEvent('dsh-training:feature-console:dashboard-invalidate', { reason: 'role-changed' })
    json(res, 200, { ok: true, data: user })
  })

  route(`${base}/users/disable`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    requireAdmin(req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    const disabled = body.disabled !== false
    const user = setDisabled(id, disabled)
    emitEvent('dsh-training:feature-console:user-disabled', { user: user.id, disabled, by: actorOf(req) }, { userId: user.id })
    emitEvent('dsh-training:feature-console:dashboard-invalidate', { reason: 'user-disabled' })
    json(res, 200, { ok: true, data: user })
  })

  route(`${base}/boards`, (req, res) => {
    resolveOrThrow(req)
    json(res, 200, {
      ok: true,
      data: boardStatus(),
    })
  })

  route(`${base}/boards/toggle`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    requireAdmin(req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    const enabled = body.enabled !== false
    const doc = toggleBoard(id, enabled)
    emitEvent('dsh-training:feature-console:board-toggled', { board: id, enabled, by: actorOf(req) })
    emitEvent('dsh-training:feature-console:dashboard-invalidate', { reason: 'board-toggled' })
    json(res, 200, { ok: true, data: { enabled: doc.enabled } })
  })

  route(`${base}/audit`, (req, res) => {
    requireAdmin(req)
    const file = join(stateDir(), 'event-log.jsonl')
    const rows: { at: string; type: string; payload: unknown }[] = []
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      for (const line of lines.slice(-200)) {
        try {
          const ev = JSON.parse(line) as { at?: string; type?: string; payload?: unknown }
          if (typeof ev.type === 'string' && ev.type.startsWith('dsh-training:feature-console:')) {
            rows.push({ at: ev.at ?? '', type: ev.type, payload: ev.payload ?? null })
          }
        } catch {
          /* skip */
        }
      }
    }
    json(res, 200, { ok: true, data: { total: rows.length, rows: rows.slice(-50).reverse() } })
  })

  console.log(`[dsh-training-console] 已注册 11 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  writeMountEvent('mounted')
  const access = checkAccess()
  console.log(`[dsh-training-console] mounted — v${VERSION} · ${access.level} · admins=${listUsers().adminCount}`)

  ctx.effect(() => {
    console.log('[dsh-training-console] ready')
    return () => {
      writeMountEvent('unmounted')
      console.log('[dsh-training-console] DISPOSED — listeners removed')
    }
  }, 'dsh-training-console: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-console] 注册路由失败：${(err as Error).message}`)
        }
      })
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    }
  } catch (err) {
    console.warn(`[dsh-training-console] 等待 webServer 失败：${(err as Error).message}`)
  }
}

export const __internals = { actorOf, readBody, isAdmin, stateDir, emitEvent, EMITTED_EVENTS }
