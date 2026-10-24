#!/usr/bin/env node
/** test-console-boards.mjs · 板块开关 / 保护 / 默认值 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-boards-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const b = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/boards.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const checkTrue = (label, cond, detail) => {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log('   细节：' + detail)
}
const codeOf = (fn) => {
  try {
    fn()
    return 'NO_ERROR'
  } catch (err) {
    return err.code ?? err.message
  }
}

try {
  console.log('=== 1 · 默认开启 ===')
  check('未写文件时默认启用', b.isBoardEnabled('tasks'), true)
  check('未知板块默认启用', b.isBoardEnabled('whatever'), true)
  check('模块导出默认启用', b.isBoardEnabled('feature-community'), true)

  console.log('\n=== 2 · 开关 ===')
  b.toggleBoard('tasks', false)
  check('tasks 已停用', b.isBoardEnabled('tasks'), false)
  check('其它板块不受影响', b.isBoardEnabled('feature-workbench'), true)
  check('落盘 enabled.tasks=false', JSON.parse(readFileSync(b.boardsFile(), 'utf8')).enabled.tasks, false)
  b.toggleBoard('tasks', true)
  check('重新启用', b.isBoardEnabled('tasks'), true)

  console.log('\n=== 3 · 保护与校验 ===')
  check('停用 core → E-1106', codeOf(() => b.toggleBoard('core', false)), 'E-1106')
  check('停用 protocol → E-1106', codeOf(() => b.toggleBoard('dsh-training-protocol', false)), 'E-1106')
  check('未知板块 → E-1104', codeOf(() => b.toggleBoard('nope', false)), 'E-1104')
  check('core 仍启用', b.isBoardEnabled('core'), true)

  console.log('\n=== 4 · 状态视图 ===')
  const rows = b.boardStatus()
  check('板块数', rows.length, b.KNOWN_BOARDS.length)
  check('core 标记为受保护', rows.find((r) => r.id === 'core').protected, true)
  check('tasks 非受保护', rows.find((r) => r.id === 'tasks').protected, false)
  checkTrue('每个板块都有 enabled 布尔', rows.every((r) => typeof r.enabled === 'boolean'))
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
