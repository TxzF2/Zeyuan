#!/usr/bin/env node
/** test-console-wallet.mjs · 最小钱包（入账/发币/对账/脏数据） */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-console-wallet-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const w = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/wallet.js')).href)

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
  console.log('=== 1 · 初始 ===')
  check('余额 0', w.balanceOf('bob'), 0)
  check('对账通过', w.reconcile().ok, true)

  console.log('\n=== 2 · 赏金入账（幂等）===')
  const r1 = w.ingestReward('ev-1', 'bob', 30)
  check('首次入账', r1.credited, true)
  check('余额 30', r1.balance, 30)
  const r2 = w.ingestReward('ev-1', 'bob', 30)
  check('重复事件不入账', r2.credited, false)
  check('重复原因', r2.reason, 'duplicate')
  check('余额仍 30', w.balanceOf('bob'), 30)
  check('非法金额不入账', w.ingestReward('ev-2', 'bob', 0).credited, false)
  check('无用户不入账', w.ingestReward('ev-3', '', 10).credited, false)

  console.log('\n=== 3 · 管理员发币 ===')
  check('P7 不能发币', codeOf(() => w.grantCoins('p7', 7, 'bob', 10, 'test')), 'E-1202')
  const g = w.grantCoins('root', 8, 'carol', 50, '新人奖励')
  check('P8 发币成功', g.balance, 50)
  check('金额非法被拒', codeOf(() => w.grantCoins('root', 8, 'carol', -5, 'x')), 'E-1203')
  check('超上限被拒', codeOf(() => w.grantCoins('root', 8, 'carol', w.MAX_GRANT + 1, 'x')), 'E-1203')

  console.log('\n=== 4 · 流水与统计 ===')
  const ledger = w.listLedger(10)
  check('流水条数', ledger.length, 2)
  check('最新在前', ledger[0].userId, 'carol')
  check('bob 流水 1 条', w.listLedger(10, 'bob').length, 1)
  const today = w.todayStats()
  check('今日合计 80', today.coins, 80)
  check('今日笔数 2', today.count, 2)
  check('其中发币 50', today.granted, 50)

  console.log('\n=== 5 · 对账 ===')
  check('账目平衡', w.reconcile().ok, true)

  // 造脏数据：直接改 balances，制造不平
  const doc = w.readWallet()
  doc.balances.bob = 999
  w.writeWallet(doc)
  const bad = w.reconcile()
  check('脏数据能被发现', bad.ok, false)
  check('给出不平用户', bad.mismatches.some((m) => m.startsWith('bob')), true)
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
