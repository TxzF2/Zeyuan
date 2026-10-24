/**
 * store.ts · 任务数据持久化（文件锁 + 原子写）
 * ---------------------------------------------------------------------------
 * 文件：%LOCALAPPDATA%\dsh-training\data\tasks.json
 * 锁  ：同目录 tasks.json.lock（O_EXCL 创建，30s 视为 stale，含 pid 存活检测）
 * 写  ：临时文件 → fsync → rename（同卷原子替换，不会出现半截 JSON）
 *
 * 错误码：
 *   E-810 数据文件损坏（已备份为 tasks.json.corrupt-<ts>，不覆盖原文件）
 *   E-811 获取文件锁超时
 *   E-812 写入失败
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
import type { Task } from './task.js'

export const DOC_VERSION = 1
export const LOCK_STALE_MS = 30_000
export const LOCK_TIMEOUT_MS = 2_000

export interface TasksDoc {
  schemaVersion: number
  updatedAt: string
  seq: number
  tasks: Task[]
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
export const tasksFile = (): string => join(dataDir(), 'tasks.json')
export const lockFile = (): string => join(dataDir(), 'tasks.json.lock')

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true })
}

export function emptyDoc(now: Date = new Date()): TasksDoc {
  return { schemaVersion: DOC_VERSION, updatedAt: now.toISOString(), seq: 0, tasks: [] }
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/** 读文档；损坏时备份并抛 E-810（绝不静默覆盖） */
export function readDoc(now: Date = new Date()): TasksDoc {
  const file = tasksFile()
  if (!existsSync(file)) return emptyDoc(now)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new StoreError('E-810', `读取任务数据失败：${(err as Error).message}`)
  }
  try {
    const doc = JSON.parse(raw) as TasksDoc
    if (!doc || !Array.isArray(doc.tasks)) throw new Error('缺少 tasks 数组')
    return {
      schemaVersion: typeof doc.schemaVersion === 'number' ? doc.schemaVersion : DOC_VERSION,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : now.toISOString(),
      seq: Number.isInteger(doc.seq) ? doc.seq : doc.tasks.length,
      tasks: doc.tasks,
    }
  } catch (err) {
    const backup = `${file}.corrupt-${now.getTime()}`
    try {
      writeFileSync(backup, raw, 'utf8')
    } catch {
      /* 备份失败也要报错，不能吞 */
    }
    throw new StoreError(
      'E-810',
      `任务数据损坏（${(err as Error).message}），已备份为 ${backup.split(/[\\/]/).pop()}，未覆盖原文件。`,
    )
  }
}

/** 原子写：tmp → fsync → rename */
export function writeDoc(doc: TasksDoc, now: Date = new Date()): void {
  ensureDir()
  const file = tasksFile()
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
    throw new StoreError('E-812', `写入任务数据失败：${(err as Error).message}`)
  }
}

interface LockInfo {
  pid: number
  at: number
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
    const info = JSON.parse(readFileSync(lockFile(), 'utf8')) as LockInfo
    return !pidAlive(info.pid)
  } catch {
    return false
  }
}

/** 抢锁；返回释放函数 */
function acquire(now: number = Date.now(), timeoutMs = LOCK_TIMEOUT_MS): () => void {
  ensureDir()
  const started = now
  for (;;) {
    try {
      const fd = openSync(lockFile(), 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockInfo))
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
      if (code !== 'EEXIST') throw new StoreError('E-811', `获取文件锁失败：${(err as Error).message}`)
      if (isStale(Date.now())) {
        try {
          rmSync(lockFile(), { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      if (Date.now() - started > timeoutMs) {
        throw new StoreError('E-811', `获取文件锁超时（${timeoutMs}ms），可能有其它操作正在进行。`)
      }
      sleepSync(20)
    }
  }
}

/** 在锁内执行（读 → 改 → 写） */
export function withLock<T>(fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const release = acquire(Date.now(), timeoutMs)
  try {
    return fn()
  } finally {
    release()
  }
}

/** 常用组合：加锁读改，返回业务结果与是否落盘 */
export function updateDoc<T>(fn: (doc: TasksDoc) => { doc: TasksDoc; result: T }, now: Date = new Date()): T {
  return withLock(() => {
    const doc = readDoc(now)
    const { doc: next, result } = fn(doc)
    writeDoc(next, now)
    return result
  })
}
