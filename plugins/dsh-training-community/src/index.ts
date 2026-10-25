/**
 * dsh-training-community · HOST 半
 * ---------------------------------------------------------------------------
 * 1. 消费 workbench:draft-published（总线 + 补扫 + 双去重）→ 生成「帖子草稿」
 * 2. 帖子 REST：me / list / detail / draft / save / publish / like / delete / hide / unhide
 * 3. 可见性：draft 仅作者；hidden 作者+管理员；published 所有人（统一走 canSee）
 * 4. 权限：浏览无限制；写操作（draft/save/publish/delete）需 LV1；like 不限；hide/unhide 需 admin scope
 *
 * 挂载证据：mount-events.jsonl（plugin=dsh-training-community）
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { checkAccess, stateDir } from './license-gate.js'
import { isAdminByRole } from './users-gate.js'
import { isBoardEnabled } from './board-switch.js'
import {
  applySave,
  canDelete,
  canEdit,
  canSee,
  createPost,
  hidePost,
  makeId,
  publishPost,
  toggleLike,
  unhidePost,
  validateInput,
  type Post,
  type PostStatus,
} from './post.js'
import { DRAFT_PUBLISHED, consumeDraftPublished, replayLog, type Envelope } from './consume.js'
import { StoreError, readDoc, updateDoc } from './store.js'
import { CommentError, addComment, canSeeComment, deleteComment, hideComment, isModerator, listComments } from './comments.js'

export const name = 'dsh-training-community'
export const VERSION = '0.1.0'

export const EMITTED_EVENTS = [
  'dsh-training:feature-community:post-drafted',
  'dsh-training:feature-community:post-published',
  'dsh-training:feature-community:post-liked',
  'dsh-training:feature-community:post-hidden',
  'dsh-training:feature-community:post-unhidden',
  'dsh-training:feature-community:post-deleted',
  'dsh-training:feature-community:comment-added',
  'dsh-training:feature-community:comment-removed',
  'dsh-training:feature-community:comment-hidden',
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
    source: 'feature-community',
    type,
    subject,
    payload,
  }
  try {
    ensureStateDir()
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[dsh-training-community] 写事件日志失败：${(err as Error).message}`)
  }
  try {
    ;(bus as unknown as { emit?: (t: string, p: unknown) => void } | null)?.emit?.(type, envelope)
  } catch (err) {
    console.warn(`[dsh-training-community] 总线广播失败：${(err as Error).message}`)
  }
  console.log(`[dsh-training-community] event ${type} ${JSON.stringify(payload)}`)
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
    console.warn(`[dsh-training-community] 写挂载标记失败：${(err as Error).message}`)
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
  'E-1001': 409,
  'E-1002': 403,
  'E-1003': 400,
  'E-1004': 404,
  'E-1005': 403,
  'E-1010': 500,
  'E-1011': 503,
  'E-1012': 500,
  'E-1401': 400,
  'E-1402': 403,
  'E-1403': 404,
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
      message: `${access.reason}（LV1 才能发帖/编辑，请先在设置里签署协议）`,
      level: access.level,
    })
    return null
  }
  return undefined
}

function findPost(posts: Post[], id: unknown): Post | undefined {
  return typeof id === 'string' ? posts.find((p) => p.id === id) : undefined
}

/** 可见性统一的 404 语义：不可见一律当作不存在，不泄漏 */
function visibleOr404(post: Post | undefined, actor: string, admin: boolean): Post {
  if (!post || !canSee(post, actor, admin)) throw new HttpError(404, 'E-1004', '帖子不存在。')
  return post
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
          if (err instanceof CommentError) return json(res, STATUS_BY_CODE[err.code] ?? 400, { ok: false, code: err.code, message: err.message })
          if (err instanceof HttpError) {
            json(res, err.status, { ok: false, code: err.code, message: err.message })
            return
          }
          const code = err instanceof StoreError ? err.code : 'E-1009'
          json(res, STATUS_BY_CODE[code] ?? 500, { ok: false, code, message: (err as Error).message })
        }
        // 同步抛错也要接住（async 之外的 handler 同步 throw 时 Promise.resolve 包不住）
        try {
          Promise.resolve(handler(req, res)).catch(fail)
        } catch (err) {
          fail(err)
        }
      },
    })
  }

  const base = '/dsh-training/community'

  route(`${base}/me`, (req, res) => {
    const access = checkAccess()
    json(res, 200, {
      ok: true,
      data: { user: actorOf(req), level: access.level, code: access.code, isAdmin: isAdminByRole(actorOf(req)) },
    })
  })

  route(`${base}/list`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const actor = actorOf(req)
    const admin = isAdminByRole(actor)
    const status = (url.searchParams.get('status') ?? 'all') as PostStatus | 'all'
    const tag = url.searchParams.get('tag') ?? undefined
    const author = url.searchParams.get('author') ?? undefined
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const doc = readDoc()
    const posts = doc.posts
      .filter((p) => canSee(p, actor, admin))
      .filter((p) => (status === 'all' ? true : p.status === status))
      .filter((p) => (tag ? p.tags.includes(tag) : true))
      .filter((p) => (author ? p.author === author : true))
      .filter((p) => (q ? `${p.title}\n${p.body}`.toLowerCase().includes(q) : true))
    const tags = [...new Set(doc.posts.filter((p) => canSee(p, actor, admin)).flatMap((p) => p.tags))].sort()
    json(res, 200, { ok: true, data: { posts, total: posts.length, tags, isAdmin: admin } })
  })

  route(`${base}/detail`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const actor = actorOf(req)
    const admin = isAdminByRole(actor)
    const doc = readDoc()
    const post = visibleOr404(findPost(doc.posts, url.searchParams.get('id')), actor, admin)
    json(res, 200, { ok: true, data: post })
  })

  // 手动新建帖子草稿（管理员发公告也走这条）
  route(`${base}/draft`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const validated = validateInput(body)
    if (!validated.ok) return json(res, 400, { ok: false, code: 'E-1003', message: validated.errors.join('；'), errors: validated.errors })
    const actor = actorOf(req)
    const post = updateDoc((doc) => {
      const now = new Date()
      const seq = doc.seq + 1
      const created = createPost(validated.value, makeId(now, seq), { author: actor, status: 'draft', now })
      return { doc: { ...doc, seq, posts: [...doc.posts, created] }, result: created }
    })
    emitEvent('dsh-training:feature-community:post-drafted', { postId: post.id, author: actor, via: 'manual' }, { postId: post.id })
    json(res, 200, { ok: true, data: post })
  })

  route(`${base}/save`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const post = updateDoc((doc) => {
      const current = findPost(doc.posts, body.id)
      if (!current) throw new HttpError(404, 'E-1004', '帖子不存在。')
      const check = canEdit(current, actor)
      if (!check.ok) throw new HttpError(STATUS_BY_CODE[check.code] ?? 400, check.code, check.reason)
      const validated = validateInput({ title: body.title ?? current.title, body: body.body ?? current.body, tags: body.tags ?? current.tags })
      if (!validated.ok) throw new HttpError(400, 'E-1003', validated.errors.join('；'))
      const next = applySave(current, validated.value)
      return { doc: { ...doc, posts: doc.posts.map((p) => (p.id === current.id ? next : p)) }, result: next }
    })
    json(res, 200, { ok: true, data: post })
  })

  route(`${base}/publish`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const post = updateDoc((doc) => {
      const current = findPost(doc.posts, body.id)
      if (!current) throw new HttpError(404, 'E-1004', '帖子不存在。')
      const check = canEdit(current, actor)
      if (!check.ok) throw new HttpError(STATUS_BY_CODE[check.code] ?? 400, check.code, check.reason)
      if (!current.body.trim()) throw new HttpError(400, 'E-1003', '正文为空，不能发布。')
      const next = publishPost(current)
      return { doc: { ...doc, posts: doc.posts.map((p) => (p.id === current.id ? next : p)) }, result: next }
    })
    emitEvent(
      'dsh-training:feature-community:post-published',
      { postId: post.id, author: post.author, sourceDraftId: post.sourceDraftId },
      { postId: post.id },
    )
    json(res, 200, { ok: true, data: post })
  })

  // 点赞：不限身份（未签署也能浏览/点赞），但要能看见帖子
  route(`${base}/like`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    const body = await readBody(req)
    const actor = actorOf(req)
    const admin = isAdminByRole(actor)
    let liked = false
    const post = updateDoc((doc) => {
      const current = findPost(doc.posts, body.id)
      const visible = visibleOr404(current, actor, admin)
      if (visible.status === 'draft') throw new HttpError(409, 'E-1001', '草稿状态不能点赞。')
      const r = toggleLike(visible, actor)
      liked = r.liked
      return { doc: { ...doc, posts: doc.posts.map((p) => (p.id === visible.id ? r.post : p)) }, result: r.post }
    })
    emitEvent('dsh-training:feature-community:post-liked', { postId: post.id, by: actor, likes: post.likes, liked }, { postId: post.id })
    json(res, 200, { ok: true, data: { post, liked } })
  })

  // 删除：仅作者（硬删）
  route(`${base}/delete`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const removed = updateDoc((doc) => {
      const current = findPost(doc.posts, body.id)
      if (!current) throw new HttpError(404, 'E-1004', '帖子不存在。')
      const check = canDelete(current, actor)
      if (!check.ok) throw new HttpError(STATUS_BY_CODE[check.code] ?? 400, check.code, check.reason)
      return { doc: { ...doc, posts: doc.posts.filter((p) => p.id !== current.id) }, result: current }
    })
    emitEvent('dsh-training:feature-community:post-deleted', { postId: removed.id, by: actor }, { postId: removed.id })
    json(res, 200, { ok: true, data: { id: removed.id, deleted: true } })
  })

  // 隐藏 / 恢复：仅管理员（training:admin scope）
  for (const action of ['hide', 'unhide'] as const) {
    route(`${base}/${action}`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
      if (!isAdminByRole(actorOf(req))) return json(res, 403, { ok: false, code: 'E-1005', message: '需要管理员角色（admin）。' })
      const body = await readBody(req)
      const actor = actorOf(req)
      const post = updateDoc((doc) => {
        const current = findPost(doc.posts, body.id)
        if (!current) throw new HttpError(404, 'E-1004', '帖子不存在。')
        if (action === 'hide' && current.status === 'hidden') throw new HttpError(409, 'E-1001', '帖子已是隐藏状态。')
        if (action === 'unhide' && current.status !== 'hidden') throw new HttpError(409, 'E-1001', '帖子未被隐藏。')
        const next = action === 'hide' ? hidePost(current, actor) : unhidePost(current)
        return { doc: { ...doc, posts: doc.posts.map((p) => (p.id === current.id ? next : p)) }, result: next }
      })
      emitEvent(
        action === 'hide' ? 'dsh-training:feature-community:post-hidden' : 'dsh-training:feature-community:post-unhidden',
        { postId: post.id, by: actor },
        { postId: post.id },
      )
      json(res, 200, { ok: true, data: post })
    })
  }

  // ---------------- 评论（一级） ----------------
  const requirePostVisible = (postId: string, actor: string): Post => {
    const doc = readDoc()
    const post = doc.posts.find((p) => p.id === postId)
    if (!post || !canSee(post, actor, isAdminByRole(actor))) throw new HttpError(404, 'E-1403', '帖子不存在。')
    return post
  }

  route(`${base}/comments`, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const actor = actorOf(req)
    const postId = url.searchParams.get('postId') ?? ''
    requirePostVisible(postId, actor)
    const { comments, moderator } = listComments(postId, actor)
    json(res, 200, {
      ok: true,
      data: {
        comments: comments.map((c) => ({
          ...c,
          canDelete: c.author === actor && c.status !== 'deleted',
          canHide: moderator,
        })),
        total: comments.length,
        isModerator: moderator,
      },
    })
  })

  route(`${base}/comments/add`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const postId = typeof body.postId === 'string' ? body.postId : ''
    requirePostVisible(postId, actor)
    const comment = addComment(postId, actor, body.body)
    emitEvent('dsh-training:feature-community:comment-added', { commentId: comment.id, postId, author: actor }, { commentId: comment.id })
    json(res, 200, { ok: true, data: comment })
  })

  route(`${base}/comments/delete`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const body = await readBody(req)
    const actor = actorOf(req)
    const comment = deleteComment(String(body.id ?? ''), actor)
    emitEvent('dsh-training:feature-community:comment-removed', { commentId: comment.id, postId: comment.postId, author: comment.author, by: actor }, { commentId: comment.id })
    json(res, 200, { ok: true, data: comment })
  })

  route(`${base}/comments/hide`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    const actor = actorOf(req)
    const body = await readBody(req)
    const hidden = body.hidden !== false
    const comment = hideComment(String(body.id ?? ''), actor, hidden)
    emitEvent(
      'dsh-training:feature-community:comment-hidden',
      { commentId: comment.id, postId: comment.postId, author: comment.author, hidden, by: actor },
      { commentId: comment.id },
    )
    json(res, 200, { ok: true, data: comment })
  })

  // 手动补扫
  route(`${base}/replay`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'E-1006', message: '只接受 POST。' })
    if (requireLv1(res) === null) return
    const r = replayLog()
    for (const postId of r.posts) {
      emitEvent('dsh-training:feature-community:post-drafted', { postId, via: 'replay' }, { postId })
    }
    json(res, 200, { ok: true, data: r })
  })

  console.log(`[dsh-training-community] 已注册 15 条路由（${base}/*）`)
}

