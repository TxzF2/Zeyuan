/**
 * dsh-training-tasks · HOST 半
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 任务 REST 路由（list / detail / me / create / claim / submit / accept / reject）
 *   2. 权限闸门：LV1 才能创建/领取/提交；accept/reject 仅限发起人；领取人才能提交
 *   3. 状态机迁移 + 事件落盘（dsh-training:tasks:*）
 *   4. accept 时发 dsh-training:tasks:reward —— 只发事件，**不自己结算金币**
 *
 * 事件日志：%LOCALAPPDATA%\dsh-training\event-log.jsonl（追加写，一行一条）
 * 挂载证据：mount-events.jsonl（plugin=dsh-training-tasks，供 3.1 验收查）
 *
 * 路由只在宿主提供 webServer 时注册（ctx.inject 动态等待）；裸 Context 下插件
 * 仍可 apply（单测/冒烟需要），不因缺 webServer 拒绝加载。
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir, type AccessResult } from './license-gate.js'
import { isBoardEnabled } from './board-switch.js'
import {
  ACTIONS,
  checkAction,
  createTask,
  filterTasks,
  makeId,
  validateCreate,
  type Task,
  type TaskAction,
  type TaskStatus,
} from './task.js'
import { canSeeTask, findGroup, isLeader, isMember, tierOf } from './groups-gate.js'
import { StoreError, readDoc, updateDoc } from './store.js'

export const name = 'dsh-training-tasks'
export const VERSION = '0.1.0'

/** 本板块允许发出的事件（与 packaging/contracts/events.json 保持对等，有测试守护） */
export const EMITTED_EVENTS = [
  'dsh-training:tasks:task-created',
  'dsh-training:tasks:task-claimed',
  'dsh-training:tasks:task-submitted',
  'dsh-training:tasks:task-accepted',
  'dsh-training:tasks:task-rejected',
  'dsh-training:tasks:reward',
  'dsh-training:tasks:task-grouped',
  'dsh-training:tasks:task-reassigned',
] as const
export type EmittedEvent = (typeof EMITTED_EVENTS)[number]

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

/** 业务错误码 → HTTP 状态 */
const STATUS_BY_CODE: Record<string, number> = {
  'E-801': 409,
  'E-802': 403,
  'E-803': 400,
  'E-804': 404,
  'E-810': 500,
  'E-811': 503,
  'E-812': 500,
}

const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
const MAX_BODY_BYTES = 64 * 1024

const host = (): string => (process.versions.electron ? 'electron' : 'node')

/** 进程内事件总线引用（apply 时注入；单测可为 null） */
let bus: Context | null = null

function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true })
}

