/**
 * dsh-training-console · HOST 半（控制台 v0.2.0）
 * ---------------------------------------------------------------------------
 * 身份与权限：
 *   业务等级 LV0/LV1 ← license（training:playground）
 *   管理档位 P0/P6/P7/P8 ← data/admins.json
 *   判定顺序：身份（自动登记）→ 禁用? 拒 → 档位 → LV1 门禁 → 业务
 *
 * 路由 20 条（见 registerRoutes），高危操作需 confirm + reason，成败都写审计。
 * 钱包：消费 tasks:reward 入账（幂等），P8 可发币；/health 做账目对账。
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import { listUsers, migrateLegacyUsers, createUser, resolveUser, setUserDisabled, type UserRow } from './users.js'
import { grantTier, listAdmins, migrateLegacyAdmins, revokeTier, tierOf, type AdminTier } from './admins.js'
import { grantScope, listScopes, revokeScope } from './scopes.js'
import { balanceOf, grantCoins, ingestReward, listLedger } from './wallet.js'
import { listAudit, requireConfirm, writeAudit } from './audit.js'
import { PROTECTED_PACKAGES, isPluginEnabled, setPluginEnabled } from './profile-gate.js'
import { dashboard, health } from './dashboard.js'

export const name = 'dsh-training-console'
export const VERSION = '0.2.0'

export const EMITTED_EVENTS = [
  'dsh-training:console:admin-granted',
  'dsh-training:console:admin-revoked',
  'dsh-training:console:scope-granted',
  'dsh-training:console:scope-revoked',
  'dsh-training:console:user-disabled',
  'dsh-training:console:board-toggled',
  'dsh-training:console:coins-granted',
  'dsh-training:console:dashboard-invalidate',
] as const
export type EmittedEvent = (typeof EMITTED_EVENTS)[number]

/** 板块 id → 插件包名（控制台开关用） */
export const BOARD_TO_PACKAGE: Record<string, string | null> = {
  core: null, // 受保护，无独立插件
  tasks: 'dsh-training-tasks',
  'feature-workbench': 'dsh-training-workbench',
  'feature-community': 'dsh-training-community',
  'feature-collab': 'dsh-training-collab',
  console: 'dsh-training-console',
}

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
    source: 'console',
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
  'E-1102': 403,
  'E-1105': 403,
  'E-1106': 409,
  'E-1108': 403,
  'E-1201': 409,
  'E-1202': 403,
  'E-1203': 400,
  'E-1204': 404,
  'E-1210': 500,
  'E-1211': 503,
  'E-1212': 500,
  'E-1215': 409,
  'E-1220': 500,
  'E-1221': 500,
  'E-1222': 500,
  'E-1223': 500,
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

interface Actor {
  user: UserRow
  tier: 0 | AdminTier
  businessLevel: string
}

function whoIs(req: ServerRequestLike): Actor {
  const { user } = resolveUser(actorOf(req))
  const access = checkAccess()
  return { user, tier: tierOf(user.id), businessLevel: access.level }
}

