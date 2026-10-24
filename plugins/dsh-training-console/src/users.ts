/**
 * users.ts · 用户表与角色（控制面板地基，收口 D-007）
 * ---------------------------------------------------------------------------
 * 文件：%LOCALAPPDATA%\dsh-training\config\users.json
 * 身份来源：请求头 x-dsh-user（缺省 local-user）
 * 未知身份：**自动登记为 trainee**（并记录 createdAt），低门槛适配单机培训班
 *
 * 权限模型：
 *   admin   → 用户管理 / 板块启停 / 隐藏帖子 / 审计
 *   trainee → 默认角色，业务操作另受 LV1 门禁约束
 *
 * 防自锁：撤销「最后一个 admin」一律拒绝（E-1107）
 * 错误码：E-1101 非法状态、E-1103 字段非法、E-1104 不存在、E-1107 最后一个管理员
 * ---------------------------------------------------------------------------
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'

export type Role = 'admin' | 'trainee'

export interface User {
  id: string
  displayName: string
  roles: Role[]
  disabled: boolean
  createdAt: string
  lastSeenAt: string
}

export interface UsersDoc {
  schemaVersion: number
  bootstrapAt: string | null
  users: User[]
}

export const DOC_VERSION = 1
export const MAX_ID = 64
export const LOCK_TIMEOUT_MS = 2_000
export const LOCK_STALE_MS = 30_000

export class UsersError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'UsersError'
  }
}

export const configDir = (): string => join(stateDir(), 'config')
export const usersFile = (): string => join(configDir(), 'users.json')
export const usersLockFile = (): string => join(configDir(), 'users.json.lock')

function ensureDir(): void {
  mkdirSync(configDir(), { recursive: true })
}

export function emptyDoc(): UsersDoc {
  return { schemaVersion: DOC_VERSION, bootstrapAt: null, users: [] }
}

export function readUsers(): UsersDoc {
  const file = usersFile()
  if (!existsSync(file)) return emptyDoc()
  const raw = readFileSync(file, 'utf8')
  try {
    const doc = JSON.parse(raw) as UsersDoc
    if (!doc || !Array.isArray(doc.users)) throw new Error('缺少 users 数组')
    return {
      schemaVersion: Number.isInteger(doc.schemaVersion) ? doc.schemaVersion : DOC_VERSION,
      bootstrapAt: typeof doc.bootstrapAt === 'string' ? doc.bootstrapAt : null,
      users: doc.users.filter((u) => u && typeof u.id === 'string').map((u) => ({
        id: u.id,
        displayName: typeof u.displayName === 'string' ? u.displayName : u.id,
        roles: Array.isArray(u.roles) && u.roles.length ? (u.roles.filter((r) => r === 'admin' || r === 'trainee') as Role[]) : ['trainee'],
        disabled: Boolean(u.disabled),
        createdAt: typeof u.createdAt === 'string' ? u.createdAt : new Date().toISOString(),
        lastSeenAt: typeof u.lastSeenAt === 'string' ? u.lastSeenAt : new Date().toISOString(),
      })),
    }
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      writeFileSync(backup, raw, 'utf8')
    } catch {
      /* ignore */
    }
    throw new UsersError('E-1110', `用户数据损坏（${(err as Error).message}），已备份为 ${backup.split(/[\\/]/).pop()}。`)
  }
}

