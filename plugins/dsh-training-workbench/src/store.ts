/**
 * store.ts · 草稿存储（原子写 + 文件锁 + 已消费事件去重）
 * ---------------------------------------------------------------------------
 * 文件：%LOCALAPPDATA%\dsh-training\data\drafts.json
 * 结构：{ schemaVersion, updatedAt, seq, drafts: Draft[], consumed: string[] }
 *   consumed 记录已消费的事件 id（幂等，避免重启补扫时重复建草稿）
 *
 * 错误码：E-910 数据损坏（备份后报错，不覆盖）/ E-911 锁超时 / E-912 写失败
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
import type { Draft } from './draft.js'

export const DOC_VERSION = 1
export const LOCK_STALE_MS = 30_000
export const LOCK_TIMEOUT_MS = 2_000
/** consumed 队伍上限（防无限增长；事件量级不大，2000 足够） */
export const CONSUMED_LIMIT = 2000

export interface DraftsDoc {
  schemaVersion: number
  updatedAt: string
  seq: number
  drafts: Draft[]
  consumed: string[]
}

export class StoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'StoreError'
  }
}

export const dataDir = (): string => join(stateDir(), 'data')
export const draftsFile = (): string => join(dataDir(), 'drafts.json')
export const lockFile = (): string => join(dataDir(), 'drafts.json.lock')

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true })
}

export function emptyDoc(now: Date = new Date()): DraftsDoc {
  return { schemaVersion: DOC_VERSION, updatedAt: now.toISOString(), seq: 0, drafts: [], consumed: [] }
}

export function readDoc(now: Date = new Date()): DraftsDoc {
  const file = draftsFile()
  if (!existsSync(file)) return emptyDoc(now)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new StoreError('E-910', `读取草稿失败：${(err as Error).message}`)
  }
  try {
    const doc = JSON.parse(raw) as DraftsDoc
    if (!doc || !Array.isArray(doc.drafts)) throw new Error('缺少 drafts 数组')
    return {
      schemaVersion: Number.isInteger(doc.schemaVersion) ? doc.schemaVersion : DOC_VERSION,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : now.toISOString(),
      seq: Number.isInteger(doc.seq) ? doc.seq : doc.drafts.length,
      drafts: doc.drafts,
      consumed: Array.isArray(doc.consumed) ? doc.consumed : [],
    }
  } catch (err) {
    const backup = `${file}.corrupt-${now.getTime()}`
    try {
      writeFileSync(backup, raw, 'utf8')
    } catch {
      /* ignore */
    }
    throw new StoreError('E-910', `草稿数据损坏（${(err as Error).message}），已备份为 ${backup.split(/[\\/]/).pop()}。`)
  }
}

export function writeDoc(doc: DraftsDoc, now: Date = new Date()): void {
  ensureDir()
  const file = draftsFile()
  const tmp = `${file}.tmp-${process.pid}-${now.getTime()}`
  const payload = JSON.stringify({ ...doc, updatedAt: now.toISOString() }, null, 2) + '\n'
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
    throw new StoreError('E-912', `写入草稿失败：${(err as Error).message}`)
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isStale(now: number): boolean {
  try {
    const st = statSync(lockFile())
    if (now - st.mtimeMs > LOCK_STALE_MS) return true
    const info = JSON.parse(readFileSync(lockFile(), 'utf8')) as { pid: number }
    return !pidAlive(info.pid)
  } catch {
    return false
  }
}

function acquire(now: number = Date.now(), timeoutMs = LOCK_TIMEOUT_MS): () => void {
  ensureDir()
  const started = now
  for (;;) {
    try {
      const fd = openSync(lockFile(), 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          rmSync(lockFile(), { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw new StoreError('E-911', `获取锁失败：${(err as Error).message}`)
      if (isStale(Date.now())) {
        try {
          rmSync(lockFile(), { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      if (Date.now() - started > timeoutMs) throw new StoreError('E-911', `获取锁超时（${timeoutMs}ms）。`)
      sleepSync(20)
    }
  }
}

export function withLock<T>(fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const release = acquire(Date.now(), timeoutMs)
  try {
    return fn()
  } finally {
    release()
  }
}

export function updateDoc<T>(fn: (doc: DraftsDoc) => { doc: DraftsDoc; result: T }, now: Date = new Date()): T {
  return withLock(() => {
    const doc = readDoc(now)
    const { doc: next, result } = fn(doc)
    writeDoc(next, now)
    return result
  })
}

/** 记录已消费事件（保留最近 N 条） */
export function markConsumed(doc: DraftsDoc, eventId: string): DraftsDoc {
  if (!eventId || doc.consumed.includes(eventId)) return doc
  const consumed = [...doc.consumed, eventId].slice(-CONSUMED_LIMIT)
  return { ...doc, consumed }
}
