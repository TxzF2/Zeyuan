#!/usr/bin/env node
/** test-console-admins.mjs · 管理档位 P6/P7/P8 + 防自锁 + 迁移 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-admins-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const a = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/admins.js')).href)

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
  console.log('=== 1 · 档位基础 ===')
  check('初始无档位', a.tierOf('root'), 0)
  const row = a.grantTier('root', 8, 'root', 8, 'bootstrap')
  check('授予 P8', row.tier, 8)
  check('tierOf 生效', a.tierOf('root'), 8)
  check('P8 计数 1', a.listAdmins().p8, 1)

  console.log('\n=== 2 · 授权门槛 ===')
  check('P6 无法授予档位', codeOf(() => a.grantTier('p6', 6, 'x', 6, 'n')), 'E-1202')
  check('P7 不能授予 P8', codeOf(() => a.grantTier('p7', 7, 'x', 8, 'n')), 'E-1202')
  a.grantTier('root', 8, 'p7', 7, 'ok')
  check('P7 授予成功', a.tierOf('p7'), 7)
  a.grantTier('root', 8, 'p6', 6, 'ok')
  check('P6 授予成功', a.tierOf('p6'), 6)

  console.log('\n=== 3 · 防自锁与越级 ===')
  check('撤销最后一名 P8 → E-1215', codeOf(() => a.revokeTier('root', 8, 'root')), 'E-1215')
  check('降级最后一名 P8 也拦（经 revoke）', codeOf(() => a.revokeTier('p7', 7, 'root')), 'E-1215')
  a.grantTier('root', 8, 'root2', 8, 'second')
  check('两名 P8', a.listAdmins().p8, 2)
  check('P7 不能撤 P8', codeOf(() => a.revokeTier('p7', 7, 'root2')), 'E-1202')
  check('P8 可撤另一名 P8', Boolean(a.revokeTier('root', 8, 'root2')), true)
  check('撤销后剩 1 名 P8', a.listAdmins().p8, 1)

  console.log('\n=== 4 · 非法输入 ===')
  check('空目标 → E-1203', codeOf(() => a.grantTier('root', 8, '', 8, 'n')), 'E-1203')
  check('非法档位 → E-1203', codeOf(() => a.grantTier('root', 8, 'x', 5, 'n')), 'E-1203')

  console.log('\n=== 5 · 迁移幂等 ===')
  const migrated = a.migrateLegacyAdmins(['legacy-1', 'legacy-2'])
  check('迁入 2 名', migrated, 2)
  check('再迁移不重复', a.migrateLegacyAdmins(['legacy-1']), 0)
  check('legacy 档位为 P8', a.tierOf('legacy-1'), 8)
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
