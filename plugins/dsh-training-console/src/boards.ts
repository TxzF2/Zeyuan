/**
 * boards.ts · 板块启停（运行期开关）
 * ---------------------------------------------------------------------------
 * 文件：%LOCALAPPDATA%\dsh-training\config\boards.json
 * 语义：只影响运行期（是否注册路由/订阅事件），不动磁盘文件。
 * 保护：core / protocol 硬编码不可停用（E-1106），防止把自己锁死。
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './users.js'

export interface BoardsDoc {
  schemaVersion: number
  updatedAt: string
  enabled: Record<string, boolean>
}

/** 已知板块（控制面板展示与开关都基于这份白名单） */
export const KNOWN_BOARDS = [
  'core',
  'tasks',
  'feature-workbench',
  'feature-community',
  'feature-console',
  'feature-collab',
  'character-txzf',
  'character-changzhengji',
  'theme-xingchen',
] as const

/** 不可停用（防自锁） */
export const PROTECTED = ['core', 'dsh-training-protocol'] as const

export const boardsFile = (): string => join(configDir(), 'boards.json')

export class BoardsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'BoardsError'
  }
}

export function emptyBoards(now: Date = new Date()): BoardsDoc {
  return { schemaVersion: 1, updatedAt: now.toISOString(), enabled: {} }
}

export function readBoards(): BoardsDoc {
  const file = boardsFile()
  if (!existsSync(file)) return emptyBoards()
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as BoardsDoc
    if (!doc || typeof doc !== 'object') throw new Error('格式非法')
    return {
      schemaVersion: 1,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
      enabled: doc.enabled && typeof doc.enabled === 'object' ? doc.enabled : {},
    }
  } catch (err) {
    throw new BoardsError('E-1110', `板块开关文件损坏：${(err as Error).message}`)
  }
}

function writeBoards(doc: BoardsDoc, now: Date = new Date()): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(boardsFile(), JSON.stringify({ ...doc, updatedAt: now.toISOString() }, null, 2) + '\n', 'utf8')
}

/** 默认启用；未记录的板块视为启用 */
export function isBoardEnabled(id: string): boolean {
  try {
    return readBoards().enabled[id] !== false
  } catch {
    return true
  }
}

export function toggleBoard(id: string, enabled: boolean, now: Date = new Date()): BoardsDoc {
  // 保护检查必须在"已知板块"之前：protocol 不在 KNOWN_BOARDS 里，但也要报 E-1106
  if (!enabled && PROTECTED.includes(id as (typeof PROTECTED)[number])) {
    throw new BoardsError('E-1106', `板块 ${id} 不可停用（保护核心，避免自锁）。`)
  }
  if (!KNOWN_BOARDS.includes(id as (typeof KNOWN_BOARDS)[number])) {
    throw new BoardsError('E-1104', `未知板块：${id}`)
  }
  const doc = readBoards()
  const next: BoardsDoc = { ...doc, enabled: { ...doc.enabled, [id]: Boolean(enabled) } }
  writeBoards(next, now)
  return next
}

export function boardStatus(): { id: string; enabled: boolean; protected: boolean }[] {
  const doc = readBoards()
  return KNOWN_BOARDS.map((id) => ({
    id,
    enabled: doc.enabled[id] !== false,
    protected: PROTECTED.includes(id as (typeof PROTECTED)[number]),
  }))
}
