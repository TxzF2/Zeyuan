/**
 * dsh-training-workbench · HOST 半
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 消费 dsh-training:tasks:task-accepted（总线在线 + 启动补扫）→ 自动建草稿
 *   2. 草稿 REST：me / list / detail / create / save / publish（LV1 才能写；只能改自己的）
 *   3. 发布时发 dsh-training:feature-workbench:draft-published
 *
 * 事件日志：%LOCALAPPDATA%\dsh-training\event-log.jsonl
 * 挂载证据：mount-events.jsonl（plugin=dsh-training-workbench）
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import { isBoardEnabled } from './board-switch.js'
import {
  applySave,
  canEdit,
  createDraft,
  makeId,
  publishDraft,
  validateInput,
  type Draft,
  type DraftStatus,
} from './draft.js'
import { TASK_ACCEPTED, consumeAccepted, replayLog, type Envelope } from './consume.js'
import { StoreError, readDoc, updateDoc } from './store.js'

export const name = 'dsh-training-workbench'
export const VERSION = '0.1.0'

/** 与 packaging/contracts/events.json 保持对等（有测试守护） */
export const EMITTED_EVENTS = [
  'dsh-training:feature-workbench:draft-opened',
  'dsh-training:feature-workbench:draft-saved',
  'dsh-training:feature-workbench:draft-published',
] as const
export type EmittedEvent = (typeof EMITTED_EVENTS)[number]

