/**
 * storage.ts · 文件落盘适配器（P0）
 * ---------------------------------------------------------------------------
 * 原则：
 *   - id 不可猜：crypto.randomUUID()，绝不来自自增/时间戳/原名/哈希
 *   - 原名只进 meta，**路径永不使用原名**：data/exchange/<id>.bin
 *   - 原子提交：先写 <id>.bin.tmp，fsync 后 rename 成 .bin
 *   - meta 是提交点：bin 先落、meta 后落；meta 一出现即对外可见
 *   - 删除：先删 meta（立刻不可见）再删 bin
 *
 * 保留期/权限策略不在此处写死（TODO(总控裁决)），只提供机制。
 * ---------------------------------------------------------------------------
 */

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { stateDir } from './license-gate.js'

/** 大小上限：可配置，默认 50MB（早拒，不读完再拒） */
export const MAX_UPLOAD_BYTES = Number(process.env.DSH_EXCHANGE_MAX_UPLOAD ?? 50 * 1024 * 1024)

/** 保留期：TODO(总控裁决)，先给 30 天占位 */
export const RETENTION_DAYS = 30

export const exchangeDir = (): string => join(stateDir(), 'data', 'exchange')
export const binPath = (id: string): string => join(exchangeDir(), `${id}.bin`)
export const metaPath = (id: string): string => join(exchangeDir(), `${id}.meta.json`)
export const tmpBinPath = (id: string): string => join(exchangeDir(), `${id}.bin.tmp-${process.pid}`)
export const tmpMetaPath = (id: string): string => join(exchangeDir(), `${id}.meta.json.tmp-${process.pid}`)

export function ensureDir(): void {
  mkdirSync(exchangeDir(), { recursive: true })
}

/** id 不可猜：UUID v4（36 字符，不可从原名/哈希推导） */
export function newId(): string {
  return randomUUID()
}

export function isValidId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export interface TempResult {
  tmpPath: string
  size: number
  sha256: string
}

/** 流式写临时文件，边写边算 sha256，写完 fsync；超限立即抛错 */
export async function putTemp(stream: Readable | AsyncIterable<unknown>): Promise<TempResult> {
  ensureDir()
  const id = newId()
  const tmpPath = tmpBinPath(id)
  const hash = createHash('sha256')
  let size = 0
  let fd: number | null = null
  try {
    fd = openSync(tmpPath, 'w')
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error(`单文件上限 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`), { status: 413, code: 'E-1501' })
      }
      hash.update(buf)
      writeSync(fd, buf)
    }
    if (size === 0) {
      throw Object.assign(new Error('空文件'), { status: 400, code: 'E-1503' })
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    return { tmpPath, size, sha256: hash.digest('hex') }
  } catch (err) {
    if (fd !== null) closeSync(fd)
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/** 临时文件 → 正式 bin（同目录 rename，原子） */
export function commit(tmpPath: string, id: string): { binPath: string } {
  ensureDir()
  const target = binPath(id)
  renameSync(tmpPath, target)
  return { binPath: target }
}

export function readStream(id: string): Readable {
  return createReadStream(binPath(id))
}

export function binExists(id: string): boolean {
  return existsSync(binPath(id))
}

export function metaExists(id: string): boolean {
  return existsSync(metaPath(id))
}

export function sizeOf(id: string): number {
  try {
    return existsSync(binPath(id)) ? statSync(binPath(id)).size : 0
  } catch {
    return 0
  }
}

export function removeBin(id: string): void {
  rmSync(binPath(id), { force: true })
}

export function cleanupTmp(tmpPath: string): void {
  rmSync(tmpPath, { force: true })
}
