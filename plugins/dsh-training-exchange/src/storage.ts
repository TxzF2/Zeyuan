/**
 * storage.ts · 中转站文件存储（data/exchange/）
 * ---------------------------------------------------------------------------
 * 布局：data/exchange/<id>.bin + <id>.meta.json
 * 写入：先写 <id>.bin.tmp-<pid>，完成后 rename 为 .bin，再原子写 meta
 * 匿名：上传者只记节点 ID（x-dsh-user），meta 不含任何真人信息
 * 过期：expiresAt = createdAt + 30 天（清理逻辑在第二小步）
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'
import { writeJsonAtomic } from './store.js'

export const MAX_FILE_BYTES = 500 * 1024 * 1024
export const RETENTION_DAYS = 30

export interface FileMeta {
  id: string
  name: string
  size: number
  mime: string
  uploader: string
  createdAt: string
  expiresAt: string
}

export const exchangeDir = (): string => join(stateDir(), 'data', 'exchange')
export const binPath = (id: string): string => join(exchangeDir(), `${id}.bin`)
export const metaPath = (id: string): string => join(exchangeDir(), `${id}.meta.json`)

export function ensureDir(): void {
  mkdirSync(exchangeDir(), { recursive: true })
}

export function makeId(now: Date = new Date()): string {
  return `x-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function isValidId(id: string): boolean {
  return /^x-[a-z0-9]+-[a-z0-9]+$/i.test(id)
}

export function writeMeta(meta: FileMeta): void {
  ensureDir()
  writeJsonAtomic(metaPath(meta.id), meta)
}

export function readMeta(id: string): FileMeta | null {
  try {
    if (!isValidId(id) || !existsSync(metaPath(id))) return null
    return JSON.parse(readFileSync(metaPath(id), 'utf8')) as FileMeta
  } catch {
    return null
  }
}

export function listMetas(now: Date = new Date()): FileMeta[] {
  const dir = exchangeDir()
  if (!existsSync(dir)) return []
  const rows: FileMeta[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue
    const id = f.replace(/\.meta\.json$/, '')
    const meta = readMeta(id)
    if (!meta) continue
    // 过期文件不列出（清理留到第二小步，先隐藏）
    if (Date.parse(meta.expiresAt) <= now.getTime()) continue
    rows.push(meta)
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export function isExpired(meta: FileMeta, now: Date = new Date()): boolean {
  return Date.parse(meta.expiresAt) <= now.getTime()
}

export function removeFiles(id: string): boolean {
  let removed = false
  for (const p of [binPath(id), metaPath(id)]) {
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true })
        removed = true
      }
    } catch {
      /* ignore */
    }
  }
  return removed
}

export function sizeOf(id: string): number {
  try {
    return existsSync(binPath(id)) ? statSync(binPath(id)).size : 0
  } catch {
    return 0
  }
}

/** 上传时先落临时文件，成功后 rename（避免半截文件被下载） */
export function tmpPathFor(id: string): string {
  ensureDir()
  return join(exchangeDir(), `${id}.bin.tmp-${process.pid}`)
}

export function commitTmp(tmp: string, id: string): void {
  renameSync(tmp, binPath(id))
}

export function cleanupTmp(tmp: string): void {
  try {
    rmSync(tmp, { force: true })
  } catch {
    /* ignore */
  }
}
