/**
 * dsh-training-collab · HOST 半
 * ---------------------------------------------------------------------------
 * 固定编制（1 组长 + 3 组员）：
 *   forming → 满编且分工齐 → activate → active（才能发布/改派组任务）
 * 组长边界：可发任务到组、改派、申请金币；**不能直接动钱包**（审批在控制台 P7+）
 * 组任务仅组内可见：由 tasks 侧读 data/groups.json 判定
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import { readJson, withLock, writeJsonAtomic } from './store.js'
import {
  CollabError,
  activateGroup,
  archiveGroup,
  attachTask,
  canActivate,
  createGroup,
  doneReview,
  isMember,
  joinGroup,
  leaveGroup,
  makeId,
  memberOf,
  removeMember,
  requestReview,
  setDuty,
  transferLeader,
  validateCreate,
  validateDuty,
  type Group,
} from './model.js'
import { requestCoins, listCoinRequests } from './coin.js'

export const name = 'dsh-training-collab'
export const VERSION = '0.1.0'

export const EMITTED_EVENTS = [
  'dsh-training:collab:group-formed',
  'dsh-training:collab:member-joined',
  'dsh-training:collab:member-left',
  'dsh-training:collab:duty-changed',
  'dsh-training:collab:group-activated',
  'dsh-training:collab:task-assigned',
  'dsh-training:collab:task-reassigned',
  'dsh-training:collab:review-requested',
  'dsh-training:collab:review-done',
  'dsh-training:collab:coins-requested',
] as const
export type EmittedEvent = (typeof EMITTED_EVENTS)[number]

const ACTOR_HEADER = 'x-dsh-user'
const DEFAULT_ACTOR = 'local-user'
const MAX_BODY_BYTES = 64 * 1024
const TASKS_BASE = 'http://127.0.0.1:19387/dsh-training/tasks'

const host = (): string => (process.versions.electron ? 'electron' : 'node')
let bus: Context | null = null

function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true })
}

export function emitEvent(type: EmittedEvent, payload: Record<string, unknown>): void {
  const envelope = { v: 1, id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), source: 'collab', type, subject: {}, payload }
  try {
    ensureStateDir()
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[collab] 写事件日志失败：${(err as Error).message}`)
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch {
    /* ignore */
  }
  console.log(`[collab] event ${type} ${JSON.stringify(payload)}`)
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
    console.warn(`[collab] 写挂载标记失败：${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------- 存储
interface GroupsDoc {
  schemaVersion: number
  seq: number
  groups: Group[]
}

const groupsPath = (): string => join(stateDir(), 'data', 'groups.json')

function readGroups(): GroupsDoc {
  const doc = readJson<GroupsDoc>(groupsPath(), { schemaVersion: 1, seq: 0, groups: [] })
  return { schemaVersion: 1, seq: Number.isInteger(doc.seq) ? doc.seq : 0, groups: Array.isArray(doc.groups) ? doc.groups : [] }
}

function writeGroups(doc: GroupsDoc): void {
  writeJsonAtomic(groupsPath(), doc)
}

function updateGroups<T>(fn: (doc: GroupsDoc) => { doc: GroupsDoc; result: T }): T {
  return withLock('groups', () => {
    const doc = readGroups()
    const { doc: next, result } = fn(doc)
    writeGroups(next)
    return result
  })
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
  'E-1301': 409,
  'E-1302': 403,
  'E-1303': 400,
  'E-1304': 404,
  'E-1108': 403,
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

function requireLv1(res: ServerResponseLike): boolean {
  const access = checkAccess()
  if (!access.ok) {
    json(res, 403, { ok: false, code: access.code, message: `${access.reason}（LV1 才能使用协作分组）` })
    return false
  }
  return true
}

async function callTasks(path: string, body: Record<string, unknown>, actor: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${TASKS_BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-user': actor },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!res.ok || data.ok === false) {
    throw new HttpError(res.status, String(data.code ?? 'E-1309'), String(data.message ?? '任务服务调用失败'))
  }
  return data.data as Record<string, unknown>
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
          if (err instanceof CollabError) return json(res, STATUS_BY_CODE[err.code] ?? 400, { ok: false, code: err.code, message: err.message })
          const code = (err as { code?: string }).code
          if (code && STATUS_BY_CODE[code]) return json(res, STATUS_BY_CODE[code], { ok: false, code, message: (err as Error).message })
          json(res, 500, { ok: false, code: 'E-1309', message: (err as Error).message })
        }
        try {
          Promise.resolve(handler(req, res)).catch(fail)
        } catch (err) {
          fail(err)
        }
      },
    })
  }

  const base = '/dsh-training/collab'

  const findGroup = (id: unknown): Group => {
    const doc = readGroups()
    const g = typeof id === 'string' ? doc.groups.find((x) => x.id === id) : undefined
    if (!g) throw new CollabError('E-1304', '分组不存在。')
    return g
  }

  route(`${base}/me`, (req, res) => {
    const actor = actorOf(req)
    const access = checkAccess()
    const doc = readGroups()
    const my = doc.groups.find((g) => isMember(g, actor)) ?? null
    json(res, 200, {
      ok: true,
      data: { user: actor, level: access.level, group: my ? { id: my.id, name: my.name, status: my.status, leader: my.leader === actor } : null },
    })
  })

  route(`${base}/groups`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const status = url.searchParams.get('status')
    const rows = readGroups().groups.filter((g) => (status ? g.status === status : g.status !== 'archived'))
    json(res, 200, { ok: true, data: rows })
  })

  route(`${base}/group`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    json(res, 200, { ok: true, data: findGroup(url.searchParams.get('id')) })
  })

  route(`${base}/group/create`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const validated = validateCreate(body)
    if (!validated.ok) return json(res, 400, { ok: false, code: 'E-1303', message: validated.errors.join('；'), errors: validated.errors })
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      if (doc.groups.some((g) => isMember(g, actor))) throw new HttpError(409, 'E-1301', '你已经在一个组里了。')
      const now = new Date()
      const seq = doc.seq + 1
      const g = createGroup(validated.value, actor, makeId(now, seq), now)
      return { doc: { ...doc, seq, groups: [...doc.groups, g] }, result: g }
    })
    emitEvent('dsh-training:collab:group-formed', { groupId: group.id, leader: actor })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/join`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const duty = validateDuty(body.duty ?? 'build')
    const group = updateGroups((doc) => {
      if (doc.groups.some((g) => isMember(g, actor))) throw new HttpError(409, 'E-1301', '你已经在一个组里了。')
      const target = doc.groups.find((g) => g.id === body.id)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      const next = joinGroup(target, actor, duty)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:member-joined', { groupId: group.id, user: actor, duty })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/leave`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.id)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      const next = leaveGroup(target, actor)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:member-left', { groupId: group.id, user: actor })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/duty`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const duty = validateDuty(body.duty)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.id)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      if (target.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以调整分工。')
      const next = setDuty(target, String(body.user ?? ''), duty)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:duty-changed', { groupId: group.id, user: body.user, duty, by: actor })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/remove`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.id)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      if (target.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以移除组员。')
      const next = removeMember(target, String(body.user ?? ''))
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:member-left', { groupId: group.id, user: body.user, by: actor })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/transfer`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.id)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      if (target.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以转让组长。')
      const next = transferLeader(target, String(body.user ?? ''))
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:duty-changed', { groupId: group.id, kind: 'transfer-leader', leader: group.leader })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/activate`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.id)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      if (target.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以激活组。')
      const next = activateGroup(target)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:group-activated', { groupId: group.id, members: group.members.length })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/group/ready`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const g = findGroup(url.searchParams.get('id'))
    json(res, 200, { ok: true, data: { canActivate: canActivate(g), members: g.members.length, capacity: g.capacity } })
  })

  // 组长发布任务到组：调 tasks 建任务 → 挂组 → 记录 taskIds
  route(`${base}/task/publish`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = findGroup(body.groupId)
    if (group.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以发布组任务。')
    if (group.status !== 'active') throw new HttpError(409, 'E-1301', '组未激活，不能发布任务（需满编 4 人并激活）。')

    const task = (await callTasks(
      'create',
      { title: body.title, description: body.description ?? '', tags: body.tags ?? [], bounty: body.bounty ?? 0, ...(body.deadline ? { deadline: body.deadline } : {}) },
      actor,
    )) as { id: string }
    // 用挂组后的返回体，避免把“挂组前”的旧快照回给前端
    const attached = (await callTasks('attach-group', { id: task.id, groupId: group.id }, actor)) as { id: string; groupId: string | null }
    const next = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === group.id) as Group
      const updated = attachTask(target, task.id)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === updated.id ? updated : g)) }, result: updated }
    })
    emitEvent('dsh-training:collab:task-assigned', { groupId: group.id, taskId: task.id, by: actor })
    json(res, 200, { ok: true, data: { task: attached, group: next } })
  })

  // 组长改派组内任务
  route(`${base}/task/reassign`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = findGroup(body.groupId)
    if (group.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以改派组内任务。')
    const task = await callTasks('reassign', { id: body.id, assignee: body.assignee }, actor)
    emitEvent('dsh-training:collab:task-reassigned', { groupId: group.id, taskId: body.id, assignee: body.assignee, by: actor })
    json(res, 200, { ok: true, data: task })
  })

  // 组内评审
  route(`${base}/review/request`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.groupId)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      const next = requestReview(target, String(body.draftId ?? ''), actor)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:review-requested', { groupId: group.id, draftId: body.draftId, by: actor })
    json(res, 200, { ok: true, data: group })
  })

  route(`${base}/review/done`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = updateGroups((doc) => {
      const target = doc.groups.find((g) => g.id === body.groupId)
      if (!target) throw new HttpError(404, 'E-1304', '分组不存在。')
      const next = doneReview(target, String(body.reviewId ?? ''), actor)
      return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === next.id ? next : g)) }, result: next }
    })
    emitEvent('dsh-training:collab:review-done', { groupId: group.id, reviewId: body.reviewId, by: actor })
    json(res, 200, { ok: true, data: group })
  })

  // 金币申请（组长；只创建 pending 单据，不碰钱包）
  route(`${base}/coin-request`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1303', message: '只接受 POST。' })
    if (!requireLv1(res)) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const group = findGroup(body.groupId)
    if (group.leader !== actor) throw new HttpError(403, 'E-1302', '只有组长可以申请金币。')
    const row = requestCoins(group.id, actor, Number(body.amount), String(body.reason ?? ''))
    emitEvent('dsh-training:collab:coins-requested', { groupId: group.id, requestId: row.id, amount: row.amount, by: actor })
    json(res, 200, { ok: true, data: row })
  })

  route(`${base}/coin-requests`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    json(res, 200, { ok: true, data: listCoinRequests(url.searchParams.get('groupId') ?? undefined) })
  })

  console.log(`[dsh-training-collab] 已注册 16 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx
  writeMountEvent('mounted')
  const access = checkAccess()
  const groups = readGroups().groups
  console.log(`[dsh-training-collab] mounted — v${VERSION} · ${access.level} · groups=${groups.length}`)

  ctx.effect(() => {
    console.log('[dsh-training-collab] ready')
    return () => {
      writeMountEvent('unmounted')
      console.log('[dsh-training-collab] DISPOSED — listeners removed')
    }
  }, 'dsh-training-collab: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-collab] 注册路由失败：${(err as Error).message}`)
        }
      })
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    }
  } catch (err) {
    console.warn(`[dsh-training-collab] 等待 webServer 失败：${(err as Error).message}`)
  }
}

export const __internals = { readGroups, memberOf, listCoinRequests }
