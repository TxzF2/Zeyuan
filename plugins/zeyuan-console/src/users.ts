/**
 * users.ts · 用户目录（身份与在线状态）
 * ---------------------------------------------------------------------------
 * 文件：data/users.json
 * 未知身份自动登记；禁用身份拒绝（E-1108）。
 * 业务等级（LV0/LV1）由 license 决定，本文件只存目录信息。
 * ---------------------------------------------------------------------------
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'
import { fileOf, readJson, withLock, writeJsonAtomic } from './store.js'

export interface UserRow {
  id: string
  displayName: string
  disabled: boolean
  createdAt: string
  lastSeenAt: string
}

export interface UsersDoc {
  schemaVersion: number
  users: UserRow[]
}

export const USERS_FILE = 'users.json'
export const MAX_ID = 64

export class UsersError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'UsersError'
  }
}

export function usersPath(): string {
  return fileOf(USERS_FILE)
}

export function readUsers(): UsersDoc {
  const doc = readJson<UsersDoc>(usersPath(), { schemaVersion: 1, users: [] })
  return { schemaVersion: 1, users: Array.isArray(doc.users) ? doc.users.filter((u) => u && typeof u.id === 'string') : [] }
}

export function writeUsers(doc: { users: UserRow[] }): void {
  writeJsonAtomic(usersPath(), { schemaVersion: 1, users: doc.users })
}

export function validateId(id: string): string[] {
  const errors: string[] = []
  if (!id) errors.push('身份不能为空')
  else if (id.length > MAX_ID) errors.push(`身份不能超过 ${MAX_ID} 字符`)
  else if (!/^[\w.:@-]+$/.test(id)) errors.push('身份只能包含字母、数字、下划线、点、冒号、@、连字符')
  return errors
}

/** 解析或自动登记 */
export function resolveUser(actor: string, now: Date = new Date()): { user: UserRow; created: boolean } {
  const errors = validateId(actor)
  if (errors.length) throw new UsersError('E-1203', errors.join('；'))
  return withLock('users', () => {
    const doc = readUsers()
    const at = now.toISOString()
    const found = doc.users.find((u) => u.id === actor)
    if (found) {
      if (found.disabled) throw new UsersError('E-1108', `身份 ${actor} 已被禁用。`)
      const updated: UserRow = { ...found, lastSeenAt: at }
      writeUsers({ users: doc.users.map((u) => (u.id === actor ? updated : u)) })
      return { user: updated, created: false }
    }
    const user: UserRow = { id: actor, displayName: actor, disabled: false, createdAt: at, lastSeenAt: at }
    writeUsers({ users: [...doc.users, user] })
    return { user, created: true }
  })
}

export function createUser(id: string, displayName: string, now: Date = new Date()): UserRow {
  const errors = validateId(id)
  if (errors.length) throw new UsersError('E-1203', errors.join('；'))
  return withLock('users', () => {
    const doc = readUsers()
    if (doc.users.some((u) => u.id === id)) throw new UsersError('E-1201', `用户已存在：${id}`)
    const at = now.toISOString()
    const user: UserRow = { id, displayName: displayName.trim() || id, disabled: false, createdAt: at, lastSeenAt: at }
    writeUsers({ users: [...doc.users, user] })
    return user
  })
}

export function setUserDisabled(id: string, disabled: boolean, now: Date = new Date()): UserRow {
  return withLock('users', () => {
    const doc = readUsers()
    const user = doc.users.find((u) => u.id === id)
    if (!user) throw new UsersError('E-1204', `用户不存在：${id}`)
    const next: UserRow = { ...user, disabled, lastSeenAt: now.toISOString() }
    writeUsers({ users: doc.users.map((u) => (u.id === id ? next : u)) })
    return next
  })
}

export function listUsers(onlineWindowMs = 15 * 60 * 1000, now: Date = new Date()): {
  users: UserRow[]
  total: number
  online: number
  disabled: number
} {
  const doc = readUsers()
  const online = doc.users.filter((u) => !u.disabled && now.getTime() - Date.parse(u.lastSeenAt) <= onlineWindowMs).length
  return { users: doc.users, total: doc.users.length, online, disabled: doc.users.filter((u) => u.disabled).length }
}

/** 迁移：把旧 config/users.json（含 roles）搬到 data/users.json，并返回原 admin 名单 */
export function migrateLegacyUsers(): { migrated: number; admins: string[] } {
  const legacy = join(stateDir(), 'config', 'users.json')
  if (!existsSync(legacy)) return { migrated: 0, admins: [] }
  const raw = readJson<{
    users?: { id: string; displayName?: string; roles?: string[]; disabled?: boolean; createdAt?: string; lastSeenAt?: string }[]
  }>(legacy, {})
  const rows = raw.users ?? []
  if (!rows.length) return { migrated: 0, admins: [] }
  const doc = readUsers()
  const admins: string[] = []
  let migrated = 0
  for (const r of rows) {
    if (!r?.id) continue
    if (!doc.users.some((u) => u.id === r.id)) {
      doc.users.push({
        id: r.id,
        displayName: r.displayName ?? r.id,
        disabled: Boolean(r.disabled),
        createdAt: r.createdAt ?? new Date().toISOString(),
        lastSeenAt: r.lastSeenAt ?? new Date().toISOString(),
      })
      migrated++
    }
    if (Array.isArray(r.roles) && r.roles.includes('admin')) admins.push(r.id)
  }
  if (migrated) writeUsers({ users: doc.users })
  return { migrated, admins }
}