function requireTier(min: 6 | 7 | 8, req: ServerRequestLike): Actor {
  const actor = whoIs(req)
  if (actor.tier < min) {
    throw new HttpError(403, 'E-1105', `需要 P${min} 及以上管理档位（当前 P${actor.tier || 0}）。`)
  }
  return actor
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
          const code = (err as { code?: string }).code
          if (code && STATUS_BY_CODE[code]) return json(res, STATUS_BY_CODE[code], { ok: false, code, message: (err as Error).message })
          json(res, 500, { ok: false, code: 'E-1209', message: (err as Error).message })
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
    const actor = whoIs(req)
    const access = checkAccess()
    json(res, 200, {
      ok: true,
      data: {
        user: actor.user.id,
        displayName: actor.user.displayName,
        businessLevel: access.level,
        adminTier: actor.tier,
        capabilities: {
          dashboard: actor.tier >= 6,
          audit: actor.tier >= 6,
          boardToggle: actor.tier >= 6,
          userManage: actor.tier >= 7,
          scopeReview: actor.tier >= 7,
          scopeAdmin: actor.tier === 8,
          grantCoins: actor.tier === 8,
        },
      },
    })
  })

  route(`${base}/bootstrap`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const body = await readBody(req)
    const actor = whoIs(req)
    const reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
    if (listAdmins().admins.length > 0) throw new HttpError(409, 'E-1201', '已存在管理档位，bootstrap 仅用于首次初始化。')
    const row = grantTier(actor.user.id, 8, actor.user.id, 8, reason)
    writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: 8, action: 'bootstrap', target: actor.user.id, after: row, reason })
    emitEvent('dsh-training:console:admin-granted', { user: actor.user.id, tier: 8, by: actor.user.id })
    json(res, 200, { ok: true, data: row })
  })

  route(`${base}/dashboard`, (req, res) => {
    requireTier(6, req)
    json(res, 200, { ok: true, data: dashboard() })
  })

  route(`${base}/health`, (req, res) => {
    whoIs(req)
    json(res, 200, { ok: true, data: health() })
  })

  route(`${base}/users`, (req, res) => {
    requireTier(6, req)
    json(res, 200, { ok: true, data: listUsers() })
  })

  route(`${base}/users/create`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = requireTier(7, req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName : id
    try {
      const user = createUser(id, displayName)
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'user-create', target: id, after: { id, displayName }, reason: null })
      json(res, 200, { ok: true, data: user })
    } catch (err) {
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'user-create', target: id, result: 'error', error: (err as Error).message })
      throw err
    }
  })

  route(`${base}/users/disable`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = requireTier(7, req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    const disabled = body.disabled !== false
    let reason = ''
    try {
      reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
      if (id === actor.user.id && disabled) throw new HttpError(400, 'E-1203', '不能禁用自己。')
      const user = setUserDisabled(id, disabled)
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: disabled ? 'user-disable' : 'user-enable', target: id, after: user, reason })
      emitEvent('dsh-training:console:user-disabled', { user: id, disabled, by: actor.user.id })
      json(res, 200, { ok: true, data: user })
    } catch (err) {
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'user-disable', target: id, result: 'error', reason: reason || null, error: (err as Error).message })
      throw err
    }
  })

  route(`${base}/admins`, (req, res) => {
    requireTier(6, req)
    json(res, 200, { ok: true, data: listAdmins() })
  })

  route(`${base}/admins/grant`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = requireTier(7, req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    const tier = Number(body.tier) as AdminTier
    let reason = ''
    try {
      reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
      const row = grantTier(actor.user.id, actor.tier, id, tier, reason)
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'admin-grant', target: id, after: row, reason })
      emitEvent('dsh-training:console:admin-granted', { user: id, tier, by: actor.user.id })
      json(res, 200, { ok: true, data: row })
    } catch (err) {
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'admin-grant', target: id, result: 'error', reason: reason || null, error: (err as Error).message })
      throw err
    }
  })

  route(`${base}/admins/revoke`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = requireTier(7, req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    let reason = ''
    try {
      reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
      const row = revokeTier(actor.user.id, actor.tier, id)
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'admin-revoke', target: id, before: row, reason })
      emitEvent('dsh-training:console:admin-revoked', { user: id, by: actor.user.id })
      json(res, 200, { ok: true, data: { revoked: Boolean(row) } })
    } catch (err) {
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'admin-revoke', target: id, result: 'error', reason: reason || null, error: (err as Error).message })
      throw err
    }
  })

  route(`${base}/scopes`, (req, res) => {
    requireTier(6, req)
    json(res, 200, { ok: true, data: listScopes() })
  })

  for (const action of ['grant', 'revoke'] as const) {
    route(`${base}/scopes/${action}`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
      const actor = requireTier(7, req)
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const scope = typeof body.scope === 'string' ? body.scope : ''
      let reason = ''
      try {
        reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
        const row = action === 'grant' ? grantScope(actor.user.id, actor.tier, id, scope) : revokeScope(actor.user.id, actor.tier, id, scope)
        writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: `scope-${action}`, target: id, after: { scope, row }, reason })
        emitEvent(
          action === 'grant' ? 'dsh-training:console:scope-granted' : 'dsh-training:console:scope-revoked',
          { user: id, scope, by: actor.user.id },
        )
        json(res, 200, { ok: true, data: row })
      } catch (err) {
        writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: `scope-${action}`, target: id, result: 'error', reason: reason || null, error: (err as Error).message })
        throw err
      }
    })
  }

  route(`${base}/boards`, (req, res) => {
    requireTier(6, req)
    const rows = Object.entries(BOARD_TO_PACKAGE).map(([boardId, pkg]) => ({
      board: boardId,
      pkg,
      enabled: pkg ? isPluginEnabled(pkg) : true,
      protected: pkg ? PROTECTED_PACKAGES.includes(pkg as (typeof PROTECTED_PACKAGES)[number]) : true,
    }))
    json(res, 200, { ok: true, data: rows })
  })

  route(`${base}/boards/toggle`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = requireTier(6, req)
    const body = await readBody(req)
    const boardId = typeof body.board === 'string' ? body.board : typeof body.id === 'string' ? body.id : ''
    const enabled = body.enabled !== false
    let reason = ''
    try {
      reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
      const pkg = BOARD_TO_PACKAGE[boardId]
      if (pkg === null || pkg === undefined) {
        throw new HttpError(409, 'E-1106', `板块 ${boardId} 受保护，不能停用（核心板块无独立插件，停用会导致系统不可用）。`)
      }
      const result = setPluginEnabled(pkg, enabled)
      writeAudit({
        actor: actor.user.id,
        businessLevel: actor.businessLevel,
        adminTier: actor.tier,
        action: 'board-toggle',
        target: boardId,
        before: { enabled: !enabled },
        after: { enabled, pkg, restartRequired: result.restartRequired, bundles: result.bundles },
        reason,
      })
      emitEvent('dsh-training:console:board-toggled', { board: boardId, pkg, enabled, by: actor.user.id })
      emitEvent('dsh-training:console:dashboard-invalidate', { reason: 'board-toggled' })
      json(res, 200, { ok: true, data: result })
    } catch (err) {
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'board-toggle', target: boardId, result: 'error', reason: reason || null, error: (err as Error).message })
      throw err
    }
  })

  route(`${base}/wallet/balance`, (req, res) => {
    const actor = requireTier(6, req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const userId = url.searchParams.get('user') ?? actor.user.id
    json(res, 200, { ok: true, data: { user: userId, balance: balanceOf(userId) } })
  })

  route(`${base}/wallet/ledger`, (req, res) => {
    requireTier(6, req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const userId = url.searchParams.get('user') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? 50)
    json(res, 200, { ok: true, data: listLedger(Number.isFinite(limit) ? limit : 50, userId) })
  })

  route(`${base}/wallet/grant`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = requireTier(8, req)
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    const amount = Number(body.amount)
    let reason = ''
    try {
      reason = requireConfirm({ confirm: body.confirm, reason: body.reason })
      const r = grantCoins(actor.user.id, actor.tier, id, amount, reason)
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'coins-grant', target: id, after: { amount, balance: r.balance }, reason })
      emitEvent('dsh-training:console:coins-granted', { user: id, amount, by: actor.user.id, balance: r.balance })
      json(res, 200, { ok: true, data: r })
    } catch (err) {
      writeAudit({ actor: actor.user.id, businessLevel: actor.businessLevel, adminTier: actor.tier, action: 'coins-grant', target: id, result: 'error', reason: reason || null, error: (err as Error).message })
      throw err
    }
  })

  route(`${base}/audit`, (req, res) => {
    requireTier(6, req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const action = url.searchParams.get('action') ?? undefined
    json(res, 200, { ok: true, data: listAudit(Number.isFinite(limit) ? limit : 50, action) })
  })

  route(`${base}/migrate`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1102', message: '只接受 POST。' })
    const actor = whoIs(req)
    const migrated = migrateLegacyUsers()
    const admins = migrateLegacyAdmins(migrated.admins)
    if (migrated.migrated || admins) {
      writeAudit({
        actor: actor.user.id,
        businessLevel: actor.businessLevel,
        adminTier: actor.tier,
        action: 'migrate-legacy',
        target: null,
        after: { users: migrated.migrated, admins },
        reason: 'legacy roles migration',
      })
    }
    json(res, 200, { ok: true, data: { users: migrated.migrated, admins } })
  })

  console.log(`[dsh-training-console] 已注册 20 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  writeMountEvent('mounted')

  // 启动时静默迁移旧数据（roles → 档位）
  try {
    const migrated = migrateLegacyUsers()
    const admins = migrateLegacyAdmins(migrated.admins)
    if (migrated.migrated || admins) {
      console.log(`[dsh-training-console] 迁移旧数据：用户 ${migrated.migrated}，管理员 ${admins}`)
    }
  } catch (err) {
    console.warn(`[dsh-training-console] 迁移失败：${(err as Error).message}`)
  }

  // 订阅任务赏金 → 钱包入账
  try {
    const anyCtx = ctx as unknown as { on?: (type: string, cb: (env: unknown) => void) => unknown }
    if (typeof anyCtx.on === 'function') {
      anyCtx.on('dsh-training:tasks:reward', (env: unknown) => {
        try {
          const e = env as { id?: string; payload?: Record<string, unknown> }
          const to = typeof e.payload?.to === 'string' ? e.payload.to : ''
          const coins = Number(e.payload?.coins ?? 0)
          const r = ingestReward(String(e.id ?? ''), to, coins)
          if (r.credited) {
            console.log(`[dsh-training-console] 赏金入账：${to} +${coins}（余额 ${r.balance}）`)
            emitEvent('dsh-training:console:dashboard-invalidate', { reason: 'reward-credited', user: to })
          }
        } catch (err) {
          console.warn(`[dsh-training-console] 赏金入账失败：${(err as Error).message}`)
        }
      })
      console.log('[dsh-training-console] 已订阅 tasks:reward → 钱包入账')
    }
  } catch (err) {
    console.warn(`[dsh-training-console] 订阅失败：${(err as Error).message}`)
  }

  const access = checkAccess()
  console.log(`[dsh-training-console] mounted — v${VERSION} · ${access.level} · P8=${listAdmins().p8}`)

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

export const __internals = { actorOf, readBody, stateDir, emitEvent, EMITTED_EVENTS, existsSync, readFileSync }
