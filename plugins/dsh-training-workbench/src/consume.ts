/**
 * consume.ts · 消费任务验收事件 → 自动建草稿
 * ---------------------------------------------------------------------------
 * 两条路径：
 *   1. 进程内总线：ctx.on('dsh-training:tasks:task-accepted', consumeAccepted)
 *   2. 启动补扫：读 event-log.jsonl，把工作台未加载期间漏掉的事件补消费
 *
 * 幂等：事件 id 去重（drafts.json 的 consumed[]）+ sourceTaskId 去重（同任务只建一份）
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDraft, draftFromTaskEvent, makeId } from './draft.js'
import { stateDir } from './license-gate.js'
import { markConsumed, updateDoc } from './store.js'

export const TASK_ACCEPTED = 'dsh-training:tasks:task-accepted'

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
  draftId?: string
  reason?: string
}

function taskIdOf(env: Envelope): string | null {
  const fromPayload = env.payload?.taskId
  const fromSubject = env.subject?.taskId
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload
  if (typeof fromSubject === 'string' && fromSubject) return fromSubject
  return null
}

/** 消费一条事件（同步、幂等） */
export function consumeAccepted(envelope: Envelope, now: Date = new Date()): ConsumeResult {
  const eventId = typeof envelope.id === 'string' ? envelope.id : ''
  const taskId = taskIdOf(envelope)

  return updateDoc<ConsumeResult>((doc) => {
    if (eventId && doc.consumed.includes(eventId)) {
      return { doc, result: { created: false, reason: 'duplicate-event' } }
    }
    if (taskId && doc.drafts.some((d) => d.sourceTaskId === taskId)) {
      return { doc: markConsumed(doc, eventId), result: { created: false, reason: 'duplicate-task' } }
    }

    const built = draftFromTaskEvent(envelope, '', now)
    const seq = doc.seq + 1
    const draft = createDraft(
      { ...built.value, tags: [...built.value.tags] },
      makeId(now, seq),
      { owner: built.owner, sourceTaskId: built.sourceTaskId, sourceEventId: built.sourceEventId, now },
    )
    const next = markConsumed({ ...doc, seq, drafts: [...doc.drafts, draft] }, eventId)
    return { doc: next, result: { created: true, draftId: draft.id } }
  }, now)
}

/** 启动补扫：只处理 task-accepted，坏行跳过 */
export function replayLog(now: Date = new Date()): { scanned: number; created: number; drafts: string[] } {
  const file = join(stateDir(), 'event-log.jsonl')
  if (!existsSync(file)) return { scanned: 0, created: 0, drafts: [] }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  let scanned = 0
  let created = 0
  const drafts: string[] = []
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Envelope
      if (ev.type !== TASK_ACCEPTED) continue
      scanned++
      const r = consumeAccepted(ev, now)
      if (r.created) {
        created++
        if (r.draftId) drafts.push(r.draftId)
      }
    } catch {
      /* 坏行跳过，不影响其它事件 */
    }
  }
  return { scanned, created, drafts }
}
