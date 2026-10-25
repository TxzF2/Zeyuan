#!/usr/bin/env node
/** test-console-scopes.mjs · scope 下发（P7 发 review / P8 发 admin） */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-scopes-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const s = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/scopes.js')).href)

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

try {
  console.log('=== 1 · 初始状态 ===')
  check('无 scope', s.scopesOf('bob').length, 0)

  console.log('\n=== 2 · 权限门槛 ===')
  check('P6 不能发 review', codeOf(() => s.grantScope('p6', 6, 'bob', 'training:review')), 'E-1202')
  check('P7 不能发 admin', codeOf(() => s.grantScope('p7', 7, 'bob', 'training:admin')), 'E-1202')
  check('P7 可发 review', codeOf(() => s.grantScope('p7', 7, 'bob', 'training:review')), 'NO_ERROR')
  check('P8 可发 admin', codeOf(() => s.grantScope('root', 8, 'bob', 'training:admin')), 'NO_ERROR')

  console.log('\n=== 3 · 授予与去重 ===')
  check('bob 有两个 scope', s.scopesOf('bob').length, 2)
  s.grantScope('root', 8, 'bob', 'training:admin')
  check('重复授予不重复', s.scopesOf('bob').length, 2)
  check('记录 updatedBy', s.listScopes().find((r) => r.userId === 'bob').updatedBy, 'root')

  console.log('\n=== 4 · 撤销 ===')
  s.revokeScope('root', 8, 'bob', 'training:admin')
  check('撤销后剩 1 个', s.scopesOf('bob').length, 1)
  check('撤销不存在的用户返回 null', s.revokeScope('root', 8, 'ghost', 'training:review'), null)
  check('P6 不能撤销', codeOf(() => s.revokeScope('p6', 6, 'bob', 'training:review')), 'E-1202')

  console.log('\n=== 5 · 校验 ===')
  check('未知 scope → E-1203', codeOf(() => s.grantScope('root', 8, 'bob', 'training:root')), 'E-1203')
  check('空用户 → E-1203', codeOf(() => s.grantScope('root', 8, '', 'training:review')), 'E-1203')
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
