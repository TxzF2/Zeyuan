/**
 * coin.ts · 金币申请单据（组长申请 → 控制台 P7+ 审批）
 * ---------------------------------------------------------------------------
 * 文件：data/coin-requests.json（**跨插件契约**：collab 写、console 审批写回）
 * 组长只能创建 pending 单据；**绝不能直接动钱包**（wallet 只由 console 调用）。
 * ---------------------------------------------------------------------------
 */

import { fileOf, readJson, withLock, writeJsonAtomic } from './store.js'

export type CoinRequestStatus = 'pending' | 'approved' | 'rejected'

export interface CoinRequest {
  id: string
  groupId: string
  requestedBy: string
  amount: number
  reason: string
  status: CoinRequestStatus
  createdAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  ledgerId: string | null
}

export interface CoinRequestsDoc {
  schemaVersion: number
  seq: number
  requests: CoinRequest[]
}

export const COIN_FILE = 'coin-requests.json'
export const MAX_AMOUNT = 100000

export class CoinError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CoinError'
  }
}

export function coinPath(): string {
  return fileOf(COIN_FILE)
}

export function readCoinRequests(): CoinRequestsDoc {
  const doc = readJson<CoinRequestsDoc>(coinPath(), { schemaVersion: 1, seq: 0, requests: [] })
  return {
    schemaVersion: 1,
    seq: Number.isInteger(doc.seq) ? doc.seq : 0,
    requests: Array.isArray(doc.requests) ? doc.requests : [],
  }
}

export function writeCoinRequests(doc: CoinRequestsDoc): void {
  writeJsonAtomic(coinPath(), doc)
}

export function requestCoins(groupId: string, leader: string, amount: number, reason: string, now: Date = new Date()): CoinRequest {
  if (!groupId) throw new CoinError('E-1303', '缺少组 id')
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) throw new CoinError('E-1303', `金额必须是 1~${MAX_AMOUNT} 的整数`)
  const r = String(reason ?? '').trim()
  if (r.length < 4) throw new CoinError('E-1303', '申请理由至少 4 字')
  return withLock('coin-requests', () => {
    const doc = readCoinRequests()
    const at = now.toISOString()
    const row: CoinRequest = {
      id: `cr-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
      groupId,
      requestedBy: leader,
      amount,
      reason: r.slice(0, 100),
      status: 'pending',
      createdAt: at,
      reviewedBy: null,
      reviewedAt: null,
      ledgerId: null,
    }
    writeCoinRequests({ ...doc, seq: doc.seq + 1, requests: [...doc.requests, row] })
    return row
  })
}

export function listCoinRequests(groupId?: string): CoinRequest[] {
  const rows = readCoinRequests().requests
  return (groupId ? rows.filter((r) => r.groupId === groupId) : rows).slice().reverse()
}
