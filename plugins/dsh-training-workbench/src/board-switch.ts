/**
 * board-switch.ts · 读取控制面板的板块开关（config/boards.json）
 * 语义：disabled 时插件只打日志、不注册路由/不订阅事件（文件不动）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'

export function isBoardEnabled(id: string): boolean {
  try {
    const file = join(stateDir(), 'config', 'boards.json')
    if (!existsSync(file)) return true
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: Record<string, boolean> }
    return doc?.enabled?.[id] !== false
  } catch {
    return true
  }
}