#!/usr/bin/env node
/**
 * test-tasks-license.mjs · 闸门对等测试
 * ---------------------------------------------------------------------------
 * 任务插件的 license-gate 与协议插件的 license 是两份实现（避免运行期跨包依赖），
 * 这里逐用例比对判定结果与错误码，防止两处语义漂移。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATE = mkdtempSync(join(tmpdir(), 'dsh-tasks-license-'))
process.env.DSH_TRAINING_STATE_DIR = STATE

const protocol = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-protocol/dist/license.js')).href)
const gate = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-tasks/dist/license-gate.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}

const NOW = new Date('2026-10-24T12:00:00.000Z')
const KEY = 'a'.repeat(64)

function makeLicense(over = {}) {
  const base = {
    version: 1,
    subject: '对等测试',
    scopes: ['training:playground'],
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 86400_000).toISOString(),
    signature: '',
  }
  const license = { ...base, ...over }
  license.signature = protocol.signLicense(license, KEY)
  return license
}

/** 同一份输入，分别用两份实现判定，比较 ok 与 code */
function compare(name, license, keyHex, expectCode) {
  const a = protocol.evaluateLicense(license, keyHex, NOW)
  const b = gate.evaluateAccess(license, keyHex, NOW)
  check(`${name}：协议码 = 闸门码`, `${a.code}/${b.code}`, `${expectCode}/${expectCode}`)
  check(`${name}：ok 一致`, `${a.ok}/${b.ok}`, `${expectCode === 'OK'}/${expectCode === 'OK'}`)
}

try {
  console.log('=== 1 · 判定对等 ===')
  const valid = makeLicense()
  compare('有效凭据', valid, KEY, 'OK')

  const tampered = { ...valid, subject: '被改过的学员' }
  compare('篡改 subject', tampered, KEY, 'E-602')

  const tamperedExpiry = { ...valid, expiresAt: new Date(NOW.getTime() + 999 * 86400_000).toISOString() }
  compare('篡改有效期', tamperedExpiry, KEY, 'E-602')

  const expired = makeLicense({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() })
  compare('已过期', expired, KEY, 'E-603')

  const narrow = makeLicense({ scopes: ['training:review'] })
  compare('scope 不足', narrow, KEY, 'E-604')

  compare('无凭据', null, KEY, 'E-601')
  compare('无密钥', valid, null, 'E-606')
  compare('版本不符', makeLicense({ version: 2 }), KEY, 'E-605')
  compare('缺字段', { version: 1, subject: 'x', scopes: [], issuedAt: NOW.toISOString(), expiresAt: NOW.toISOString() }, KEY, 'E-605')

  console.log('\n=== 2 · 读盘判定 ===')
  check('未落盘 → E-601', gate.checkAccess(NOW).code, 'E-601')
  protocol.issueLicense({ subject: '读盘学员', days: 30, now: NOW })
  gate.resetAccessCache()
  const live = gate.checkAccess(NOW)
  check('签发后 → OK', live.code, 'OK')
  check('签发后 → LV1', live.level, 'LV1')
  check('缓存生效（同毫秒复用）', gate.checkAccess(NOW).code, 'OK')

  // 改文件 → 缓存失效后应报篡改
  const file = join(STATE, 'license.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.subject = '偷偷改名'
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
  gate.resetAccessCache()
  check('改文件后 → E-602', gate.checkAccess(NOW).code, 'E-602')

  const protoLive = protocol.checkOnDisk(NOW)
  check('协议侧同样判 E-602', protoLive.code, 'E-602')

  console.log('\n=== 3 · 只读性 ===')
  check('密钥未被闸门改写', protocol.loadKey() !== null, true)
  const before = readFileSync(file, 'utf8')
  gate.checkAccess(NOW)
  check('闸门不写 license.json', readFileSync(file, 'utf8') === before, true)
} finally {
  rmSync(STATE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
