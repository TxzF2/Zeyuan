/**
 * dsh-training... → 泽元 IM 机器人 · HOST 半（R-219 钉钉协作层）
 * ---------------------------------------------------------------------------
 * 能力：
 *   1) 配置：data/im.json（webhook + secret，本地存储；对外只回脱敏形式）
 *   2) 测试：POST /zeyuan/im/test 发一条测试消息（验证连通）
 *   3) 订阅任务事件：zeyuan:tasks:task-claimed / task-accepted / task-rejected
 *      → 推送到钉钉群（markdown）
 *
 * 权限：配置与测试需 P6+（读 admins.json 档位），避免普通学员改推送目标。
 * 未配置时：事件只记日志，不报错（不阻塞任务流程）。
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import { readJson, withLock, writeJsonAtomic } from './store.js'
import { maskWebhook, markdownMessage, renderTaskEvent, sendDingTalk, textMessage, type DingTalkConfig, type TaskEventPayload } from './push.js'

export const name = 'zeyuan-im'
export const VERSION = '0.1.0'
export const EMITTED_EVENTS = ['zeyuan:im:notified', 'zeyuan:im:push-failed'] as const

const CONFIG_FILE = 'im.json'
const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
let bus: Context | null = null

interface ImDoc {
  schemaVersion: number
  dingtalk: DingTalkConfig
  updatedAt: string | null
}

const configPath = (): string => join(stateDir(), 'data', CONFIG_FILE)

export function readConfig(): ImDoc {
  const doc = readJson<ImDoc>(configPath(), { schemaVersion: 1, dingtalk: { webhook: '', enabled: false }, updatedAt: null })
  return { schemaVersion: 1, dingtalk: { webhook: doc.dingtalk?.webhook ?? '', secret: doc.dingtalk?.secret ?? '', enabled: doc.dingtalk?.enabled ?? false }, updatedAt: doc.updatedAt ?? null }
}

export function writeConfig(dingtalk: DingTalkConfig): ImDoc {
  const doc: ImDoc = { schemaVersion: 1, dingtalk: { ...dingtalk, enabled: dingtalk.enabled !== false }, updatedAt: new Date().toISOString() }
  writeJsonAtomic(configPath(), doc)
  return doc
}

function tierOf(userId: string): number {
  try {
    const f = join(stateDir(), 'data', 'admins.json')
    if (!existsSync(f)) return 0
    const d = JSON.parse(readFileSync(f, 'utf8')) as { admins?: { userId: string; tier: number }[] }
    return d.admins?.find((a) => a.userId === userId)?.tier ?? 0
  } catch {
    return 0
  }
}

function logEvent(type: string, payload: Record<string, unknown>): void {
  const env = { event: type, id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), actor: (payload.by as string) ?? null, payload }
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(env) + '\n', 'utf8')
  } catch {
    /* ignore */
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, env)
  } catch {
    /* ignore */
  }
}

/** 推送任务事件到钉钉（供事件订阅与测试调用） */
export async function notifyTaskEvent(kind: 'claimed' | 'accepted' | 'rejected', payload: TaskEventPayload): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const cfg = readConfig().dingtalk
  if (!cfg.webhook || cfg.enabled === false) {
    console.log(`[zeyuan-im] 未配置钉钉 webhook，跳过 ${kind}（任务 ${payload.taskId ?? '-'}）`)
    return { ok: false, skipped: 'not-configured' }
  }
  const { title, text } = renderTaskEvent(kind, payload)
  const r = await sendDingTalk(cfg, markdownMessage(title, text))
  if (r.ok) {
    logEvent('zeyuan:im:notified', { kind, taskId: payload.taskId, title })
    console.log(`[zeyuan-im] 已推送 ${kind}（任务 ${payload.taskId ?? '-'}）attempts=${r.attempts}`)
    return { ok: true }
  }
  logEvent('zeyuan:im:push-failed', { kind, taskId: payload.taskId, error: r.error })
  console.warn(`[zeyuan-im] 推送失败 ${kind}：${r.error}`)
  return { ok: false, error: r.error }
}

// ---------------------------------------------------------------- HTTP
class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface Req {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(ev: 'data' | 'end' | 'error', cb: (c?: unknown) => void): void
}
interface Res {
  writeHead(s: number, h: Record<string, string>): void
  end(b?: string): void
}

