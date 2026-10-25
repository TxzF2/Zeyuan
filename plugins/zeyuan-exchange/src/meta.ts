/**
 * meta.ts · 元数据与提交点（P0）
 * ---------------------------------------------------------------------------
 * 核心原则：**meta 是提交点，bin 是 payload**
 *   读路径只认 meta；
 *   bin 在、meta 不在 → 孤儿（不可见，后续 sweep 清）
 *   meta 在、bin 不在 → 数据损坏（拒绝访问并留错误）
 *
 * meta 落盘：写 <id>.meta.json.tmp → fsync → rename（原子，一出现即对外可见）
 * 保留期：TODO(总控裁决)，字段先保留，不作为删除依据（P0 不清理）
 * ---------------------------------------------------------------------------
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { binExists, ensureDir, isValidId, metaPath, tmpMetaPath } from './storage.js'

export interface FileMeta {
  id: string
  name: string // 原名，仅展示；路径永不使用
  size: number
  sha256: string
  mime: string
  uploader: string // NodeId（x-dsh-user），不含真人信息
  createdAt: string // ISO
  expiresAt: string // ISO；保留期策略 TODO(总控裁决)
}

export const NAME_MAX = 255

/** 接口层校验：中文名保留 UTF-8，长度按字符数 ≤255 */
export function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw Object.assign(new Error('文件名不能为空'), { status: 400, code: 'E-1503' })
  if ([...name].length > NAME_MAX) throw Object.assign(new Error(`文件名不能超过 ${NAME_MAX} 字符`), { status: 400, code: 'E-1503' })
  return name
}

/** meta 原子写：tmp → fsync → rename */
export function writeMeta(meta: FileMeta): void {
  ensureDir()
  const tmp = tmpMetaPath(meta.id)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(meta, null, 2) + '\n', null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, metaPath(meta.id))
}

export function readMeta(id: string): FileMeta | null {
  if (!isValidId(id) || !existsSync(metaPath(id))) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath(id), 'utf8')) as FileMeta
    if (!meta || meta.id !== id) return null
    return meta
  } catch {
    return null
  }
}

export function removeMeta(id: string): void {
  rmSync(metaPath(id), { force: true })
}

/** 读路径三态：ok / missing-bin（损坏）/ missing-meta（孤儿） */
export type MetaState = 'ok' | 'missing-bin' | 'missing-meta'

export function stateOf(id: string): MetaState {
  const hasMeta = existsSync(metaPath(id))
  const hasBin = binExists(id)
  if (hasMeta && hasBin) return 'ok'
  if (hasMeta && !hasBin) return 'missing-bin'
  return 'missing-meta'
}

/** 孤儿判定（bin 在、meta 不在）：供后续 sweep 使用，P0 只提供判定 */
export function isOrphan(id: string): boolean {
  return !existsSync(metaPath(id)) && binExists(id)
}
