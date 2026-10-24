/**
 * model.ts · 协作分组模型（固定编制 1 组长 + 3 组员）
 * ---------------------------------------------------------------------------
 * 规则（用户硬需求）：
 *   capacity = 4（1 组长 + 3 组员）
 *   满编（4 人）且全员分工齐备 → 才能 activate
 *   forming 状态才能 join；activate 后才能发布/改派组任务
 *   组长必须先转让才能退出；无人可接则只能解散（archived）
 *
 * 分工标签：build / training / ops / 自定义（≤16 字）
 * 错误码：E-1301 状态不允许、E-1302 权限不足、E-1303 字段非法、E-1304 不存在
 * ---------------------------------------------------------------------------
 */

export type GroupStatus = 'forming' | 'active' | 'archived'

export interface GroupMember {
  userId: string
  duty: string
  joinedAt: string
}

export interface ReviewRequest {
  id: string
  draftId: string
  by: string
  status: 'pending' | 'done'
  at: string
  doneAt?: string
  doneBy?: string
}

export interface Group {
  id: string
  name: string
  topic: string
  leader: string
  capacity: number
  members: GroupMember[]
  status: GroupStatus
  activeSince: string | null
  taskIds: string[]
  reviewRequests: ReviewRequest[]
  createdAt: string
  updatedAt: string
}

export const CAPACITY = 4
export const PRESET_DUTIES = ['build', 'training', 'ops'] as const
export const LIMITS = { name: 32, topic: 80, duty: 16, members: CAPACITY }

export class CollabError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CollabError'
  }
}

export function makeId(now: Date, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `g-${y}${m}${d}-${String(seq).padStart(4, '0')}`
}

export function validateCreate(input: { name?: unknown; topic?: unknown }): { ok: true; value: { name: string; topic: string } } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
  if (!name) errors.push('组名不能为空')
  else if (name.length > LIMITS.name) errors.push(`组名不能超过 ${LIMITS.name} 字`)
  if (topic.length > LIMITS.topic) errors.push(`主题不能超过 ${LIMITS.topic} 字`)
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, topic } }
}

export function validateDuty(duty: unknown): string {
  const d = typeof duty === 'string' ? duty.trim() : ''
  if (!d) throw new CollabError('E-1303', '分工不能为空')
  if (d.length > LIMITS.duty) throw new CollabError('E-1303', `分工不能超过 ${LIMITS.duty} 字`)
  return d
}

export function createGroup(
  value: { name: string; topic: string },
  leader: string,
  id: string,
  now: Date = new Date(),
): Group {
  const at = now.toISOString()
  return {
    id,
    name: value.name,
    topic: value.topic,
    leader,
    capacity: CAPACITY,
    members: [{ userId: leader, duty: 'build', joinedAt: at }],
    status: 'forming',
    activeSince: null,
    taskIds: [],
    reviewRequests: [],
    createdAt: at,
    updatedAt: at,
  }
}

export function memberOf(group: Group, userId: string): GroupMember | undefined {
  return group.members.find((m) => m.userId === userId)
}

export function isMember(group: Group, userId: string): boolean {
  return Boolean(memberOf(group, userId))
}

export function isFull(group: Group): boolean {
  return group.members.length >= group.capacity
}

/** 满编 + 全员有分工 */
export function canActivate(group: Group): { ok: boolean; reason?: string } {
  if (group.status === 'active') return { ok: false, reason: '组已激活' }
  if (group.status === 'archived') return { ok: false, reason: '组已解散' }
  if (!isFull(group)) return { ok: false, reason: `编制未满（${group.members.length}/${group.capacity}）` }
  if (group.members.some((m) => !m.duty)) return { ok: false, reason: '有成员未填写分工' }
  return { ok: true }
}

