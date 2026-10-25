/**
 * users-gate.ts · 从控制面板的用户表判定管理员（收口 D-007）
 * 与 console/src/users.ts 同语义，这里只读；对等测试守护两处一致。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'

interface UserRow {
  id: string
  roles?: string[]
  disabled?: boolean
}

export function isAdminByRole(actor: string): boolean {
  try {
    const file = join(stateDir(), 'config', 'users.json')
    if (!existsSync(file)) return false
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { users?: UserRow[] }
    const user = (doc.users ?? []).find((u) => u.id === actor)
    if (!user || user.disabled) return false
    return Array.isArray(user.roles) && user.roles.includes('admin')
  } catch {
    return false
  }
}