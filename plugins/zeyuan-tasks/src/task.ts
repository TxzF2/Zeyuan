/**
 * task.ts · 任务模型 / 校验 / 状态机（纯函数，无 IO）
 * ---------------------------------------------------------------------------
 * 状态机：
 *   open ──claim──► claimed ──submit──► submitted ──accept──► accepted（终态）
 *     ▲                                     │
 *     └────────────── reject ───────────────┘   （清空领取人，可再领取）
 *
 * 错误码：
 *   E-801 非法状态迁移    E-802 权限不足（非发起人/非领取人/领自己任务）
 *   E-803 字段校验失败    E-804 任务不存在
 * ---------------------------------------------------------------------------
 */

export type TaskStatus = 'open' | 'claimed' | 'submitted' | 'accepted'
export type TaskAction = 'claim' | 'submit' | 'accept' | 'reject'

export const ACTIONS: TaskAction[] = ['claim', 'submit', 'accept', 'reject']

export interface TaskHistoryEntry {
  at: string
  action: TaskAction
  from: TaskStatus
  to: TaskStatus
  by: string
  reason?: string
}

export interface Task {
  id: string
  title: string
  description: string
  tags: string[]
  bounty: number
  deadline: string | null
  creator: string
  assignee: string | null
  /** 组内任务：仅本组成员可见（null=公开任务） */
  groupId: string | null
  status: TaskStatus
  createdAt: string
  updatedAt: string
  history: TaskHistoryEntry[]
}

export const LIMITS = {
  title: 80,
  description: 2000,
  tags: 5,
  tagLength: 16,
  bounty: 100000,
} as const

export interface CreateInput {
  title?: unknown
  description?: unknown
  tags?: unknown
  bounty?: unknown
  deadline?: unknown
}

export type ValidatedCreate =
  | {
      ok: true
      value: { title: string; description: string; tags: string[]; bounty: number; deadline: string | null }
    }
  | { ok: false; errors: string[] }

/** 创建任务字段校验（返回全部错误，便于一次提示） */
export function validateCreate(input: CreateInput, now: Date = new Date()): ValidatedCreate {
  const errors: string[] = []

  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) errors.push('title 不能为空')
  else if (title.length > LIMITS.title) errors.push(`title 不能超过 ${LIMITS.title} 字`)

  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description.length > LIMITS.description) errors.push(`description 不能超过 ${LIMITS.description} 字`)

  const tagsRaw = Array.isArray(input.tags) ? input.tags : []
  if (input.tags !== undefined && !Array.isArray(input.tags)) errors.push('tags 必须是数组')
  const tags: string[] = []
  for (const t of tagsRaw) {
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

  let bounty = 0
  if (input.bounty !== undefined) {
    if (typeof input.bounty !== 'number' || !Number.isInteger(input.bounty)) errors.push('bounty 必须是整数')
    else if (input.bounty < 0 || input.bounty > LIMITS.bounty) errors.push(`bounty 必须在 0~${LIMITS.bounty}`)
    else bounty = input.bounty
  }

  let deadline: string | null = null
  if (input.deadline !== undefined && input.deadline !== null && input.deadline !== '') {
    if (typeof input.deadline !== 'string' || Number.isNaN(Date.parse(input.deadline))) {
      errors.push('deadline 必须是 ISO 时间字符串')
    } else if (Date.parse(input.deadline) <= now.getTime()) {
      errors.push('deadline 必须晚于当前时间')
    } else {
      deadline = new Date(input.deadline).toISOString()
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { title, description, tags, bounty, deadline } }
}

/** 动作的前置/目标状态 */
export const TRANSITIONS: Record<TaskAction, { from: TaskStatus; to: TaskStatus }> = {
  claim: { from: 'open', to: 'claimed' },
  submit: { from: 'claimed', to: 'submitted' },
  accept: { from: 'submitted', to: 'accepted' },
  reject: { from: 'submitted', to: 'open' },
}

export type Check =
  | { ok: true }
  | { ok: false; code: 'E-801' | 'E-802' | 'E-803' | 'E-804'; reason: string }

/** 状态 + 权限判定（不改数据） */
export function checkAction(task: Task, action: TaskAction, actor: string): Check {
  const rule = TRANSITIONS[action]
  if (!rule) return { ok: false, code: 'E-801', reason: `未知动作 ${String(action)}` }

  if (task.status !== rule.from) {
    return {
      ok: false,
      code: 'E-801',
      reason: `当前状态 ${task.status} 不允许 ${action}（需要 ${rule.from}）。`,
    }
  }
  if (!actor) return { ok: false, code: 'E-802', reason: '缺少操作者身份。' }

  if (action === 'claim' && task.creator === actor) {
    return { ok: false, code: 'E-802', reason: '不能领取自己发布的任务。' }
  }
  if (action === 'submit' && task.assignee !== actor) {
    return { ok: false, code: 'E-802', reason: '只有领取人可以提交任务。' }
  }
  if ((action === 'accept' || action === 'reject') && task.creator !== actor) {
    return { ok: false, code: 'E-802', reason: '只有发起人可以验收或驳回。' }
  }
  return { ok: true }
}

/** 执行迁移，返回新对象（不修改入参） */
export function applyAction(
  task: Task,
  action: TaskAction,
  actor: string,
  now: Date = new Date(),
  reason?: string,
): Task {
  const rule = TRANSITIONS[action]
  const at = now.toISOString()
  const next: Task = {
    ...task,
    status: rule.to,
    updatedAt: at,
    history: [
      ...task.history,
      {
        at,
        action,
        from: task.status,
        to: rule.to,
        by: actor,
        ...(reason ? { reason } : {}),
      },
    ],
  }
  if (action === 'claim') next.assignee = actor
  if (action === 'reject') next.assignee = null
  return next
}

/** 任务 id：t-YYYYMMDD-序号（序号由 store 维护） */
export function makeId(now: Date, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `t-${y}${m}${d}-${String(seq).padStart(4, '0')}`
}

export function createTask(
  value: { title: string; description: string; tags: string[]; bounty: number; deadline: string | null },
  creator: string,
  id: string,
  now: Date = new Date(),
): Task {
  const at = now.toISOString()
  return {
    id,
    title: value.title,
    description: value.description,
    tags: value.tags,
    bounty: value.bounty,
    deadline: value.deadline,
    creator,
    assignee: null,
    groupId: null,
    status: 'open',
    createdAt: at,
    updatedAt: at,
    history: [],
  }
}

/** 列表过滤 */
export interface ListFilter {
  status?: TaskStatus | 'all'
  tag?: string
  mine?: boolean
  actor?: string
}

export function filterTasks(tasks: Task[], filter: ListFilter): Task[] {
  return tasks.filter((t) => {
    if (filter.status && filter.status !== 'all' && t.status !== filter.status) return false
    if (filter.tag && !t.tags.includes(filter.tag)) return false
    if (filter.mine) {
      const a = filter.actor ?? ''
      if (t.creator !== a && t.assignee !== a) return false
    }
    return true
  })
}
