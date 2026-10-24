/**
 * dashboard.ts · 仪表盘（四指标）+ 健康检查
 * ---------------------------------------------------------------------------
 * 指标口径：
 *   在线用户 = users.json 中 lastSeenAt 在 15 分钟窗内且未禁用的人数
 *   任务吞吐 = 今日发布（tasks.createdAt 今天）+ 今日完成（history 里 accept 今天）
 *   金币流水 = 钱包今日 delta 合计 / 笔数 / 其中管理员发币
 *   板块健康 = 五插件最近挂载状态（mount-events）+ 各插件在 profile 里的启停状态
 * 只读聚合，缺文件降级，不阻塞。
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAccess, licensePath, stateDir } from './license-gate.js'
import { listAdmins } from './admins.js'
import { listUsers } from './users.js'
import { reconcile, todayStats } from './wallet.js'
import { isPluginEnabled, PROTECTED_PACKAGES } from './profile-gate.js'

const dataDir = (): string => join(stateDir(), 'data')

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}

const isToday = (iso: unknown, now: Date): boolean => {
  if (typeof iso !== 'string') return false
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  const d = new Date(t)
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

export interface DashboardData {
  online: { current: number; total: number; disabled: number }
  tasks: { total: number; createdToday: number; acceptedToday: number; byStatus: Record<string, number> }
  coins: { today: number; count: number; grantedToday: number; reconcileOk: boolean }
  boards: { pkg: string; enabled: boolean; protected: boolean }[]
  admins: { p8: number; total: number }
  events: { total: number; recent: { at: string; type: string }[] }
}

export const PLUGIN_PACKAGES = [
  'dsh-training-protocol',
  'dsh-training-tasks',
  'dsh-training-workbench',
  'dsh-training-community',
  'dsh-training-console',
] as const

export function dashboard(now: Date = new Date()): DashboardData {
  const users = listUsers(15 * 60 * 1000, now)
  const tasksFile = readJsonSafe(join(dataDir(), 'tasks.json'))
  const taskRows = asRows(tasksFile?.tasks)
  const createdToday = taskRows.filter((t) => isToday(t.createdAt, now)).length
  const acceptedToday = taskRows.filter((t) =>
    asRows(t.history).some((h) => h.action === 'accept' && isToday(h.at, now)),
  ).length
  const byStatus: Record<string, number> = {}
  for (const t of taskRows) {
    const s = typeof t.status === 'string' ? t.status : 'unknown'
    byStatus[s] = (byStatus[s] ?? 0) + 1
  }

  const coins = todayStats(now)
  const recon = reconcile()
  const admins = listAdmins()

  const boards = PLUGIN_PACKAGES.map((pkg) => ({
    pkg,
    enabled: isPluginEnabled(pkg),
    protected: PROTECTED_PACKAGES.includes(pkg as (typeof PROTECTED_PACKAGES)[number]),
  }))

  let eventTotal = 0
  const recent: { at: string; type: string }[] = []
  try {
    const file = join(stateDir(), 'event-log.jsonl')
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      eventTotal = lines.length
      for (const line of lines.slice(-5)) {
        try {
          const ev = JSON.parse(line) as { at?: string; type?: string }
          recent.push({ at: ev.at ?? '', type: ev.type ?? '' })
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* ignore */
  }

  return {
    online: { current: users.online, total: users.total, disabled: users.disabled },
    tasks: { total: taskRows.length, createdToday, acceptedToday, byStatus },
    coins: { today: coins.coins, count: coins.count, grantedToday: coins.granted, reconcileOk: recon.ok },
    boards,
    admins: { p8: admins.p8, total: admins.admins.length },
    events: { total: eventTotal, recent },
  }
}

export interface HealthData {
  ok: boolean
  plugins: { plugin: string; lastEvent: string; at: string | null; host: string | null }[]
  files: Record<string, boolean>
  license: { level: string; code: string; expiresAt: string | null }
  reconcile: { ok: boolean; ledgerSum: number; balanceSum: number; mismatches: string[] }
}

export function health(now: Date = new Date()): HealthData {
  const last = new Map<string, { event: string; at: string | null; host: string | null }>()
  try {
    const file = join(stateDir(), 'mount-events.jsonl')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const ev = JSON.parse(line) as { plugin?: string; event?: string; at?: string; host?: string }
          if (ev.plugin && (PLUGIN_PACKAGES as readonly string[]).includes(ev.plugin)) {
            last.set(ev.plugin, { event: ev.event ?? '', at: ev.at ?? null, host: ev.host ?? null })
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* ignore */
  }

  const plugins = PLUGIN_PACKAGES.map((p) => ({
    plugin: p,
    lastEvent: last.get(p)?.event ?? 'missing',
    at: last.get(p)?.at ?? null,
    host: last.get(p)?.host ?? null,
  }))

  const files = {
    users: existsSync(join(dataDir(), 'users.json')),
    admins: existsSync(join(dataDir(), 'admins.json')),
    scopes: existsSync(join(dataDir(), 'scopes.json')),
    wallet: existsSync(join(dataDir(), 'wallet.json')),
    audit: existsSync(join(dataDir(), 'audit-log.jsonl')),
    tasks: existsSync(join(dataDir(), 'tasks.json')),
    posts: existsSync(join(dataDir(), 'posts.json')),
    license: existsSync(licensePath()),
  }

  const access = checkAccess(now)
  let expiresAt: string | null = null
  try {
    if (existsSync(licensePath())) {
      const raw = JSON.parse(readFileSync(licensePath(), 'utf8')) as { expiresAt?: string }
      expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : null
    }
  } catch {
    /* ignore */
  }

  const reconcileResult = reconcile()
  const ok = plugins.every((p) => p.lastEvent === 'mounted') && access.ok && reconcileResult.ok

  return {
    ok,
    plugins,
    files,
    license: { level: access.level, code: access.code, expiresAt },
    reconcile: reconcileResult,
  }
}
