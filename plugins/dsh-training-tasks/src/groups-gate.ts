/**
 * groups-gate.ts · 组内可见性与组长判定（tasks 侧只读 + 挂组写回）
 * ---------------------------------------------------------------------------
 * 契约：collab 插件拥有 data/groups.json；tasks 侧只读判断可见性，
 *       仅"挂组"时在锁内写回 groups[].taskIds（跨插件文件契约，见 docs）。
 *
 * 规则（用户拍板：组任务仅组内可见）：
 *   无 groupId 的任务：所有人可见（与原来一致）
 *   有 groupId 的任务：仅本组成员可见；P7+ 可见（兜底排障）；任务发起人始终可见
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'

export interface GroupMemberRow {
  userId: string
  duty?: string
}

export interface GroupRow {
  id: string
  leader: string
  capacity?: number
  members: GroupMemberRow[]
  taskIds?: string[]
  status?: string
}

export interface GroupsDoc {
  schemaVersion: number
  seq: number
  groups: GroupRow[]
}

export const GROUPS_FILE = 'groups.json'

export function groupsPath(): string {
  return join(stateDir(), 'data', GROUPS_FILE)
}

export function readGroups(): GroupsDoc {
  try {
    const file = groupsPath()
    if (!existsSync(file)) return { schemaVersion: 1, seq: 0, groups: [] }
    const doc = JSON.parse(readFileSync(file, 'utf8')) as GroupsDoc
    return { schemaVersion: 1, seq: Number.isInteger(doc.seq) ? doc.seq : 0, groups: Array.isArray(doc.groups) ? doc.groups : [] }
  } catch {
    return { schemaVersion: 1, seq: 0, groups: [] }
  }
}

export function findGroup(groupId: string | null | undefined): GroupRow | null {
  if (!groupId) return null
  return readGroups().groups.find((g) => g.id === groupId) ?? null
}

export function isMember(groupId: string | null | undefined, userId: string): boolean {
  const g = findGroup(groupId)
  if (!g) return false
  return g.leader === userId || (g.members ?? []).some((m) => m.userId === userId)
}

export function isLeader(groupId: string | null | undefined, userId: string): boolean {
  const g = findGroup(groupId)
  return Boolean(g && g.leader === userId)
}

/** 从控制台用户档位表读 P 档（跨插件只读；缺失=0） */
export function tierOf(userId: string): number {
  try {
    const file = join(stateDir(), 'data', 'admins.json')
    if (!existsSync(file)) return 0
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { admins?: { userId: string; tier: number }[] }
    return doc.admins?.find((a) => a.userId === userId)?.tier ?? 0
  } catch {
    return 0
  }
}

/** 组任务可见性：组员 / 发起人 / P7+ */
export function canSeeTask(task: { groupId?: string | null; creator?: string }, actor: string): boolean {
  if (!task.groupId) return true
  if (task.creator && task.creator === actor) return true
  if (isMember(task.groupId, actor)) return true
  return tierOf(actor) >= 7
}