// ---------------------------------------------------------------- 入口
export function apply(ctx: Context): void {
  bus = ctx

  if (!isBoardEnabled('feature-community')) {
    console.log('[dsh-training-community] 已在控制面板中停用，跳过路由与事件订阅')
    writeMountEvent('mounted')
    ctx.effect(() => () => writeMountEvent('unmounted'), 'dsh-training-community: disabled marker')
    return
  }
  writeMountEvent('mounted')

  const access = checkAccess()
  console.log(`[dsh-training-community] mounted — v${VERSION} · ${access.level} · ${access.code} · admin=${isAdminByRole('local-user')}`)

  try {
    const anyCtx = ctx as unknown as { on?: (type: string, cb: (env: Envelope) => void) => unknown }
    if (typeof anyCtx.on === 'function') {
      anyCtx.on(DRAFT_PUBLISHED, (env: Envelope) => {
        try {
          const r = consumeDraftPublished(env)
          if (r.created && r.postId) {
            emitEvent(
              'dsh-training:feature-community:post-drafted',
              { postId: r.postId, via: 'draft-published', sourceDraftId: env.payload?.draftId ?? null },
              { postId: r.postId },
            )
          }
          console.log(`[dsh-training-community] 消费 ${DRAFT_PUBLISHED} → created=${r.created} ${r.reason ?? r.postId ?? ''}`)
        } catch (err) {
          console.warn(`[dsh-training-community] 消费事件失败：${(err as Error).message}`)
        }
      })
      console.log('[dsh-training-community] 已订阅 workbench:draft-published')
    }
  } catch (err) {
    console.warn(`[dsh-training-community] 订阅失败：${(err as Error).message}`)
  }

  try {
    const r = replayLog()
    if (r.scanned > 0) console.log(`[dsh-training-community] 补扫：命中 ${r.scanned} 条，新建帖子草稿 ${r.created} 份`)
  } catch (err) {
    console.warn(`[dsh-training-community] 补扫失败：${(err as Error).message}`)
  }

  ctx.effect(() => {
    console.log('[dsh-training-community] ready')
    return () => {
      writeMountEvent('unmounted')
      console.log('[dsh-training-community] DISPOSED — listeners removed')
    }
  }, 'dsh-training-community: mount marker')

  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-community] 注册路由失败：${(err as Error).message}`)
        }
      })
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    }
  } catch (err) {
    console.warn(`[dsh-training-community] 等待 webServer 失败：${(err as Error).message}`)
  }
}

export const __internals = { actorOf, readBody, findPost, stateDir, emitEvent, EMITTED_EVENTS, readDoc }
