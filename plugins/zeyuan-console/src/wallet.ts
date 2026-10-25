/**
 * wallet.ts · 最小钱包（余额 + 流水，账必须对）
 * ---------------------------------------------------------------------------
 * 文件：data/wallet.json
 *   balances: { userId: number }
 *   ledger:   [{ id, at, userId, delta, reason, ref }]
 *   consumed: 已入账的事件 id（幂等）
 *
 * 入账来源：
 *   1. 任务赏金事件 zeyuan:tasks:reward（ref=事件 id，幂等）
 *   2. 管理员发币（P8，必须带 reason）
 * 规则：不扣款（当前无消费场景），delta 必须为正整数；余额 = 流水合计（对账断言）。
 * ---------------------------------------------------------------------------
 */

import { fileOf, readJson, withLock, writeJsonAtomic } from './store.js'
import type { AdminTier } from './admins.js'

export interface LedgerRow {
  id: string
  at: string
  userId: string
  delta: number
  reason: string
  ref: string | null
}

export interface WalletDoc {
  schemaVersion: number
  balances: Record<string, number>
  ledger: LedgerRow[]
  consumed: string[]
}

export const WALLET_FILE = 'wallet.json'
export const MAX_GRANT = 1_000_000
export const CONSUMED_LIMIT = 2000

export class WalletError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'WalletError'
  }
}

export function walletPath(): string {
  return fileOf(WALLET_FILE)
}

export function readWallet(): WalletDoc {
  const doc = readJson<WalletDoc>(walletPath(), { schemaVersion: 1, balances: {}, ledger: [], consumed: [] })
  return {
    schemaVersion: 1,
    balances: doc.balances && typeof doc.balances === 'object' ? doc.balances : {},
    ledger: Array.isArray(doc.ledger) ? doc.ledger : [],
    consumed: Array.isArray(doc.consumed) ? doc.consumed : [],
  }
}

export function writeWallet(doc: WalletDoc): void {
  writeJsonAtomic(walletPath(), {
    schemaVersion: 1,
    balances: doc.balances,
    ledger: doc.ledger,
    consumed: doc.consumed.slice(-CONSUMED_LIMIT),
  })
}

function credit(doc: WalletDoc, userId: string, delta: number, reason: string, ref: string | null, now: Date): { doc: WalletDoc; row: LedgerRow; balance: number } {
  const row: LedgerRow = { id: `lg-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`, at: now.toISOString(), userId, delta, reason, ref }
  const balance = (doc.balances[userId] ?? 0) + delta
  const next: WalletDoc = {
    ...doc,
    balances: { ...doc.balances, [userId]: balance },
    ledger: [...doc.ledger, row],
    consumed: ref ? [...doc.consumed, ref].slice(-CONSUMED_LIMIT) : doc.consumed,
  }
  return { doc: next, row, balance }
}

/** 任务赏金入账（幂等：ref=事件 id） */
export function ingestReward(eventId: string, userId: string, coins: number, now: Date = new Date()): { credited: boolean; balance: number; reason?: string } {
  if (!userId) return { credited: false, balance: 0, reason: 'no-user' }
  if (!Number.isInteger(coins) || coins <= 0) return { credited: false, balance: 0, reason: 'invalid-amount' }
  return withLock('wallet', () => {
    const doc = readWallet()
    if (eventId && doc.consumed.includes(eventId)) {
      return { credited: false, balance: doc.balances[userId] ?? 0, reason: 'duplicate' }
    }
    const r = credit(doc, userId, coins, 'task-reward', eventId || null, now)
    writeWallet(r.doc)
    return { credited: true, balance: r.balance }
  })
}

/** 管理员发币（P8） */
export function grantCoins(actor: string, actorTier: 0 | AdminTier, userId: string, amount: number, reason: string, now: Date = new Date()): { row: LedgerRow; balance: number } {
  if (actorTier !== 8) throw new WalletError('E-1202', '只有 P8（总师）可以发币。')
  if (!userId) throw new WalletError('E-1203', '缺少目标用户')
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_GRANT) throw new WalletError('E-1203', `金额必须是 1~${MAX_GRANT} 的整数`)
  return withLock('wallet', () => {
    const doc = readWallet()
    const r = credit(doc, userId, amount, `admin-grant:${reason.slice(0, 60)}`, null, now)
    writeWallet(r.doc)
    void actor
    return { row: r.row, balance: r.balance }
  })
}

export function balanceOf(userId: string): number {
  return readWallet().balances[userId] ?? 0
}

export function listLedger(limit = 50, userId?: string): LedgerRow[] {
  const rows = readWallet().ledger
  const filtered = userId ? rows.filter((r) => r.userId === userId) : rows
  return filtered.slice(-limit).reverse()
}

/** 对账：balances 合计必须等于 ledger.delta 合计 */
export function reconcile(): { ok: boolean; ledgerSum: number; balanceSum: number; mismatches: string[] } {
  const doc = readWallet()
  const ledgerSum = doc.ledger.reduce((s, r) => s + (Number.isFinite(r.delta) ? r.delta : 0), 0)
  const balanceSum = Object.values(doc.balances).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)
  const perUser = new Map<string, number>()
  for (const r of doc.ledger) perUser.set(r.userId, (perUser.get(r.userId) ?? 0) + r.delta)
  const mismatches: string[] = []
  for (const [user, sum] of perUser) {
    if ((doc.balances[user] ?? 0) !== sum) mismatches.push(`${user}: balance=${doc.balances[user] ?? 0} ledger=${sum}`)
  }
  for (const user of Object.keys(doc.balances)) {
    if (!perUser.has(user)) mismatches.push(`${user}: balance=${doc.balances[user]} ledger=0`)
  }
  return { ok: ledgerSum === balanceSum && mismatches.length === 0, ledgerSum, balanceSum, mismatches }
}

/** 今日流水统计（用于仪表盘） */
export function todayStats(now: Date = new Date()): { coins: number; count: number; granted: number } {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const rows = readWallet().ledger.filter((r) => Date.parse(r.at) >= dayStart)
  return {
    coins: rows.reduce((s, r) => s + r.delta, 0),
    count: rows.length,
    granted: rows.filter((r) => r.reason.startsWith('admin-grant')).reduce((s, r) => s + r.delta, 0),
  }
}