const json = (res: Res, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const actorOf = (req: Req) => {
  const raw = req.headers[ACTOR_HEADER]
  const v = Array.isArray(raw) ? raw[0] : raw
  return (typeof v === 'string' ? v.trim() : '') || DEFAULT_ACTOR
}
const readBody = (req: Req) =>
  new Promise<Record<string, unknown>>((resolve) => {
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

function registerRoutes(ctx: Context): void {
  const web = (ctx as unknown as { webServer?: { register(s: unknown): unknown } }).webServer
  if (!web?.register) return
  const route = (path: string, handler: (req: Req, res: Res) => void | Promise<void>) => {
    web.register({
      kind: 'exact',
      path,
      handler: (req: Req, res: Res) => {
        const fail = (err: unknown) => json(res, (err as HttpError).status ?? 500, { ok: false, code: (err as HttpError).code ?? 'E-2009', message: (err as Error).message })
        try {
          Promise.resolve(handler(req, res)).catch(fail)
        } catch (err) {
          fail(err)
        }
      },
    })
  }
  const base = '/zeyuan/im'
  const requireAdmin = (req: Req) => {
    const actor = actorOf(req)
    if (tierOf(actor) < 6) throw new HttpError(403, 'E-2001', '需要 P6 及以上管理档位')
    return actor
  }

  /** 读取配置（脱敏） */
  route(`${base}/config`, (req, res) => {
    requireAdmin(req)
    const cfg = readConfig()
    json(res, 200, {
      ok: true,
      data: {
        enabled: cfg.dingtalk.enabled !== false,
        webhook: maskWebhook(cfg.dingtalk.webhook),
        webhookConfigured: Boolean(cfg.dingtalk.webhook),
        secretConfigured: Boolean(cfg.dingtalk.secret),
        updatedAt: cfg.updatedAt,
      },
    })
  })

  /** 设置 webhook / secret（P6+） */
  route(`${base}/config`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-2005', message: '只接受 POST' })
    requireAdmin(req)
    const body = await readBody(req)
    const webhook = typeof body.webhook === 'string' ? body.webhook.trim() : ''
    if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=/.test(webhook)) {
      return json(res, 400, { ok: false, code: 'E-2003', message: 'webhook 需为 https://oapi.dingtalk.com/robot/send?access_token=…' })
    }
    const doc = withLock('im-config', () =>
      writeConfig({ webhook, secret: typeof body.secret === 'string' ? body.secret.trim() : '', enabled: body.enabled !== false }),
    )
    json(res, 200, { ok: true, data: { webhook: maskWebhook(doc.dingtalk.webhook), secretConfigured: Boolean(doc.dingtalk.secret) } })
  })

  /** 发测试消息（验证连通） */
  route(`${base}/test`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-2005', message: '只接受 POST' })
    const actor = requireAdmin(req)
    const cfg = readConfig().dingtalk
    if (!cfg.webhook) throw new HttpError(400, 'E-2002', '尚未配置 webhook')
    const body = await readBody(req)
    const content = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : `泽元连通性测试（by ${actor}）`
    const r = await sendDingTalk(cfg, textMessage(`【泽元】${content}`))
    json(res, r.ok ? 200 : 502, { ok: r.ok, data: { attempts: r.attempts, errcode: r.errcode, errmsg: r.errmsg }, message: r.ok ? '已发送' : r.error })
  })

  console.log(`[zeyuan-im] 已注册 3 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  mkdirSync(stateDir(), { recursive: true })
  try {
    appendFileSync(
      join(stateDir(), 'mount-events.jsonl'),
      JSON.stringify({ plugin: name, version: VERSION, at: new Date().toISOString(), pid: process.pid, event: 'mounted', host: process.versions.electron ? 'electron' : 'node' }) + '\n',
      'utf8',
    )
  } catch (err) {
    console.warn('[zeyuan-im] 写挂载标记失败：' + (err as Error).message)
  }
  const cfg = readConfig().dingtalk
  console.log(`[zeyuan-im] mounted — v${VERSION} · dingtalk=${cfg.webhook ? 'configured' : 'not-configured'}`)

  // 订阅任务事件 → 钉钉
  try {
    const anyCtx = ctx as unknown as { on?: (t: string, cb: (env: unknown) => void) => unknown }
    if (typeof anyCtx.on === 'function') {
      const map: Array<['claimed' | 'accepted' | 'rejected', string]> = [
        ['claimed', 'zeyuan:tasks:task-claimed'],
        ['accepted', 'zeyuan:tasks:task-accepted'],
        ['rejected', 'zeyuan:tasks:task-rejected'],
      ]
      for (const [kind, evt] of map) {
        anyCtx.on(evt, (env: unknown) => {
          const e = env as { payload?: Record<string, unknown> }
          const p = (e.payload ?? {}) as TaskEventPayload
          void notifyTaskEvent(kind, { ...p, actor: (p.actor as string) ?? undefined })
        })
      }
      console.log('[zeyuan-im] 已订阅 tasks:claimed/accepted/rejected')
    }
  } catch (err) {
    console.warn(`[zeyuan-im] 订阅失败：${(err as Error).message}`)
  }

  ctx.effect(() => {
    console.log('[zeyuan-im] ready')
    return () => console.log('[zeyuan-im] DISPOSED')
  }, 'zeyuan-im: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (d: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') anyCtx.inject(['webServer'], (inner: Context) => registerRoutes(inner))
    else if ((ctx as unknown as { webServer?: unknown }).webServer) registerRoutes(ctx)
  } catch (err) {
    console.warn(`[zeyuan-im] 注册路由失败：${(err as Error).message}`)
  }
}

export const __internals = { readConfig, maskWebhook }
export { checkAccess }
