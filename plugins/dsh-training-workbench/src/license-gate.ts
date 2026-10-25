/**
 * license-gate.ts · 任务接发区的授权闸门（LV1 才能领取/提交）
 * ---------------------------------------------------------------------------
 * 为什么不直接 import 协议插件的 license.ts：
 *   插件之间没有构建期依赖，运行期跨包 import 依赖 profile 的 node_modules 布局，
 *   很脆。这里按**同一语义**实现只读校验（不签发、不删除），并用
 *   packaging/scripts/test-tasks-license.mjs 做**行为对等测试**，
 *   保证与 dsh-training-protocol 的 evaluateLicense 判定一致（含错误码）。
 *
 * 与协议插件保持一致的部分：
 *   状态目录优先级、canonicalPayload（去 signature + 键排序）、HMAC-SHA256、
 *   校验顺序（结构 → 密钥 → 验签 → 时效 → scope）、错误码 E-601~E-606。
 *
 * 本模块**只读**：绝不生成密钥、绝不写 license。
 * ---------------------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const LICENSE_VERSION = 1
export const REQUIRED_SCOPE = 'training:playground'

export interface LicenseFile {
  version: number
  subject: string
  scopes: string[]
  issuedAt: string
  expiresAt: string
  signature: string
}

export type GateCode = 'OK' | 'E-601' | 'E-602' | 'E-603' | 'E-604' | 'E-605' | 'E-606'

export interface AccessResult {
  ok: boolean
  level: 'LV0' | 'LV1'
  code: GateCode
  reason: string
  subject: string | null
}

/** 状态目录：DSH_TRAINING_STATE_DIR > %LOCALAPPDATA%\dsh-training > 临时目录 */
export function stateDir(): string {
  const explicit = process.env.DSH_TRAINING_STATE_DIR
  if (explicit) return explicit
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'dsh-training')
  return join(tmpdir(), 'dsh-training')
}

export const keyPath = (): string => join(stateDir(), 'license.key')
export const licensePath = (): string => join(stateDir(), 'license.json')

/** 与协议插件逐字一致：去 signature、键排序后 JSON */
export function canonicalPayload(license: LicenseFile): string {
  const { signature: _signature, ...rest } = license as unknown as Record<string, unknown>
  void _signature
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(rest).sort()) sorted[k] = (rest as Record<string, unknown>)[k]
  return JSON.stringify(sorted)
}

export function signLicense(license: LicenseFile, keyHex: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(canonicalPayload(license)).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

function isIsoDate(v: unknown): boolean {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

function shapeOk(l: unknown): l is LicenseFile {
  if (!l || typeof l !== 'object') return false
  const x = l as Record<string, unknown>
  return (
    x.version === LICENSE_VERSION &&
    typeof x.subject === 'string' &&
    x.subject.trim().length > 0 &&
    Array.isArray(x.scopes) &&
    x.scopes.every((s) => typeof s === 'string') &&
    isIsoDate(x.issuedAt) &&
    isIsoDate(x.expiresAt) &&
    typeof x.signature === 'string'
  )
}

function readLicense(): LicenseFile | null {
  try {
    if (!existsSync(licensePath())) return null
    return JSON.parse(readFileSync(licensePath(), 'utf8')) as LicenseFile
  } catch {
    return null
  }
}

function loadKey(): string | null {
  try {
    if (!existsSync(keyPath())) return null
    const hex = readFileSync(keyPath(), 'utf8').trim()
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : null
  } catch {
    return null
  }
}

/** 纯函数判定（不读盘），便于测试与对等验证 */
export function evaluateAccess(
  license: LicenseFile | null,
  keyHex: string | null,
  now: Date = new Date(),
  requiredScope: string = REQUIRED_SCOPE,
): AccessResult {
  const deny = (code: GateCode, reason: string): AccessResult => ({
    ok: false,
    level: 'LV0',
    code,
    reason,
    subject: license?.subject ?? null,
  })

  if (!license) return deny('E-601', '尚未签署《泽元协议》——没有任何 License。')
  if (!shapeOk(license)) return deny('E-605', 'License 格式非法（缺字段或版本不匹配）。')
  if (!keyHex) return deny('E-606', '缺少验签密钥（license.key 不存在或格式非法），无法验证凭据。')

  if (!safeEqualHex(signLicense(license, keyHex), license.signature)) {
    return deny('E-602', '签名不符：License 内容或签名被改动过（篡改/损坏）。')
  }
  if (now.getTime() >= Date.parse(license.expiresAt)) {
    return deny('E-603', `License 已于 ${license.expiresAt} 过期，需要重新签署。`)
  }
  if (!license.scopes.includes(requiredScope)) {
    return deny('E-604', `License 的 scope 不含 ${requiredScope}，无法进入实训场。`)
  }
  return {
    ok: true,
    level: 'LV1',
    code: 'OK',
    reason: `License 有效（subject=${license.subject}，到期 ${license.expiresAt}）。`,
    subject: license.subject,
  }
}

/** 读盘判定（短缓存 1s，避免每个请求都读文件） */
let cache: { at: number; result: AccessResult } | null = null

export function checkAccess(now: Date = new Date(), cacheMs = 1000): AccessResult {
  if (cache && Date.now() - cache.at < cacheMs) return cache.result
  const result = evaluateAccess(readLicense(), loadKey(), now)
  cache = { at: Date.now(), result }
  return result
}

/** 测试用：清缓存 */
export function resetAccessCache(): void {
  cache = null
}
