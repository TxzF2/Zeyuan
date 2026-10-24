/**
 * scopes.ts · 用户级 scope 下发
 * ---------------------------------------------------------------------------
 * 文件：data/scopes.json
 * 规则：P7 可授予/撤销 training:review；training:admin 只有 P8 能下发。
 * 变更都会对外发事件（console:scope-granted / scope-revoked）并写审计。
 * ---------------------------------------------------------------------------
 */

import { fileOf, readJson, withLock, writeJsonAtomic } from './store.js'
import type { AdminTier } from './admins.js'

export const KNOWN_SCOPES = ['training:playground', 'training:review', 'training:admin'] as const
export type Scope = (typeof KNOWN_SCOPES)[number]

export interface ScopeRow {
  userId: string
  scopes: Scope[]
  updatedAt: string
  updatedBy: string
}

export interface ScopesDoc {
  schemaVersion: number
  rows: ScopeRow[]
}

export const SCOPES_FILE = 'scopes.json'

export class ScopesError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ScopesError'
  }
}

export function scopesPath(): string {
  return fileOf(SCOPES_FILE)
}

export function readScopes(): ScopesDoc {
  const doc = readJson<ScopesDoc>(scopesPath(), { schemaVersion: 1, rows: [] })
  return {
    schemaVersion: 1,
    rows: Array.isArray(doc.rows)
      ? doc.rows.filter((r) => r && typeof r.userId === 'string' && Array.isArray(r.scopes))
      : [],
  }
}

export function writeScopes(doc: { rows: ScopeRow[] }): void {
  writeJsonAtomic(scopesPath(), { schemaVersion: 1, rows: doc.rows })
}

export function scopesOf(userId: string): Scope[] {
  return readScopes().rows.find((r) => r.userId === userId)?.scopes ?? []
}

function requireTierFor(scope: Scope, actorTier: 0 | AdminTier): void {
  if (scope === 'training:admin') {
    if (actorTier !== 8) throw new ScopesError('E-1202', 'training:admin 只有 P8（总师）可以下发。')
    return
  }
  if (actorTier < 7) throw new ScopesError('E-1202', '需要 P7 及以上才能下发 scope。')
}

export function grantScope(actor: string, actorTier: 0 | AdminTier, userId: string, scope: string, now: Date = new Date()): ScopeRow {
  if (!userId) throw new ScopesError('E-1203', '缺少目标用户')
  if (!KNOWN_SCOPES.includes(scope as Scope)) throw new ScopesError('E-1203', `未知 scope：${scope}`)
  requireTierFor(scope as Scope, actorTier)
  return withLock('scopes', () => {
    const doc = readScopes()
    const current = doc.rows.find((r) => r.userId === userId)
    const next: ScopeRow = {
      userId,
      scopes: Array.from(new Set([...(current?.scopes ?? []), scope as Scope])),
      updatedAt: now.toISOString(),
      updatedBy: actor,
    }
    writeScopes({ rows: [...doc.rows.filter((r) => r.userId !== userId), next] })
    return next
  })
}

export function revokeScope(actor: string, actorTier: 0 | AdminTier, userId: string, scope: string, now: Date = new Date()): ScopeRow | null {
  if (!KNOWN_SCOPES.includes(scope as Scope)) throw new ScopesError('E-1203', `未知 scope：${scope}`)
  requireTierFor(scope as Scope, actorTier)
  return withLock('scopes', () => {
    const doc = readScopes()
    const current = doc.rows.find((r) => r.userId === userId)
    if (!current) return null
    const next: ScopeRow = {
      userId,
      scopes: current.scopes.filter((s) => s !== scope),
      updatedAt: now.toISOString(),
      updatedBy: actor,
    }
    writeScopes({ rows: [...doc.rows.filter((r) => r.userId !== userId), next] })
    return next
  })
}

export function listScopes(): ScopeRow[] {
  return readScopes().rows
}