/** 事件日志（追加；结算由货币系统消费，这里只负责"说出来"） */
export function emitEvent(
  type: EmittedEvent,
  payload: Record<string, unknown>,
  subject: Record<string, unknown> = {},
): void {
  const envelope = {
    v: 1,
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source: 'tasks',
    type,
    subject,
    payload,
  }
  try {
    ensureStateDir()
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[dsh-training-tasks] 写事件日志失败（不影响业务）：${(err as Error).message}`)
  }
  // 进程内广播（工作台等板块签听）；无 bus 时仅落日志
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch (err) {
    console.warn(`[dsh-training-tasks] 总线广播失败：${(err as Error).message}`)
  }
  console.log(`[dsh-training-tasks] event ${type} ${JSON.stringify(payload)}`)
}

/** 挂载事件（供验收脚本查：plugin=dsh-training-tasks, host=electron） */
function writeMountEvent(event: 'mounted' | 'unmounted'): void {
  try {
    ensureStateDir()
    const line =
      JSON.stringify({
        plugin: name,
        version: VERSION,
        at: new Date().toISOString(),
        pid: process.pid,
        event,
        host: host(),
      }) + '\n'
    appendFileSync(join(stateDir(), 'mount-events.jsonl'), line, 'utf8')
  } catch (err) {
    console.warn(`[dsh-training-tasks] 写挂载标记失败：${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------- 工具
function tierOfSafe(userId: string): number {
  try {
    return tierOf(userId)
  } catch {
    return 0
  }
}

function json(res: ServerResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
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

function actorOf(req: ServerRequestLike): string {
  const raw = req.headers[ACTOR_HEADER]
  const v = Array.isArray(raw) ? raw[0] : raw
  const actor = typeof v === 'string' ? v.trim() : ''
  return actor || DEFAULT_ACTOR
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

function requireLv1(res: ServerResponseLike): AccessResult | null {
  const access = checkAccess()
  if (!access.ok) {
    json(res, 403, {
      ok: false,
      code: access.code,
      message: `${access.reason}（LV1 才能发布/领取/提交任务，请先在设置里签署协议）`,
      level: access.level,
    })
    return null
  }
  return access
}

function findTask(tasks: Task[], id: unknown): Task | undefined {
  return typeof id === 'string' ? tasks.find((t) => t.id === id) : undefined
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
          const code = err instanceof StoreError ? err.code : 'E-809'
          json(res, STATUS_BY_CODE[code] ?? 500, { ok: false, code, message: (err as Error).message })
        })
      },
    })
  }

  const base = '/dsh-training/tasks'

  // 当前身份与等级（UI 首屏用）
  route(`${base}/me`, (req, res) => {
    const access = checkAccess()
    json(res, 200, {
      ok: true,
      data: { user: actorOf(req), level: access.level, code: access.code, reason: access.reason },
    })
  })

  // 列表
  route(`${base}/list`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const actor = actorOf(req)
    const doc = readDoc()
    const status = (url.searchParams.get('status') ?? 'all') as TaskStatus | 'all'
    const tag = url.searchParams.get('tag') ?? undefined
    const mine = url.searchParams.get('mine') === '1'
    const visible = doc.tasks.filter((t) => canSeeTask(t, actor))
    const tasks = filterTasks(visible, { status, tag, mine, actor })
    const tags = [...new Set(doc.tasks.filter((t) => canSeeTask(t, actor)).flatMap((t) => t.tags))].sort()
    json(res, 200, { ok: true, data: { tasks, total: tasks.length, tags } })
  })

  // 详情
  route(`${base}/detail`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const doc = readDoc()
    const task = findTask(doc.tasks, url.searchParams.get('id'))
    if (!task) return json(res, 404, { ok: false, code: 'E-804', message: '任务不存在。' })
    if (!canSeeTask(task, actorOf(req))) return json(res, 404, { ok: false, code: 'E-804', message: '任务不存在。' })
    json(res, 200, { ok: true, data: task })
  })

  // 创建（LV1）
  route(`${base}/create`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-805', message: '只接受 POST。' })
    const access = requireLv1(res)
    if (!access) return
    const body = await readBody(req)
    const validated = validateCreate(body)
    if (!validated.ok) {
      return json(res, 400, { ok: false, code: 'E-803', message: validated.errors.join('；'), errors: validated.errors })
    }
    const actor = actorOf(req)
    const task = updateDoc((doc) => {
      const now = new Date()
      const seq = doc.seq + 1
      const created = createTask(validated.value, actor, makeId(now, seq), now)
      return { doc: { ...doc, seq, tasks: [...doc.tasks, created] }, result: created }
    })
    emitEvent('dsh-training:tasks:task-created', { taskId: task.id, bounty: task.bounty, creator: actor }, { taskId: task.id })
    json(res, 200, { ok: true, data: task })
  })

  // 领取 / 提交 / 验收 / 驳回
  for (const action of ACTIONS) {
    route(`${base}/${action}`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-805', message: '只接受 POST。' })
      const access = requireLv1(res)
      if (!access) return
      const body = await readBody(req)
      const actor = actorOf(req)
      const id = body.id
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined

      const task = updateDoc((doc) => {
        const current = findTask(doc.tasks, id) as Task | undefined
        if (!current) throw new HttpError(404, 'E-804', '任务不存在。')
        if (current.groupId && !isMember(current.groupId, actor)) throw new HttpError(403, 'E-806', '这是组内任务，只有本组成员可以操作。')
        const check = checkAction(current, action as TaskAction, actor)
        if (!check.ok) throw new HttpError(STATUS_BY_CODE[check.code] ?? 400, check.code, check.reason)
        const now = new Date()
        const rule = { claim: 'claimed', submit: 'submitted', accept: 'accepted', reject: 'open' } as const
        const next: Task = {
          ...current,
          status: rule[action as TaskAction] as TaskStatus,
          assignee: action === 'claim' ? actor : action === 'reject' ? null : current.assignee,
          updatedAt: now.toISOString(),
          history: [
            ...current.history,
            {
              at: now.toISOString(),
              action: action as TaskAction,
              from: current.status,
              to: rule[action as TaskAction] as TaskStatus,
              by: actor,
              ...(reason ? { reason } : {}),
            },
          ],
        }
        return { doc: { ...doc, tasks: doc.tasks.map((t) => (t.id === current.id ? next : t)) }, result: next }
      })

      const eventMap: Record<TaskAction, EmittedEvent> = {
        claim: 'dsh-training:tasks:task-claimed',
        submit: 'dsh-training:tasks:task-submitted',
        accept: 'dsh-training:tasks:task-accepted',
        reject: 'dsh-training:tasks:task-rejected',
      }
      emitEvent(
        eventMap[action as TaskAction],
        {
          taskId: task.id,
          by: actor,
          assignee: task.assignee,
          creator: task.creator,
          ...(action === 'accept' ? { to: task.assignee } : {}),
          ...(reason ? { reason } : {}),
        },
        { taskId: task.id },
      )

      // 验收通过 → 赏金结算请求（本板块不记账，交给货币系统）
      if (action === 'accept') {
        emitEvent(
          'dsh-training:tasks:reward',
          { taskId: task.id, coins: task.bounty, to: task.assignee, from: task.creator },
          { taskId: task.id },
        )
      }

      json(res, 200, { ok: true, data: task })
    })
  }

  // 挂组：任务发起人把任务指派到自己的组（组必须存在）
  route(`${base}/attach-group`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-805', message: '只接受 POST。' })
    const access = requireLv1(res)
    if (!access) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const groupId = typeof body.groupId === 'string' ? body.groupId : null
    const group = findGroup(groupId)
    if (!groupId || !group) return json(res, 404, { ok: false, code: 'E-804', message: '分组不存在。' })
    if (!isLeader(groupId, actor) && tierOfSafe(actor) < 7) {
      return json(res, 403, { ok: false, code: 'E-802', message: '只有组长或 P7+ 可以把任务挂到组。' })
    }
    const task = updateDoc((doc) => {
      const current = findTask(doc.tasks, body.id)
      if (!current) throw new HttpError(404, 'E-804', '任务不存在。')
      if (current.creator !== actor && !isLeader(groupId, actor) && tierOfSafe(actor) < 7) {
        throw new HttpError(403, 'E-802', '只有任务发起人或组长可以挂组。')
      }
      const next: Task = { ...current, groupId, updatedAt: new Date().toISOString() }
      return { doc: { ...doc, tasks: doc.tasks.map((t) => (t.id === next.id ? next : t)) }, result: next }
    })
    emitEvent('dsh-training:tasks:task-grouped', { taskId: task.id, groupId, by: actor }, { taskId: task.id })
    json(res, 200, { ok: true, data: task })
  })

  // 改派：组长（或 P7+）把组任务改派给本组成员
  route(`${base}/reassign`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-805', message: '只接受 POST。' })
    const access = requireLv1(res)
    if (!access) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const task = updateDoc((doc) => {
      const current = findTask(doc.tasks, body.id)
      if (!current) throw new HttpError(404, 'E-804', '任务不存在。')
      if (!current.groupId) throw new HttpError(400, 'E-803', '不是组内任务，无法改派。')
      if (!isLeader(current.groupId, actor) && tierOfSafe(actor) < 7) {
        throw new HttpError(403, 'E-802', '只有组长或 P7+ 可以改派组内任务。')
      }
      const target = typeof body.assignee === 'string' ? body.assignee : ''
      if (!isMember(current.groupId, target)) throw new HttpError(400, 'E-803', '只能改派给本组成员。')
      const now = new Date()
      const next: Task = { ...current, assignee: target, updatedAt: now.toISOString() }
      return { doc: { ...doc, tasks: doc.tasks.map((t) => (t.id === next.id ? next : t)) }, result: next }
    })
    emitEvent('dsh-training:tasks:task-reassigned', { taskId: task.id, assignee: task.assignee, by: actor }, { taskId: task.id })
    json(res, 200, { ok: true, data: task })
  })

  console.log(`[dsh-training-tasks] 已注册 10 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 插件入口
export function apply(ctx: Context): void {
  if (!isBoardEnabled('tasks')) {
    console.log('[dsh-training-tasks] 已在控制面板中停用，跳过路由与事件订阅')
    writeMountEvent('mounted')
    ctx.effect(() => () => writeMountEvent('unmounted'), 'dsh-training-tasks: disabled marker')
    return
  }
  bus = ctx
  writeMountEvent('mounted')

  const access = checkAccess()
  console.log(`[dsh-training-tasks] mounted — v${VERSION} · ${access.level} · ${access.code}`)
  if (!access.ok) console.log(`[dsh-training-tasks] ${access.reason}（任务可浏览，领取/提交需 LV1）`)

  ctx.effect(() => {
    console.log('[dsh-training-tasks] ready')
    return () => {
      writeMountEvent('unmounted')
      console.log('[dsh-training-tasks] DISPOSED — listeners removed')
    }
  }, 'dsh-training-tasks: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-tasks] 注册路由失败：${(err as Error).message}`)
        }
      })
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    } else {
      console.log('[dsh-training-tasks] 无 webServer，路由跳过（插件仍可用）')
    }
  } catch (err) {
    console.warn(`[dsh-training-tasks] 等待 webServer 失败：${(err as Error).message}`)
  }
}

// 便于测试直接调用
export const __internals = {
  actorOf,
  readBody,
  findTask,
  stateDir,
  emitEvent,
  EMITTED_EVENTS,
  existsSync,
  readFileSync,
  join,
}
