/**
 * post.ts · 帖子模型 / 三态迁移 / 可见性 / 点赞（纯函数）
 * ---------------------------------------------------------------------------
 * 三态：draft（仅作者） → published（所有人） → hidden（作者 + 管理员）
 *
 * 设计取舍（产品口径）：
 *   工作台草稿发布后**不直接公开**，而是生成一份"帖子草稿"，作者在社区面板
 *   点「发布」才公开 —— 给作者一次自检机会，这是培训班社区与灌水论坛的分界。
 *
 * 错误码：E-1001 非法状态、E-1002 无权限、E-1003 字段非法
 * ---------------------------------------------------------------------------
 */

export type PostStatus = 'draft' | 'published' | 'hidden'

export interface Post {
  id: string
  title: string
  body: string
  tags: string[]
  author: string
  sourceDraftId: string | null
  sourceEventId: string | null
  status: PostStatus
  likes: number
  likedBy: string[]
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  hiddenAt: string | null
  hiddenBy: string | null
}

export const LIMITS = { title: 120, body: 20000, tags: 8, tagLength: 16 } as const

export interface PostInput {
  title?: unknown
  body?: unknown
  tags?: unknown
}

export type Validated =
  | { ok: true; value: { title: string; body: string; tags: string[] } }
  | { ok: false; errors: string[] }

export function validateInput(input: PostInput): Validated {
  const errors: string[] = []

  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) errors.push('title 不能为空')
  else if (title.length > LIMITS.title) errors.push(`title 不能超过 ${LIMITS.title} 字`)

  const body = typeof input.body === 'string' ? input.body : ''
  if (body.length > LIMITS.body) errors.push(`正文不能超过 ${LIMITS.body} 字`)

  const raw = Array.isArray(input.tags) ? input.tags : []
  if (input.tags !== undefined && !Array.isArray(input.tags)) errors.push('tags 必须是数组')
  const tags: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string') {
      errors.push('tags 里每一项必须是字符串')
      continue
    }
    const tag = t.trim()
    if (!tag) continue
    if (tag.length > LIMITS.tagLength) errors.push(`标签「${tag}」超过 ${LIMITS.tagLength} 字`)
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > LIMITS.tags) errors.push(`标签最多 ${LIMITS.tags} 个`)

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { title, body, tags } }
}

export function makeId(now: Date, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `p-${y}${m}${d}-${String(seq).padStart(4, '0')}`
}

export interface CreateOptions {
  author: string
  sourceDraftId?: string | null
  sourceEventId?: string | null
  status?: PostStatus
  now?: Date
}

export function createPost(value: { title: string; body: string; tags: string[] }, id: string, opts: CreateOptions): Post {
  const at = (opts.now ?? new Date()).toISOString()
  const status = opts.status ?? 'draft'
  return {
    id,
    title: value.title,
    body: value.body,
    tags: value.tags,
    author: opts.author,
    sourceDraftId: opts.sourceDraftId ?? null,
    sourceEventId: opts.sourceEventId ?? null,
    status,
    likes: 0,
    likedBy: [],
    createdAt: at,
    updatedAt: at,
    publishedAt: status === 'published' ? at : null,
    hiddenAt: null,
    hiddenBy: null,
  }
}

/** 可见性：唯一判定入口（列表/详情/点赞/删除都走它） */
export function canSee(post: Post, actor: string, isAdmin: boolean): boolean {
  if (post.status === 'published') return true
  if (post.author === actor) return true
  return isAdmin
}

export type Check = { ok: true } | { ok: false; code: 'E-1001' | 'E-1002'; reason: string }

export function canEdit(post: Post, actor: string): Check {
  if (post.author !== actor) return { ok: false, code: 'E-1002', reason: '只能修改自己的帖子。' }
  if (post.status !== 'draft') return { ok: false, code: 'E-1001', reason: '只有草稿状态可以修改。' }
  return { ok: true }
}

export function canPublish(post: Post, actor: string): Check {
  const edit = canEdit(post, actor)
  if (!edit.ok) return edit
  return { ok: true }
}

export function canDelete(post: Post, actor: string): Check {
  if (post.author !== actor) return { ok: false, code: 'E-1002', reason: '只能删除自己的帖子。' }
  return { ok: true }
}

export function canHide(isAdmin: boolean): Check {
  return isAdmin ? { ok: true } : { ok: false, code: 'E-1002', reason: '需要管理员权限（training:admin）。' }
}

export function applySave(post: Post, value: { title: string; body: string; tags: string[] }, now: Date = new Date()): Post {
  return { ...post, title: value.title, body: value.body, tags: value.tags, updatedAt: now.toISOString() }
}

export function publishPost(post: Post, now: Date = new Date()): Post {
  const at = now.toISOString()
  return { ...post, status: 'published', updatedAt: at, publishedAt: at }
}

export function hidePost(post: Post, by: string, now: Date = new Date()): Post {
  const at = now.toISOString()
  return { ...post, status: 'hidden', updatedAt: at, hiddenAt: at, hiddenBy: by }
}

export function unhidePost(post: Post, now: Date = new Date()): Post {
  const at = now.toISOString()
  return { ...post, status: 'published', updatedAt: at, hiddenAt: null, hiddenBy: null }
}

/** 点赞 toggle：返回新帖子与是否已赞 */
export function toggleLike(post: Post, actor: string, now: Date = new Date()): { post: Post; liked: boolean } {
  const liked = post.likedBy.includes(actor)
  const likedBy = liked ? post.likedBy.filter((x) => x !== actor) : [...post.likedBy, actor]
  return {
    post: { ...post, likedBy, likes: likedBy.length, updatedAt: now.toISOString() },
    liked: !liked,
  }
}

/** 从工作台草稿发布事件构造帖子草稿（作者确认后才公开，故初始为 draft） */
export function postFromDraftEvent(envelope: { id?: string; payload?: Record<string, unknown>; subject?: Record<string, unknown> }): {
  value: { title: string; body: string; tags: string[] }
  author: string
  sourceDraftId: string | null
  sourceEventId: string | null
} {
  const payload = envelope.payload ?? {}
  const subject = envelope.subject ?? {}
  const draftId =
    (typeof payload.draftId === 'string' && payload.draftId) ||
    (typeof subject.draftId === 'string' && subject.draftId) ||
    null
  const author = typeof payload.owner === 'string' && payload.owner ? payload.owner : 'unknown'
  const title = (typeof payload.title === 'string' && payload.title) || (draftId ? `草稿 ${draftId} 的帖子` : '未命名帖子')
  return {
    value: { title: title.slice(0, LIMITS.title), body: '', tags: draftId ? [draftId] : [] },
    author,
    sourceDraftId: draftId,
    sourceEventId: typeof envelope.id === 'string' ? envelope.id : null,
  }
}
