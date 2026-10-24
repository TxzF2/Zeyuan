#!/usr/bin/env node
/** test-console-users.mjs · 用户表 / 角色 / bootstrap / 防自锁 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-users-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const u = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-console/dist/users.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${typeof actual === 'object' ? JSON.stringify(actual) : actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const checkTrue = (label, cond, detail = '') => {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log(`   细节：${detail}`)
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
  console.log('=== 1 · 身份解析与自动登记 ===')
  const r1 = u.resolveUser('bob')
  check('首次解析自动登记', r1.created, true)
  check('默认角色 trainee', r1.user.roles.join(','), 'trainee')
  check('未禁用', r1.user.disabled, false)
  const r2 = u.resolveUser('bob')
  check('再次解析不重复建', r2.created, false)
  check('用户数 1', u.listUsers().users.length, 1)

  console.log('\n=== 2 · 身份校验 ===')
  check('空身份 → E-1103', codeOf(() => u.resolveUser('')), 'E-1103')
  check('非法字符 → E-1103', codeOf(() => u.resolveUser('a b')), 'E-1103')
  check('超长 → E-1103', codeOf(() => u.resolveUser('x'.repeat(u.MAX_ID + 1))), 'E-1103')

  console.log('\n=== 3 · bootstrap ===')
  check('无 confirm → E-1103', codeOf(() => u.bootstrapAdmin('root', false)), 'E-1103')
  const admin = u.bootstrapAdmin('root', true)
  check('root 成为 admin', admin.roles.includes('admin'), true)
  check('adminCount=1', u.adminCount(), 1)
  check('二次 bootstrap → E-1101', codeOf(() => u.bootstrapAdmin('other', true)), 'E-1101')
  check('bootstrapAt 已记录', u.listUsers().bootstrapAt !== null, true)

  console.log('\n=== 4 · 角色管理 ===')
  u.setRole('bob', 'admin', true)
  check('bob 授予 admin', u.isAdmin('bob'), true)
  u.setRole('bob', 'admin', false)
  check('bob 撤销 admin', u.isAdmin('bob'), false)
  check('撤销不存在用户 → E-1104', codeOf(() => u.setRole('ghost', 'admin', true)), 'E-1104')
  check('撤销最后一个 admin → E-1107', codeOf(() => u.setRole('root', 'admin', false)), 'E-1107')
  check('非法角色 → E-1103', codeOf(() => u.setRole('bob', 'boss', true)), 'E-1103')

  console.log('\n=== 5 · 禁用与自锁保护 ===')
  check('禁用最后一个 admin → E-1107', codeOf(() => u.setDisabled('root', true)), 'E-1107')
  u.setRole('bob', 'admin', true)
  u.setDisabled('bob', true)
  check('禁用 bob 后 isAdmin=false', u.isAdmin('bob'), false)
  check('禁用身份再解析 → E-1108', codeOf(() => u.resolveUser('bob')), 'E-1108')
  u.setDisabled('bob', false)
  check('恢复后 isAdmin=true', u.isAdmin('bob'), true)

  console.log('\n=== 6 · 落盘 ===')
  const doc = u.readUsers()
  check('落盘用户数（bob + root）', doc.users.length, 2)
  check('schemaVersion', doc.schemaVersion, 1)
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
