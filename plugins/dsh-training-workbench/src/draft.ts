/**
 * draft.ts · 草稿模型 / 校验 / 状态（纯函数）
 * ---------------------------------------------------------------------------
 * 来源两条：
 *   1. 消费 dsh-training:tasks:task-accepted → 自动建草稿（sourceTaskId 幂等）
 *   2. 手动新建
 *
 * 状态：draft → published（两态；发布后不可再改）
 * 错误码：E-901 状态不允许改、E-902 非本人草稿、E-903 字段校验
 * ---------------------------------------------------------------------------
 */

export type DraftStatus = 'draft' | 'published'

export interface Draft {
  id: string
  title: string
  body: string
  tags: string[]
  owner: string
  sourceTaskId: string | null
  sourceEventId: string | null
  status: DraftStatus
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export const LIMITS = { title: 120, body: 20000, tags: 8, tagLength: 16 } as const

export interface DraftInput {
  title?: unknown
  body?: unknown
  tags?: unknown
}

export type Validated =
  | { ok: true; value: { title: string; body: string; tags: string[] } }
  | { ok: false; errors: string[] }

/** 校验（允许 body 为空：自动建草稿时还没有内容） */
export function validateInput(input: DraftInput): Validated {
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
  return `d-${y}${m}${d}-${String(seq).padStart(4, '0')}`
}

export interface CreateOptions {
  owner: string
  sourceTaskId?: string | null
  sourceEventId?: string | null
  now?: Date
}

export function createDraft(value: { title: string; body: string; tags: string[] }, id: string, opts: CreateOptions): Draft {
  const at = (opts.now ?? new Date()).toISOString()
  return {
    id,
    title: value.title,
    body: value.body,
    tags: value.tags,
    owner: opts.owner,
    sourceTaskId: opts.sourceTaskId ?? null,
    sourceEventId: opts.sourceEventId ?? null,
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    publishedAt: null,
  }
}

export type Check = { ok: true } | { ok: false; code: 'E-901' | 'E-902' | 'E-903'; reason: string }

export function canEdit(draft: Draft, actor: string): Check {
  if (!actor) return { ok: false, code: 'E-902', reason: '缺少操作者身份。' }
  if (draft.owner !== actor) return { ok: false, code: 'E-902', reason: '只能修改自己的草稿。' }
  if (draft.status !== 'draft') return { ok: false, code: 'E-901', reason: '已发布的草稿不能再修改。' }
  return { ok: true }
}

export function applySave(draft: Draft, value: { title: string; body: string; tags: string[] }, now: Date = new Date()): Draft {
  return { ...draft, title: value.title, body: value.body, tags: value.tags, updatedAt: now.toISOString() }
}

export function publishDraft(draft: Draft, now: Date = new Date()): Draft {
  const at = now.toISOString()
  return { ...draft, status: 'published', updatedAt: at, publishedAt: at }
}

/** 从任务验收事件构造草稿（标题沿用任务标题） */
export function draftFromTaskEvent(
  envelope: { id?: string; payload?: Record<string, unknown>; subject?: Record<string, unknown> },
  id: string,
  now: Date = new Date(),
): { value: { title: string; body: string; tags: string[] }; owner: string; sourceTaskId: string | null; sourceEventId: string | null } {
  const payload = envelope.payload ?? {}
  const subject = envelope.subject ?? {}
  const taskId =
    (typeof payload.taskId === 'string' && payload.taskId) ||
    (typeof subject.taskId === 'string' && subject.taskId) ||
    null
  const owner = (typeof payload.to === 'string' && payload.to) || (typeof payload.assignee === 'string' && payload.assignee) || 'unknown'
  const title = (typeof payload.title === 'string' && payload.title) || (taskId ? `任务 ${taskId} 的交付` : '未命名草稿')
  void id
  return {
    value: { title: title.slice(0, LIMITS.title), body: '', tags: taskId ? [taskId] : [] },
    owner,
    sourceTaskId: taskId,
    sourceEventId: typeof envelope.id === 'string' ? envelope.id : null,
  }
}
