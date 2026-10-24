#!/usr/bin/env node
/** test-console-audit.mjs · 审计日志 + 高危二次确认 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-audit-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const a = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/audit.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${typeof actual === 'object' ? JSON.stringify(actual) : actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const codeOf = (fn) => {
  try {
    fn()
    return 'NO_ERROR'
  } catch (err) {
    return err.code ?? err.message
  }
}

const base = { actor: 'root', businessLevel: 'LV1', adminTier: 8 }

try {
  console.log('=== 1 · 二次确认校验 ===')
  check('缺 confirm → E-1203', codeOf(() => a.requireConfirm({})), 'E-1203')
  check('confirm 非 true → E-1203', codeOf(() => a.requireConfirm({ confirm: 'yes', reason: '测试' })), 'E-1203')
  check('缺 reason → E-1203', codeOf(() => a.requireConfirm({ confirm: true })), 'E-1203')
  check('reason 太短 → E-1203', codeOf(() => a.requireConfirm({ confirm: true, reason: '短' })), 'E-1203')
  check('合法通过', a.requireConfirm({ confirm: true, reason: '维护窗口' }), '维护窗口')
  check('原因超长会被截断', a.requireConfirm({ confirm: true, reason: 'x'.repeat(300) }).length, a.MAX_REASON)

  console.log('\n=== 2 · 写入审计 ===')
  const okRow = a.writeAudit({ ...base, action: 'board-toggle', target: 'tasks', before: { enabled: true }, after: { enabled: false }, reason: '维护' })
  check('成功行 result=ok', okRow.result, 'ok')
  check('记录 actorTier', okRow.adminTier, 8)
  check('记录 businessLevel', okRow.businessLevel, 'LV1')
  const errRow = a.writeAudit({ ...base, action: 'board-toggle', target: 'core', result: 'error', reason: '尝试', error: 'E-1106 受保护' })
  check('失败行 result=error', errRow.result, 'error')
  check('失败行带 error', errRow.error.includes('E-1106'), true)

  console.log('\n=== 3 · 查询 ===')
  const all = a.listAudit(10)
  check('总数 2', all.total, 2)
  check('倒序（最新在前）', all.rows[0].action, 'board-toggle')
  const filtered = a.listAudit(10, 'board-toggle')
  check('按 action 过滤', filtered.total, 2)
  check('limit 生效', a.listAudit(1).rows.length, 1)

  console.log('\n=== 4 · 字段完整性 ===')
  const row = all.rows[0]
  for (const field of ['at', 'actor', 'businessLevel', 'adminTier', 'action', 'target', 'before', 'after', 'result', 'reason', 'error']) {
    check(`字段 ${field} 存在`, field in row, true)
  }
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
