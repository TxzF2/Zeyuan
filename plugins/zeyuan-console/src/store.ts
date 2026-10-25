/**
 * store.ts · 控制台数据层基座（原子 JSON + 文件锁 + JSONL 追加）
 * ---------------------------------------------------------------------------
 * 统一规则（与 tasks/workbench/community 同构，D-006 待抽共享模板）：
 *   读：损坏 → 备份 <file>.corrupt-<ts> 并抛错（绝不覆盖）
 *   写：tmp → fsync → rename（同卷原子）
 *   锁：O_EXCL，30s stale，pid 存活检测，2s 超时
 *   审计：data/audit-log.jsonl 追加
 * ---------------------------------------------------------------------------
 */

import {
  appendFileSync,
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

export const LOCK_STALE_MS = 30_000
export const LOCK_TIMEOUT_MS = 2_000

export class StoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'StoreError'
  }
}

export const dataDir = (): string => join(stateDir(), 'data')

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true })
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 读 JSON；缺文件返回 fallback；损坏备份后抛 E-1210 */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  const raw = readFileSync(file, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      writeFileSync(backup, raw, 'utf8')
    } catch {
      /* ignore */
    }
    throw new StoreError('E-1210', `${file.split(/[\\/]/).pop()} 损坏（${(err as Error).message}），已备份为 ${backup.split(/[\\/]/).pop()}。`)
  }
}

/** 原子写 JSON */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const payload = JSON.stringify(value, null, 2) + '\n'
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
    throw new StoreError('E-1212', `写入 ${file.split(/[\\/]/).pop()} 失败：${(err as Error).message}`)
  }
}

/** 加锁执行；业务异常原样抛出 */
export function withLock<T>(name: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  ensureDir()
  const lockFile = join(dataDir(), `${name}.lock`)
  const started = Date.now()
  for (;;) {
    let fd = null
    try {
      fd = openSync(lockFile, 'wx')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw new StoreError('E-1211', `获取锁失败：${(err as Error).message}`)
      let stale = false
      try {
        const st = statSync(lockFile)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true
        else {
          const info = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number }
          stale = !pidAlive(info.pid)
        }
      } catch {
        stale = false
      }
      if (stale) {
        try {
          rmSync(lockFile, { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      if (Date.now() - started > timeoutMs) throw new StoreError('E-1211', `获取锁超时（${timeoutMs}ms）。`)
      sleepSync(20)
      continue
    }
    try {
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return fn()
    } finally {
      try {
        rmSync(lockFile, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/** 追加 JSONL（审计/流水） */
export function appendJsonl(file: string, row: unknown): void {
  ensureDir()
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
}

/** 读 JSONL，坏行跳过 */
export function readJsonl<T>(file: string, limit?: number): T[] {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const slice = typeof limit === 'number' ? lines.slice(-limit) : lines
  const out: T[] = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* skip */
    }
  }
  return out
}

export const fileOf = (name: string): string => join(dataDir(), name)
