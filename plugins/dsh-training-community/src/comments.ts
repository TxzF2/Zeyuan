/**
 * comments.ts · 一级评论（社区帖子下）
 * ---------------------------------------------------------------------------
 * 文件：data/comments.json（withLock + 原子写，即"统一写事务"）
 * 状态：visible | hidden | deleted（软删，保留记录供审计复盘）
 *
 * 权限：
 *   发评论   需 LV1
 *   删除     仅作者（软删）
 *   隐藏     需 P6+（读 data/admins.json 的档位）
 *   可见性   visible 所有人；hidden 作者 + P6+；deleted 不出现在列表（记录保留）
 *
 * 错误码：E-1401 字段非法/超限、E-1402 无权限、E-1403 不存在或不可见
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'
import { readJson, withLock, writeJsonAtomic } from './store.js'

export type CommentStatus = 'visible' | 'hidden' | 'deleted'

export interface Comment {
  id: string
  postId: string
  author: string
  body: string
  status: CommentStatus
  createdAt: string
  hiddenAt: string | null
  hiddenBy: string | null
  deletedAt: string | null
}

export interface CommentsDoc {
  schemaVersion: number
  seq: number
  comments: Comment[]
}

export const LIMITS = { body: 500, perPost: 200 } as const
export const COMMENTS_FILE = 'comments.json'

export class CommentError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CommentError'
  }
}

export function commentsPath(): string {
  return join(stateDir(), 'data', COMMENTS_FILE)
}

export function readComments(): CommentsDoc {
  const doc = readJson<CommentsDoc>(commentsPath(), { schemaVersion: 1, seq: 0, comments: [] })
  return {
    schemaVersion: 1,
    seq: Number.isInteger(doc.seq) ? doc.seq : 0,
    comments: Array.isArray(doc.comments) ? doc.comments : [],
  }
}

export function writeComments(doc: CommentsDoc): void {
  writeJsonAtomic(commentsPath(), doc)
}

/** P6+ 判定：读控制台档位表（跨插件只读） */
export function tierOf(userId: string): number {
  try {
    const file = join(stateDir(), 'data', 'admins.json')
    if (!existsSync(file)) return 0
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { admins?: { userId: string; tier: number }[] }
    return doc.admins?.find((a) => a.userId === userId)?.tier ?? 0
  } catch {
    return 0
  }
}

export function isModerator(userId: string): boolean {
  return tierOf(userId) >= 6
}

export function validateBody(body: unknown): string {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) throw new CommentError('E-1401', '评论不能为空。')
  if (text.length > LIMITS.body) throw new CommentError('E-1401', `评论不能超过 ${LIMITS.body} 字。`)
  return text
}

export function makeId(now: Date, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `c-${y}${m}${d}-${String(seq).padStart(4, '0')}`
}

/** 可见性：deleted 一律不列出（记录保留）；hidden 仅作者与 P6+ */
export function canSeeComment(comment: Comment, actor: string, moderator: boolean): boolean {
  if (comment.status === 'deleted') return false
  if (comment.status === 'visible') return true
  return comment.author === actor || moderator
}

export function addComment(postId: string, author: string, body: unknown, now: Date = new Date()): Comment {
  const text = validateBody(body)
  return withLock(() => {
    const doc = readComments()
    const count = doc.comments.filter((c) => c.postId === postId && c.status !== 'deleted').length
    if (count >= LIMITS.perPost) throw new CommentError('E-1401', `单帖评论已达上限（${LIMITS.perPost} 条）。`)
    const seq = doc.seq + 1
    const comment: Comment = {
      id: makeId(now, seq),
      postId,
      author,
      body: text,
      status: 'visible',
      createdAt: now.toISOString(),
      hiddenAt: null,
      hiddenBy: null,
      deletedAt: null,
    }
    writeComments({ ...doc, seq, comments: [...doc.comments, comment] })
    return comment
  })
}

export function listComments(postId: string, actor: string): { comments: Comment[]; moderator: boolean } {
  const moderator = isModerator(actor)
  const rows = readComments()
    .comments.filter((c) => c.postId === postId)
    .filter((c) => canSeeComment(c, actor, moderator))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return { comments: rows, moderator }
}

export function deleteComment(id: string, actor: string, now: Date = new Date()): Comment {
  return withLock(() => {
    const doc = readComments()
    const row = doc.comments.find((c) => c.id === id)
    if (!row || row.status === 'deleted') throw new CommentError('E-1403', '评论不存在。')
    if (row.author !== actor) throw new CommentError('E-1402', '只能删除自己的评论。')
    const next: Comment = { ...row, status: 'deleted', deletedAt: now.toISOString() }
    writeComments({ ...doc, comments: doc.comments.map((c) => (c.id === id ? next : c)) })
    return next
  })
}

export function hideComment(id: string, actor: string, hidden: boolean, now: Date = new Date()): Comment {
  if (!isModerator(actor)) throw new CommentError('E-1402', '需要 P6 及以上管理档位。')
  return withLock(() => {
    const doc = readComments()
    const row = doc.comments.find((c) => c.id === id)
    if (!row || row.status === 'deleted') throw new CommentError('E-1403', '评论不存在。')
    const next: Comment = {
      ...row,
      status: hidden ? 'hidden' : 'visible',
      hiddenAt: hidden ? now.toISOString() : null,
      hiddenBy: hidden ? actor : null,
    }
    writeComments({ ...doc, comments: doc.comments.map((c) => (c.id === id ? next : c)) })
    return next
  })
}
