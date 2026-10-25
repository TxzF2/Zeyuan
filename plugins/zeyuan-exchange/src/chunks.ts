/**
 * chunks.ts · 分片上传与断点续传（P0.5）
 * ---------------------------------------------------------------------------
 * 目录：data/exchange/uploads/<uploadId>/
 *   state.json    上传状态（chunks 已收块：index/size/sha256）
 *   <index>.part  分片数据（同目录 tmp → rename 原子落盘）
 *
 * 口径（用户确认）：
 *   分块 8MB（DSH_EXCHANGE_CHUNK 可配）
 *   未完成上传保留 24h，超时 sweep 清理（定时器留到清理小步，此处提供启动/miss 时调用）
 *
 * 幂等：同一 index 重传直接覆盖（写后校验哈希），不会产生第二份；
 * complete 幂等：已完成的上传再次 complete 返回同一 fileId。
 * ---------------------------------------------------------------------------
 */

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'
import { binPath, newId, tmpBinPath } from './storage.js'

export const CHUNK_SIZE = Number(process.env.DSH_EXCHANGE_CHUNK ?? 8 * 1024 * 1024)
export const PENDING_TTL_MS = 24 * 3600 * 1000
export const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ChunkRecord {
  index: number
  size: number
  sha256: string
}

export interface UploadState {
  uploadId: string
  name: string
  mime: string
  size: number
  chunkSize: number
  uploader: string
  createdAt: string
  updatedAt: string
  status: 'uploading' | 'completed'
  fileId: string | null
  chunks: ChunkRecord[]
}

export const uploadsDir = (): string => join(stateDir(), 'data', 'exchange', 'uploads')
export const uploadDir = (uploadId: string): string => join(uploadsDir(), uploadId)
export const statePath = (uploadId: string): string => join(uploadDir(uploadId), 'state.json')
export const partPath = (uploadId: string, index: number): string => join(uploadDir(uploadId), `${index}.part`)

export function isValidUploadId(id: string): boolean {
  return UPLOAD_ID_RE.test(id)
}

export function readState(uploadId: string): UploadState | null {
  if (!isValidUploadId(uploadId)) return null
  const file = statePath(uploadId)
  if (!existsSync(file)) return null
  try {
    const st = JSON.parse(readFileSync(file, 'utf8')) as UploadState
    if (!st || st.uploadId !== uploadId) return null
    st.chunks = Array.isArray(st.chunks) ? st.chunks : []
    return st
  } catch {
    return null
  }
}

export function writeState(st: UploadState): void {
  mkdirSync(uploadDir(st.uploadId), { recursive: true })
  const tmp = `${statePath(st.uploadId)}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(st, null, 2) + '\n', null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, statePath(st.uploadId))
}

export function newUploadState(input: { name: string; size: number; mime: string; uploader: string }): UploadState {
  const now = new Date().toISOString()
  return {
    uploadId: randomUUID(),
    name: input.name,
    mime: input.mime,
    size: input.size,
    chunkSize: CHUNK_SIZE,
    uploader: input.uploader,
    createdAt: now,
    updatedAt: now,
    status: 'uploading',
    fileId: null,
    chunks: [],
  }
}

export function totalChunks(size: number, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize))
}

/** 落一片：写 tmp → fsync → rename；同 index 覆盖（幂等） */
export function saveChunk(uploadId: string, index: number, data: Buffer): ChunkRecord {
  mkdirSync(uploadDir(uploadId), { recursive: true })
  const target = partPath(uploadId, index)
  const tmp = `${target}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
  return { index, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
}

/** 合并分片 → 临时 bin，边写边算整文件 sha256 */
export function assemble(uploadId: string, state: UploadState): { tmpPath: string; size: number; sha256: string } {
  const sorted = [...state.chunks].sort((a, b) => a.index - b.index)
  const tmpId = newId()
  const tmpPath = tmpBinPath(tmpId)
  const hash = createHash('sha256')
  let size = 0
  const fd = openSync(tmpPath, 'w')
  try {
    for (const rec of sorted) {
      const p = partPath(uploadId, rec.index)
      if (!existsSync(p)) throw Object.assign(new Error(`分片 ${rec.index} 缺失`), { status: 409, code: 'E-1510' })
      const buf = readFileSync(p)
      hash.update(buf)
      writeSync(fd, buf)
      size += buf.length
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return { tmpPath, size, sha256: hash.digest('hex') }
}

export function removeUpload(uploadId: string): void {
  rmSync(uploadDir(uploadId), { recursive: true, force: true })
}

/** 清理超过 TTL 的未完成上传（启动时与 init 时调用；定时器留到清理小步） */
export function sweepStale(now: number = Date.now(), ttlMs: number = PENDING_TTL_MS): number {
  const dir = uploadsDir()
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!isValidUploadId(name)) continue
    const st = readState(name)
    const dirStat = (() => {
      try {
        return statSync(uploadDir(name))
      } catch {
        return null
      }
    })()
    const created = st ? Date.parse(st.createdAt) : dirStat ? dirStat.mtimeMs : now
    const expired = now - created > ttlMs
    const done = st?.status === 'completed'
    if (expired || done) {
      removeUpload(name)
      removed++
    }
  }
  return removed
}