export function writeUsers(doc: UsersDoc): void {
  ensureDir()
  const file = usersFile()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const payload = JSON.stringify({ ...doc, updatedAt: new Date().toISOString() }, null, 2) + '\n'
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw new UsersError('E-1112', `写入用户数据失败：${(err as Error).message}`)
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function withUsersLock<T>(fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  ensureDir()
  const started = Date.now()
  for (;;) {
    let fd: number | null = null
    try {
      fd = openSync(usersLockFile(), 'wx')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw new UsersError('E-1111', `获取用户锁失败：${(err as Error).message}`)
      let stale = false
      try {
        const st = statSync(usersLockFile())
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true
        else {
          const info = JSON.parse(readFileSync(usersLockFile(), 'utf8')) as { pid: number }
          stale = !pidAlive(info.pid)
        }
      } catch {
        stale = false
      }
      if (stale) {
        try {
          rmSync(usersLockFile(), { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      if (Date.now() - started > timeoutMs) throw new UsersError('E-1111', `获取用户锁超时（${timeoutMs}ms）。`)
      sleepSync(20)
      continue
    }

    // 拿到锁之后：业务异常必须原样抛出，不能被当成锁错误
    try {
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return fn()
    } finally {
      try {
        rmSync(usersLockFile(), { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
export function validateId(id: string): string[] {
  const errors: string[] = []
  if (!id) errors.push('身份不能为空')
  else if (id.length > MAX_ID) errors.push(`身份不能超过 ${MAX_ID} 字符`)
  else if (!/^[\w.:@-]+$/.test(id)) errors.push('身份只能包含字母、数字、下划线、点、冒号、@、连字符')
  return errors
}

/** 解析身份：不存在则自动登记为 trainee（Q2 口径） */
export function resolveUser(actor: string, now: Date = new Date()): { user: User; created: boolean } {
  const errors = validateId(actor)
  if (errors.length) throw new UsersError('E-1103', errors.join('；'))
  return withUsersLock(() => {
    const doc = readUsers()
    const at = now.toISOString()
    const found = doc.users.find((u) => u.id === actor)
    if (found) {
      if (found.disabled) throw new UsersError('E-1108', `身份 ${actor} 已被禁用。`)
      const updated: User = { ...found, lastSeenAt: at }
      writeUsers({ ...doc, users: doc.users.map((u) => (u.id === actor ? updated : u)) })
      return { user: updated, created: false }
    }
    const user: User = { id: actor, displayName: actor, roles: ['trainee'], disabled: false, createdAt: at, lastSeenAt: at }
    writeUsers({ ...doc, users: [...doc.users, user] })
    return { user, created: true }
  })
}

export function hasRole(user: User, role: Role): boolean {
  return user.roles.includes(role)
}

export function isAdmin(actor: string): boolean {
  try {
    const doc = readUsers()
    const user = doc.users.find((u) => u.id === actor)
    return Boolean(user && !user.disabled && hasRole(user, 'admin'))
  } catch {
    return false
  }
}

export function adminCount(doc: UsersDoc = readUsers()): number {
  return doc.users.filter((u) => !u.disabled && hasRole(u, 'admin')).length
}

/** bootstrap：仅当还没有 admin 时可用（Q1 口径） */
export function bootstrapAdmin(actor: string, confirm: unknown, now: Date = new Date()): User {
  if (confirm !== true) throw new UsersError('E-1103', '初始化管理员需要显式确认（confirm:true）。')
  const errors = validateId(actor)
  if (errors.length) throw new UsersError('E-1103', errors.join('；'))
  return withUsersLock(() => {
    const doc = readUsers()
    if (adminCount(doc) > 0) throw new UsersError('E-1101', '已存在管理员，bootstrap 仅用于首次初始化。')
    const at = now.toISOString()
    const existing = doc.users.find((u) => u.id === actor)
    const user: User = existing
      ? { ...existing, roles: Array.from(new Set([...existing.roles, 'admin'] as Role[])), disabled: false, lastSeenAt: at }
      : { id: actor, displayName: actor, roles: ['admin'], disabled: false, createdAt: at, lastSeenAt: at }
    writeUsers({
      schemaVersion: DOC_VERSION,
      bootstrapAt: at,
      users: existing ? doc.users.map((u) => (u.id === actor ? user : u)) : [...doc.users, user],
    })
    return user
  })
}

export function setRole(actor: string, role: Role, grant: boolean, now: Date = new Date()): User {
  if (role !== 'admin' && role !== 'trainee') throw new UsersError('E-1103', `未知角色 ${String(role)}`)
  return withUsersLock(() => {
    const doc = readUsers()
    const user = doc.users.find((u) => u.id === actor)
    if (!user) throw new UsersError('E-1104', `用户不存在：${actor}`)
    if (!grant && role === 'admin' && adminCount(doc) <= 1 && hasRole(user, 'admin')) {
      throw new UsersError('E-1107', '不能撤销最后一个管理员（会把自己锁在外面）。')
    }
    const roles = grant ? Array.from(new Set([...user.roles, role])) : user.roles.filter((r) => r !== role)
    const next: User = { ...user, roles: roles.length ? roles : ['trainee'], lastSeenAt: now.toISOString() }
    writeUsers({ ...doc, users: doc.users.map((u) => (u.id === actor ? next : u)) })
    return next
  })
}

export function setDisabled(actor: string, disabled: boolean, now: Date = new Date()): User {
  return withUsersLock(() => {
    const doc = readUsers()
    const user = doc.users.find((u) => u.id === actor)
    if (!user) throw new UsersError('E-1104', `用户不存在：${actor}`)
    if (disabled && hasRole(user, 'admin') && adminCount(doc) <= 1) {
      throw new UsersError('E-1107', '不能禁用最后一个管理员。')
    }
    const next: User = { ...user, disabled, lastSeenAt: now.toISOString() }
    writeUsers({ ...doc, users: doc.users.map((u) => (u.id === actor ? next : u)) })
    return next
  })
}

export function listUsers(): { users: User[]; bootstrapAt: string | null; adminCount: number } {
  const doc = readUsers()
  return { users: doc.users, bootstrapAt: doc.bootstrapAt, adminCount: adminCount(doc) }
}