export function joinGroup(group: Group, userId: string, duty: string, now: Date = new Date()): Group {
  if (group.status !== 'forming') throw new CollabError('E-1301', `当前组状态 ${group.status} 不允许加入。`)
  if (isMember(group, userId)) throw new CollabError('E-1301', '你已在本组中。')
  if (isFull(group)) throw new CollabError('E-1301', `编制已满（${group.capacity} 人）。`)
  const at = now.toISOString()
  return { ...group, members: [...group.members, { userId, duty, joinedAt: at }], updatedAt: at }
}

export function leaveGroup(group: Group, userId: string, now: Date = new Date()): Group {
  if (!isMember(group, userId)) throw new CollabError('E-1302', '你不在本组中。')
  if (group.leader === userId) throw new CollabError('E-1301', '组长需先转让再退出。')
  const at = now.toISOString()
  const members = group.members.filter((m) => m.userId !== userId)
  const next: Group = { ...group, members, updatedAt: at }
  // 不足编制（<4）就回落 forming，避免「激活但人手不齐」
  if (next.members.length < next.capacity && next.status === 'active') next.status = 'forming'
  return next
}

export function setDuty(group: Group, userId: string, duty: string, now: Date = new Date()): Group {
  if (!isMember(group, userId)) throw new CollabError('E-1304', '成员不存在。')
  const at = now.toISOString()
  return {
    ...group,
    members: group.members.map((m) => (m.userId === userId ? { ...m, duty } : m)),
    updatedAt: at,
  }
}

export function removeMember(group: Group, userId: string, now: Date = new Date()): Group {
  if (group.leader === userId) throw new CollabError('E-1301', '不能移除组长（请先转让）。')
  if (!isMember(group, userId)) throw new CollabError('E-1304', '成员不存在。')
  const at = now.toISOString()
  const members = group.members.filter((m) => m.userId !== userId)
  return {
    ...group,
    members,
    status: group.status === 'active' && members.length < group.capacity ? 'forming' : group.status,
    updatedAt: at,
  }
}

export function transferLeader(group: Group, target: string, now: Date = new Date()): Group {
  if (!isMember(group, target)) throw new CollabError('E-1304', '只能转让给本组成员。')
  const at = now.toISOString()
  return { ...group, leader: target, updatedAt: at }
}

export function activateGroup(group: Group, now: Date = new Date()): Group {
  const check = canActivate(group)
  if (!check.ok) throw new CollabError('E-1301', check.reason ?? '无法激活')
  const at = now.toISOString()
  return { ...group, status: 'active', activeSince: at, updatedAt: at }
}

export function archiveGroup(group: Group, now: Date = new Date()): Group {
  const at = now.toISOString()
  return { ...group, status: 'archived', updatedAt: at }
}

export function attachTask(group: Group, taskId: string, now: Date = new Date()): Group {
  if (group.status !== 'active') throw new CollabError('E-1301', '组未激活，不能发布/挂载组任务。')
  if (group.taskIds.includes(taskId)) return group
  return { ...group, taskIds: [...group.taskIds, taskId], updatedAt: now.toISOString() }
}

export function requestReview(group: Group, draftId: string, by: string, now: Date = new Date()): Group {
  if (!isMember(group, by)) throw new CollabError('E-1302', '只有本组成员可以发起评审。')
  const at = now.toISOString()
  const rr: ReviewRequest = { id: `rv-${now.getTime()}`, draftId, by, status: 'pending', at }
  return { ...group, reviewRequests: [...group.reviewRequests, rr], updatedAt: at }
}

export function doneReview(group: Group, reviewId: string, by: string, now: Date = new Date()): Group {
  if (!isMember(group, by)) throw new CollabError('E-1302', '只有本组成员可以完成评审。')
  const at = now.toISOString()
  const exists = group.reviewRequests.some((r) => r.id === reviewId)
  if (!exists) throw new CollabError('E-1304', '评审请求不存在。')
  return {
    ...group,
    reviewRequests: group.reviewRequests.map((r) => (r.id === reviewId ? { ...r, status: 'done', doneAt: at, doneBy: by } : r)),
    updatedAt: at,
  }
}