const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
const MAX_BODY_BYTES = 256 * 1024

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
    source: 'feature-workbench',
    type,
    subject,
    payload,
  }
  try {
    ensureStateDir()
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[dsh-training-workbench] 写事件日志失败：${(err as Error).message}`)
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch (err) {
    console.warn(`[dsh-training-workbench] 总线广播失败：${(err as Error).message}`)
  }
  console.log(`[dsh-training-workbench] event ${type} ${JSON.stringify(payload)}`)
}

function writeMountEvent(event: 'mounted' | 'unmounted'): void {
  try {
    ensureStateDir()
    appendFileSync(
      join(stateDir(), 'mount-events.jsonl'),
      JSON.stringify({
        plugin: name,
        version: VERSION,
        at: new Date().toISOString(),
        pid: process.pid,
        event,
        host: host(),
      }) + '\n',
      'utf8',
    )
  } catch (err) {
    console.warn(`[dsh-training-workbench] 写挂载标记失败：${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------- HTTP 工具
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
  'E-901': 409,
  'E-902': 403,
  'E-903': 400,
  'E-904': 404,
  'E-910': 500,
  'E-911': 503,
  'E-912': 500,
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

function requireLv1(res: ServerResponseLike): void | null {
  const access = checkAccess()
  if (!access.ok) {
    json(res, 403, {
      ok: false,
      code: access.code,
      message: `${access.reason}（LV1 才能编辑/发布草稿，请先在设置里签署协议）`,
      level: access.level,
    })
    return null
  }
  return undefined
}

function findDraft(drafts: Draft[], id: unknown): Draft | undefined {
  return typeof id === 'string' ? drafts.find((d) => d.id === id) : undefined
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
        Promise.resolve(handler(req, res)).catch((err) => {
          if (err instanceof HttpError) {
            json(res, err.status, { ok: false, code: err.code, message: err.message })
            return
          }
          const code = err instanceof StoreError ? err.code : 'E-909'
          json(res, STATUS_BY_CODE[code] ?? 500, { ok: false, code, message: (err as Error).message })
        })
      },
    })
  }

  const base = '/dsh-training/workbench'

  route(`${base}/me`, (req, res) => {
    const access = checkAccess()
    json(res, 200, { ok: true, data: { user: actorOf(req), level: access.level, code: access.code, reason: access.reason } })
  })

  route(`${base}/list`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const actor = actorOf(req)
    const doc = readDoc()
    const status = (url.searchParams.get('status') ?? 'all') as DraftStatus | 'all'
    const mine = url.searchParams.get('mine') === '1'
    const drafts = doc.drafts.filter((d) => {
      if (status !== 'all' && d.status !== status) return false
      if (mine && d.owner !== actor) return false
      return true
    })
    json(res, 200, { ok: true, data: { drafts, total: drafts.length } })
  })

  route(`${base}/detail`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const doc = readDoc()
    const draft = findDraft(doc.drafts, url.searchParams.get('id'))
    if (!draft) return json(res, 404, { ok: false, code: 'E-904', message: '草稿不存在。' })
    json(res, 200, { ok: true, data: draft })
  })

  // 手动新建
  route(`${base}/create`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-905', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const validated = validateInput(body)
    if (!validated.ok) {
      return json(res, 400, { ok: false, code: 'E-903', message: validated.errors.join('；'), errors: validated.errors })
    }
    const actor = actorOf(req)
    const draft = updateDoc((doc) => {
      const now = new Date()
      const seq = doc.seq + 1
      const created = createDraft(validated.value, makeId(now, seq), { owner: actor, now })
      return { doc: { ...doc, seq, drafts: [...doc.drafts, created] }, result: created }
    })
    emitEvent('dsh-training:feature-workbench:draft-opened', { draftId: draft.id, owner: actor }, { draftId: draft.id })
    json(res, 200, { ok: true, data: draft })
  })

  // 保存
  route(`${base}/save`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-905', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const draft = updateDoc((doc) => {
      const current = findDraft(doc.drafts, body.id)
      if (!current) throw new HttpError(404, 'E-904', '草稿不存在。')
      const check = canEdit(current, actor)
      if (!check.ok) throw new HttpError(STATUS_BY_CODE[check.code] ?? 400, check.code, check.reason)
      const validated = validateInput({ title: body.title ?? current.title, body: body.body ?? current.body, tags: body.tags ?? current.tags })
      if (!validated.ok) throw new HttpError(400, 'E-903', validated.errors.join('；'))
      const now = new Date()
      const next = applySave(current, validated.value, now)
      return { doc: { ...doc, drafts: doc.drafts.map((d) => (d.id === current.id ? next : d)) }, result: next }
    })
    emitEvent('dsh-training:feature-workbench:draft-saved', { draftId: draft.id, by: actor }, { draftId: draft.id })
    json(res, 200, { ok: true, data: draft })
  })

  // 发布
  route(`${base}/publish`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-905', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const draft = updateDoc((doc) => {
      const current = findDraft(doc.drafts, body.id)
      if (!current) throw new HttpError(404, 'E-904', '草稿不存在。')
      const check = canEdit(current, actor)
      if (!check.ok) throw new HttpError(STATUS_BY_CODE[check.code] ?? 400, check.code, check.reason)
      if (!current.body.trim()) throw new HttpError(400, 'E-903', '正文为空，不能发布。')
      const next = publishDraft(current, new Date())
      return { doc: { ...doc, drafts: doc.drafts.map((d) => (d.id === current.id ? next : d)) }, result: next }
    })
    emitEvent(
      'dsh-training:feature-workbench:draft-published',
      { draftId: draft.id, owner: draft.owner, sourceTaskId: draft.sourceTaskId },
      { draftId: draft.id },
    )
    json(res, 200, { ok: true, data: draft })
  })

  // 手动补扫：运维兜底（也供测试），把日志里漏掉的 task-accepted 重新消费
  route(`${base}/replay`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-905', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const r = replayLog()
    json(res, 200, { ok: true, data: r })
  })

  console.log(`[dsh-training-workbench] 已注册 7 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  if (!isBoardEnabled('feature-workbench')) {
    console.log('[dsh-training-workbench] 已在控制面板中停用，跳过路由与事件订阅')
    writeMountEvent('mounted')
    ctx.effect(() => () => writeMountEvent('unmounted'), 'dsh-training-workbench: disabled marker')
    return
  }
  bus = ctx
  writeMountEvent('mounted')

  const access = checkAccess()
  console.log(`[dsh-training-workbench] mounted — v${VERSION} · ${access.level} · ${access.code}`)

  // 订阅任务验收事件
  try {
    const anyCtx = ctx as unknown as { on?: (type: string, cb: (env: Envelope) => void) => unknown }
    if (typeof anyCtx.on === 'function') {
      anyCtx.on(TASK_ACCEPTED, (env: Envelope) => {
        try {
          const r = consumeAccepted(env)
          // 自动建稿也要发事件（与手动 create 保持一致）
          if (r.created && r.draftId) {
            emitEvent(
              'dsh-training:feature-workbench:draft-opened',
              { draftId: r.draftId, owner: env.payload?.to ?? env.payload?.assignee ?? null, sourceTaskId: env.payload?.taskId ?? null, via: 'task-accepted' },
              { draftId: r.draftId },
            )
          }
          console.log(`[dsh-training-workbench] 消费 ${TASK_ACCEPTED} → created=${r.created} ${r.reason ?? r.draftId ?? ''}`)
        } catch (err) {
          console.warn(`[dsh-training-workbench] 消费事件失败：${(err as Error).message}`)
        }
      })
      console.log('[dsh-training-workbench] 已订阅 tasks:task-accepted')
    }
  } catch (err) {
    console.warn(`[dsh-training-workbench] 订阅失败：${(err as Error).message}`)
  }

  // 启动补扫（补工作台未加载时错过的事件）
  try {
    const r = replayLog()
    if (r.scanned > 0) {
      for (const draftId of r.drafts ?? []) {
        emitEvent('dsh-training:feature-workbench:draft-opened', { draftId, via: 'replay' }, { draftId })
      }
      console.log(`[dsh-training-workbench] 补扫事件日志：命中 ${r.scanned} 条 task-accepted，新建草稿 ${r.created} 份`)
    }
  } catch (err) {
    console.warn(`[dsh-training-workbench] 补扫失败：${(err as Error).message}`)
  }

  ctx.effect(() => {
    console.log('[dsh-training-workbench] ready')
    return () => {
      writeMountEvent('unmounted')
      console.log('[dsh-training-workbench] DISPOSED — listeners removed')
    }
  }, 'dsh-training-workbench: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-workbench] 注册路由失败：${(err as Error).message}`)
        }
      })
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    }
  } catch (err) {
    console.warn(`[dsh-training-workbench] 等待 webServer 失败：${(err as Error).message}`)
  }
}

export const __internals = { actorOf, readBody, findDraft, stateDir, emitEvent, EMITTED_EVENTS, existsSync, readFileSync, join }
