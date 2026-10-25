/**
 * audit.ts · 审计日志（data/audit-log.jsonl）
 * ---------------------------------------------------------------------------
 * 每条：{ at, actor, businessLevel, adminTier, action, target, before, after, result, reason, error }
 * 高危操作成功与失败**都要记**；失败记 error。
 * ---------------------------------------------------------------------------
 */

import { appendJsonl, fileOf, readJsonl } from './store.js'

export const AUDIT_FILE = 'audit-log.jsonl'
export const MAX_REASON = 200

export interface AuditRow {
  at: string
  actor: string
  businessLevel: string
  adminTier: number
  action: string
  target: string | null
  before: unknown
  after: unknown
  result: 'ok' | 'error'
  reason: string | null
  error: string | null
}

export interface AuditInput {
  actor: string
  businessLevel: string
  adminTier: number
  action: string
  target?: string | null
  before?: unknown
  after?: unknown
  result?: 'ok' | 'error'
  reason?: string | null
  error?: string | null
}

export function auditPath(): string {
  return fileOf(AUDIT_FILE)
}

export function writeAudit(input: AuditInput, now: Date = new Date()): AuditRow {
  const row: AuditRow = {
    at: now.toISOString(),
    actor: input.actor,
    businessLevel: input.businessLevel,
    adminTier: input.adminTier,
    action: input.action,
    target: input.target ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    result: input.result ?? 'ok',
    reason: input.reason ? input.reason.slice(0, MAX_REASON) : null,
    error: input.error ?? null,
  }
  appendJsonl(auditPath(), row)
  return row
}

export function listAudit(limit = 50, action?: string): { total: number; rows: AuditRow[] } {
  const all = readJsonl<AuditRow>(auditPath())
  const filtered = action ? all.filter((r) => r.action === action) : all
  return { total: filtered.length, rows: filtered.slice(-limit).reverse() }
}

/** 高危操作校验：必须 confirm=true 且 reason ≥ 4 字 */
export function requireConfirm(body: Record<string, unknown>): string {
  if (body.confirm !== true) {
    const err = new Error('高危操作需要显式确认（confirm:true）。')
    ;(err as Error & { code: string }).code = 'E-1203'
    throw err
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 4) {
    const err = new Error('高危操作必须填写原因（reason ≥ 4 字），便于审计追溯。')
    ;(err as Error & { code: string }).code = 'E-1203'
    throw err
  }
  return reason.slice(0, MAX_REASON)
}
