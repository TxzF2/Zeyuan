/**
 * consume.ts · 消费工作台草稿发布事件 → 生成「帖子草稿」
 * ---------------------------------------------------------------------------
 * 产品口径：草稿发布后**不直接公开**，而是生成帖子草稿，作者在社区面板点「发布」才公开。
 * 这样作者有一次自检机会（泽元社区 ≠ 灌水论坛）。
 *
 * 内容来源：优先读同机 data/drafts.json 里对应草稿的标题/正文/标签（只读）。
 * 幂等：事件 id 去重（posts.json 的 consumed[]）+ sourceDraftId 去重。
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPost, makeId, postFromDraftEvent, type Post } from './post.js'
import { stateDir } from './license-gate.js'
import { markConsumed, updateDoc, type PostsDoc } from './store.js'

export const DRAFT_PUBLISHED = 'dsh-training:feature-workbench:draft-published'

export interface Envelope {
  v?: number
  id?: string
  at?: string
  type?: string
  payload?: Record<string, unknown>
  subject?: Record<string, unknown>
}

export interface ConsumeResult {
  created: boolean
  postId?: string
  reason?: string
}

interface WorkbenchDraft {
  id: string
  title?: string
  body?: string
  tags?: string[]
  owner?: string
}

/** 从工作台数据里取草稿内容（只读；取不到就退回占位） */
export function draftContent(draftId: string | null): WorkbenchDraft | null {
  if (!draftId) return null
  try {
    const file = join(stateDir(), 'data', 'drafts.json')
    if (!existsSync(file)) return null
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { drafts?: WorkbenchDraft[] }
    return (doc.drafts ?? []).find((d) => d.id === draftId) ?? null
  } catch {
    return null
  }
}

function draftIdOf(env: Envelope): string | null {
  const fromPayload = env.payload?.draftId
  const fromSubject = env.subject?.draftId
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload
  if (typeof fromSubject === 'string' && fromSubject) return fromSubject
  return null
}

export function consumeDraftPublished(envelope: Envelope, now: Date = new Date()): ConsumeResult {
  const eventId = typeof envelope.id === 'string' ? envelope.id : ''
  const draftId = draftIdOf(envelope)

  return updateDoc<ConsumeResult>((doc) => {
    if (eventId && doc.consumed.includes(eventId)) {
      return { doc, result: { created: false, reason: 'duplicate-event' } }
    }
    if (draftId && doc.posts.some((p) => p.sourceDraftId === draftId)) {
      return { doc: markConsumed(doc, eventId), result: { created: false, reason: 'duplicate-draft' } }
    }

    const built = postFromDraftEvent(envelope)
    const local = draftContent(draftId)
    const value = local
      ? {
          title: (local.title ?? built.value.title).slice(0, 120),
          body: local.body ?? '',
          tags: Array.isArray(local.tags) && local.tags.length ? local.tags : built.value.tags,
        }
      : built.value
    // 作者以工作台草稿的 owner 为准（事件里也可能带）
    const author = local?.owner ?? built.author

    const seq = doc.seq + 1
    const post: Post = createPost(value, makeId(now, seq), {
      author,
      sourceDraftId: built.sourceDraftId,
      sourceEventId: built.sourceEventId,
      status: 'draft', // 关键：生成的是帖子草稿，不是公开帖
      now,
    })
    const next: PostsDoc = markConsumed({ ...doc, seq, posts: [...doc.posts, post] }, eventId)
    return { doc: next, result: { created: true, postId: post.id } }
  }, now)
}

/** 启动补扫 / 手动补扫：只处理 draft-published */
export function replayLog(now: Date = new Date()): { scanned: number; created: number; posts: string[] } {
  const file = join(stateDir(), 'event-log.jsonl')
  if (!existsSync(file)) return { scanned: 0, created: 0, posts: [] }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  let scanned = 0
  let created = 0
  const posts: string[] = []
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Envelope
      if (ev.type !== DRAFT_PUBLISHED) continue
      scanned++
      const r = consumeDraftPublished(ev, now)
      if (r.created) {
        created++
        if (r.postId) posts.push(r.postId)
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  return { scanned, created, posts }
}
