/**
 * events.ts · 事件钩子（P0）
 * ---------------------------------------------------------------------------
 * 不发明新规范：命名沿用已注册的 zeyuan:exchange:file-*
 * **TODO(总控裁决)**：payload 字段与命名是否对齐平台总线规范，待裁决后再固化。
 *
 * 测试可注入 sink（setEventSink）以捕获事件，不必读文件。
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'
import type { FileMeta } from './meta.js'

/**
 * 事件名命名由来（总控裁决 2026-10-25，**保留现命名不改**）：
 *   orphan-swept 表示“孤儿 bin 已被清扫”的**完成态**，与 expired/deleted 同为过去分词；
 *   历史事件日志里已存在该名字，改名会割裂检索，故冻结。
 */
export type FileEventName = 'uploaded' | 'downloaded' | 'deleted' | 'expired' | 'orphan-swept'

export type EventSink = (name: FileEventName, meta: FileMeta, by?: string) => void | Promise<void>

function jsonlSink(name: FileEventName, meta: FileMeta, by?: string): void {
  // TODO(总控裁决): 对齐平台事件总线命名与 payload 规范
  const at = new Date().toISOString()
  const envelope = {
    event: `zeyuan:exchange:file-${name}`,
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: at,
    actor: by ?? null,
    payload: { id: meta.id, size: meta.size, uploader: meta.uploader, by: by ?? null, at },
  }
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(join(stateDir(), 'event-log.jsonl'), JSON.stringify(envelope) + '\n', 'utf8')
  } catch (err) {
    console.warn(`[exchange] 写事件日志失败：${(err as Error).message}`)
  }
  console.log(`[exchange] event ${envelope.event} ${meta.id}`)
}

let sink: EventSink = jsonlSink

export function setEventSink(fn: EventSink): void {
  sink = fn
}

export function resetEventSink(): void {
  sink = jsonlSink
}

export async function emitFileEvent(name: FileEventName, meta: FileMeta, by?: string): Promise<void> {
  await sink(name, meta, by)
}
