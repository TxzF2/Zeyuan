/**
 * dashboard.ts · 仪表盘与健康检查（纯读聚合，不落新数据）
 * ---------------------------------------------------------------------------
 * 原则：只读各板块的数据文件，失败一律降级为 null，不阻塞面板。
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAccess, licensePath, stateDir } from './license-gate.js'
import { boardStatus } from './boards.js'
import { listUsers } from './users.js'

const dataDir = (): string => join(stateDir(), 'data')

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}

export interface Dashboard {
  tasks: { total: number; byStatus: Record<string, number> }
  drafts: { total: number; byStatus: Record<string, number> }
  posts: { total: number; byStatus: Record<string, number>; likes: number }
  events: { total: number; recent: { at: string; type: string }[] }
  users: { total: number; admins: number; bootstrapAt: string | null }
  boards: { id: string; enabled: boolean; protected: boolean }[]
}

export function dashboard(now: Date = new Date()): Dashboard {
  void now
  const tasks = readJson(join(dataDir(), 'tasks.json'))
  const drafts = readJson(join(dataDir(), 'drafts.json'))
  const posts = readJson(join(dataDir(), 'posts.json'))

  const countBy = (rows: Record<string, unknown>[]) => {
    const out: Record<string, number> = {}
    for (const r of rows) {
      const s = typeof r.status === 'string' ? r.status : 'unknown'
      out[s] = (out[s] ?? 0) + 1
    }
    return out
  }

  const taskRows = asArray(tasks?.tasks)
  const draftRows = asArray(drafts?.drafts)
  const postRows = asArray(posts?.posts)
  const likes = postRows.reduce((sum, p) => sum + (typeof p.likes === 'number' ? p.likes : 0), 0)

  // 事件日志：只取总数与最近 5 条（不整文件解析成对象数组，避免大文件内存抖动）
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

  const users = listUsers()

  return {
    tasks: { total: taskRows.length, byStatus: countBy(taskRows) },
    drafts: { total: draftRows.length, byStatus: countBy(draftRows) },
    posts: { total: postRows.length, byStatus: countBy(postRows), likes },
    events: { total: eventTotal, recent },
    users: { total: users.users.length, admins: users.adminCount, bootstrapAt: users.bootstrapAt },
    boards: boardStatus(),
  }
}

export interface Health {
  ok: boolean
  plugins: { plugin: string; lastEvent: string; at: string | null; host: string | null }[]
  files: Record<string, boolean>
  license: { level: string; code: string; expiresAt: string | null }
}

const PLUGINS = ['dsh-training-protocol', 'dsh-training-tasks', 'dsh-training-workbench', 'dsh-training-community', 'dsh-training-console']

export function health(now: Date = new Date()): Health {
  const last = new Map<string, { event: string; at: string | null; host: string | null }>()
  try {
    const file = join(stateDir(), 'mount-events.jsonl')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const ev = JSON.parse(line) as { plugin?: string; event?: string; at?: string; host?: string }
          if (ev.plugin && PLUGINS.includes(ev.plugin)) {
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

  const plugins = PLUGINS.map((p) => ({
    plugin: p,
    lastEvent: last.get(p)?.event ?? 'missing',
    at: last.get(p)?.at ?? null,
    host: last.get(p)?.host ?? null,
  }))

  const files = {
    tasks: existsSync(join(dataDir(), 'tasks.json')),
    drafts: existsSync(join(dataDir(), 'drafts.json')),
    posts: existsSync(join(dataDir(), 'posts.json')),
    users: existsSync(join(stateDir(), 'config', 'users.json')),
    boards: existsSync(join(stateDir(), 'config', 'boards.json')),
    license: existsSync(licensePath()),
  }

  const access = checkAccess(now)
  const license = (() => {
    try {
      if (!existsSync(licensePath())) return { level: access.level, code: access.code, expiresAt: null }
      const raw = JSON.parse(readFileSync(licensePath(), 'utf8')) as { expiresAt?: string }
      return { level: access.level, code: access.code, expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null }
    } catch {
      return { level: access.level, code: access.code, expiresAt: null }
    }
  })()

  const ok = plugins.every((p) => p.lastEvent === 'mounted') && access.ok
  return { ok, plugins, files, license }
}
