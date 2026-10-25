/**
 * sweep.ts · 清理与过期（exchange P0.6）
 * ---------------------------------------------------------------------------
 * 启动扫描 + 每小时定时器（apply 内注册），清理三类：
 *   1) 未完成上传 > 24h（复用 chunks.sweepStale）
 *   2) 已完成文件 > retentionDays（默认 30，**TODO(总控裁决)**，可用 config 覆盖）
 *   3) 孤儿 bin（bin 在、meta 不在）→ 删除并记 orphan-swept
 *
 * 配置：data/exchange/config.json
 *   { "retentionDays": 30, "maxUploadBytes": 52428800 }
 *   优先级 env > config > 默认
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { stateDir } from './license-gate.js'
import { binPath, exchangeDir, isValidId, metaPath, sizeOf } from './storage.js'
import { readMeta, removeMeta, type FileMeta } from './meta.js'
import { sweepStale } from './chunks.js'
import { emitFileEvent } from './events.js'

export const DEFAULT_RETENTION_DAYS = 30
export const SWEEP_INTERVAL_MS = 3600 * 1000

/** 保留期：TODO(总控裁决) 默认 30；env > config > 默认 */
export function retentionDays(): number {
  const env = Number(process.env.DSH_EXCHANGE_RETENTION_DAYS)
  if (Number.isFinite(env) && env >= 0) return env
  try {
    const cfg = JSON.parse(readFileSync(join(exchangeDir(), 'config.json'), 'utf8')) as { retentionDays?: number }
    if (Number.isFinite(cfg.retentionDays) && (cfg.retentionDays as number) >= 0) return cfg.retentionDays as number
  } catch {
    /* 无配置用默认 */
  }
  return DEFAULT_RETENTION_DAYS
}

/** P6+ 判定（读控制台档位表；跨插件只读） */
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

export interface SweepResult {
  uploadsExpired: number
  filesExpired: number
  orphans: number
  errors: string[]
}

function orphanMeta(id: string): FileMeta {
  const now = new Date().toISOString()
  return { id, name: '<orphan>', size: sizeOf(id), sha256: '', mime: '', uploader: '', createdAt: now, expiresAt: now }
}

/** 立即扫描一次（启动时、定时器、以及维护接口调用） */
export function sweepNow(now: number = Date.now()): SweepResult {
  const result: SweepResult = { uploadsExpired: 0, filesExpired: 0, orphans: 0, errors: [] }

  // 1) 未完成上传 > 24h
  try {
    result.uploadsExpired = sweepStale(now)
  } catch (err) {
    result.errors.push(`uploads: ${(err as Error).message}`)
  }

  const dir = exchangeDir()
  if (!existsSync(dir)) return result

  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    result.errors.push(`readdir: ${(err as Error).message}`)
    return result
  }

  for (const name of names) {
    // 2) 过期文件
    if (name.endsWith('.meta.json')) {
      const id = name.replace(/\.meta\.json$/, '')
      if (!isValidId(id)) continue
      const meta = readMeta(id)
      if (!meta) {
        // meta 损坏：按孤儿处理不了（bin 可能还在），记错误不静默
        result.errors.push(`meta 损坏：${id}`)
        continue
      }
      if (Date.parse(meta.expiresAt) <= now) {
        removeMeta(id) // 先删 meta：立刻不可见
        rmSync(binPath(id), { force: true })
        result.filesExpired++
        void emitFileEvent('expired', meta)
        continue
      }
    }

    // 3) 孤儿 bin（没有对应 meta）
    if (name.endsWith('.bin')) {
      const id = name.replace(/\.bin$/, '')
      if (!isValidId(id)) continue
      if (!existsSync(metaPath(id))) {
        rmSync(binPath(id), { force: true })
        result.orphans++
        void emitFileEvent('orphan-swept', orphanMeta(id))
      }
    }
  }

  return result
}

/** 启动扫描 + 每小时定时器；返回 disposer（由 ctx.effect 托管） */
export function startSweeper(ctx: Context, intervalMs: number = SWEEP_INTERVAL_MS): () => void {
  const tick = () => {
    try {
      const r = sweepNow()
      if (r.uploadsExpired || r.filesExpired || r.orphans) {
        console.log(`[exchange] sweep：上传 ${r.uploadsExpired} / 文件 ${r.filesExpired} / 孤儿 ${r.orphans}`)
      }
      if (r.errors.length) console.warn(`[exchange] sweep 错误：${r.errors.join('；')}`)
    } catch (err) {
      console.warn(`[exchange] sweep 失败：${(err as Error).message}`)
    }
  }
  ctx.effect(() => {
    tick()
    const timer = setInterval(tick, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-training-exchange: sweeper')
  return tick
}
