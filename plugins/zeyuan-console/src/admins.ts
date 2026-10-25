/**
 * admins.ts · 管理档位绑定（P6/P7/P8，收口 D-007）
 * ---------------------------------------------------------------------------
 * 文件：data/admins.json
 * 档位与业务等级分开：业务 LV0/LV1 由 license 决定；管理 P6/P7/P8 由这里决定。
 *
 * 规则：
 *   授予 P8 需操作者本身 P8；授予 P7/P6 需 P7+
 *   撤销/降级最后一名 P8 → E-1215（防自锁）
 * ---------------------------------------------------------------------------
 */

import { fileOf, readJson, withLock, writeJsonAtomic } from './store.js'

export type AdminTier = 6 | 7 | 8

export interface AdminRow {
  userId: string
  tier: AdminTier
  grantedBy: string
  grantedAt: string
  note?: string
}

export interface AdminsDoc {
  schemaVersion: number
  admins: AdminRow[]
}

export const ADMINS_FILE = 'admins.json'

export class AdminsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AdminsError'
  }
}

export function adminsPath(): string {
  return fileOf(ADMINS_FILE)
}

export function readAdmins(): AdminsDoc {
  const doc = readJson<AdminsDoc>(adminsPath(), { schemaVersion: 1, admins: [] })
  return {
    schemaVersion: 1,
    admins: Array.isArray(doc.admins)
      ? doc.admins.filter((a) => a && typeof a.userId === 'string' && [6, 7, 8].includes(a.tier))
      : [],
  }
}

export function writeAdmins(doc: { admins: AdminRow[] }): void {
  writeJsonAtomic(adminsPath(), { schemaVersion: 1, admins: doc.admins })
}

/** 用户档位（未绑定 = 0） */
export function tierOf(userId: string): 0 | AdminTier {
  const row = readAdmins().admins.find((a) => a.userId === userId)
  return row ? row.tier : 0
}

export function p8Count(doc: AdminsDoc = readAdmins()): number {
  return doc.admins.filter((a) => a.tier === 8).length
}

export function grantTier(actor: string, actorTier: 0 | AdminTier, userId: string, tier: AdminTier, note?: string, now: Date = new Date()): AdminRow {
  if (!userId) throw new AdminsError('E-1203', '缺少目标用户')
  if (![6, 7, 8].includes(tier)) throw new AdminsError('E-1203', `非法档位 ${String(tier)}`)
  if (tier === 8 && actorTier !== 8) throw new AdminsError('E-1202', '只有 P8（总师）可以授予 P8。')
  if (actorTier < 7) throw new AdminsError('E-1202', '需要 P7 及以上才能调整管理档位。')
  if (tier >= actorTier && tier === 8 && actorTier !== 8) throw new AdminsError('E-1202', '不能授予高于自己的档位。')
  return withLock('admins', () => {
    const doc = readAdmins()
    const row: AdminRow = {
      userId,
      tier,
      grantedBy: actor,
      grantedAt: now.toISOString(),
      ...(note ? { note } : {}),
    }
    writeAdmins({ admins: [...doc.admins.filter((a) => a.userId !== userId), row] })
    return row
  })
}

export function revokeTier(actor: string, actorTier: 0 | AdminTier, userId: string, now: Date = new Date()): AdminRow | null {
  if (actorTier < 7) throw new AdminsError('E-1202', '需要 P7 及以上才能调整管理档位。')
  return withLock('admins', () => {
    const doc = readAdmins()
    const row = doc.admins.find((a) => a.userId === userId)
    if (!row) return null
    if (row.tier === 8 && p8Count(doc) <= 1) throw new AdminsError('E-1215', '不能撤销最后一名 P8（总师）。')
    // 同档可互撤（P8 撤另一名 P8 是允许的）；只禁止撤更高档位
    if (row.tier > actorTier) {
      throw new AdminsError('E-1202', '不能撤销高于自己的档位。')
    }
    writeAdmins({ admins: doc.admins.filter((a) => a.userId !== userId) })
    void now
    return row
  })
}

export function listAdmins(): { admins: AdminRow[]; p8: number } {
  const doc = readAdmins()
  return { admins: doc.admins, p8: doc.admins.filter((a) => a.tier === 8).length }
}

/** 迁移：把旧 roles:['admin'] 的用户升级为 P8（幂等） */
export function migrateLegacyAdmins(userIds: string[], now: Date = new Date()): number {
  if (!userIds.length) return 0
  return withLock('admins', () => {
    const doc = readAdmins()
    let added = 0
    for (const id of userIds) {
      if (doc.admins.some((a) => a.userId === id)) continue
      doc.admins.push({ userId: id, tier: 8, grantedBy: 'migration', grantedAt: now.toISOString(), note: 'migrated from roles:admin' })
      added++
    }
    if (added) writeAdmins({ admins: doc.admins })
    return added
  })
}
