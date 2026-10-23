/**
 * license.ts · 协议授权凭据（HMAC-SHA256 本地签发与验签）
 * ---------------------------------------------------------------------------
 * 为什么自实现：A6 验收要求"篡改→拒"必须真实验签，签名留空等于把验收拆两轮。
 * HMAC 在本地密钥下成本极低，一次做到位。
 *
 * 文件（都在 stateDir 下）：
 *   license.key    32 字节随机密钥，hex 存储（首次签发时生成）
 *   license.json   凭据本体 + signature
 *
 * 校验顺序（顺序会影响错误码，测试按此断言）：
 *   结构 → 密钥存在 → 验签 → 时效 → scope
 *
 * 错误码：
 *   E-601 无 License      E-602 签名不符（篡改）   E-603 已过期
 *   E-604 scope 不足      E-605 格式非法           E-606 缺少密钥（无法验签）
 * ---------------------------------------------------------------------------
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const LICENSE_VERSION = 1
/** 进入实训场/陪练所需的最小 scope */
export const REQUIRED_SCOPE = 'training:playground'
export const KNOWN_SCOPES = ['training:playground', 'training:review', 'training:admin'] as const

export interface LicenseFile {
  version: number
  subject: string
  scopes: string[]
  issuedAt: string
  expiresAt: string
  signature: string
}

export type LicenseCode = 'OK' | 'E-601' | 'E-602' | 'E-603' | 'E-604' | 'E-605' | 'E-606'

export interface LicenseCheck {
  ok: boolean
  code: LicenseCode
  reason: string
  checks: {
    exists: boolean
    shape: boolean
    keyPresent: boolean
    signature: boolean
    notExpired: boolean
    scope: boolean
  }
  license: LicenseFile | null
}

/** 状态目录：DSH_TRAINING_STATE_DIR > %LOCALAPPDATA%\dsh-training > 临时目录 */
export function stateDir(): string {
  const explicit = process.env.DSH_TRAINING_STATE_DIR
  if (explicit) return explicit
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'dsh-training')
  return join(tmpdir(), 'dsh-training')
}

export function keyPath(): string {
  return join(stateDir(), 'license.key')
}

export function licensePath(): string {
  return join(stateDir(), 'license.json')
}

function ensureDir(): void {
  mkdirSync(stateDir(), { recursive: true })
}

/** 读取密钥；不存在返回 null（不自动生成——签发时才生成） */
export function loadKey(): string | null {
  try {
    if (!existsSync(keyPath())) return null
    const hex = readFileSync(keyPath(), 'utf8').trim()
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : null
  } catch {
    return null
  }
}

/** 首次签发时生成密钥，并写入（单机本地密钥；轮换见 docs） */
export function ensureKey(): string {
  const existing = loadKey()
  if (existing) return existing
  ensureDir()
  const hex = randomBytes(32).toString('hex')
  writeFileSync(keyPath(), hex + '\n', { encoding: 'utf8', mode: 0o600 })
  return hex
}

/** 规范化载荷：去掉 signature，键排序后 JSON——签名只覆盖内容，不覆盖签名本身 */
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

function isIsoDate(s: unknown): boolean {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s))
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

/** 核心校验：纯函数，便于单测（不读盘） */
export function evaluateLicense(
  license: LicenseFile | null,
  keyHex: string | null,
  now: Date = new Date(),
  /** 传 null 表示不校验 scope（签发自检用） */
  requiredScope: string | null = REQUIRED_SCOPE,
): LicenseCheck {
  const checks = { exists: false, shape: false, keyPresent: false, signature: false, notExpired: false, scope: false }
  const fail = (code: LicenseCode, reason: string): LicenseCheck => ({
    ok: false,
    code,
    reason,
    checks,
    license: checks.shape ? license : null,
  })

  if (!license) return fail('E-601', '尚未签署《培训班协议》——没有任何 License。')
  checks.exists = true

  if (!shapeOk(license)) return fail('E-605', 'License 格式非法（缺字段或版本不匹配）。')
  checks.shape = true

  if (!keyHex) return fail('E-606', '缺少验签密钥（license.key 不存在或格式非法），无法验证凭据。')
  checks.keyPresent = true

  const expect = signLicense(license, keyHex)
  checks.signature = safeEqualHex(expect, license.signature)
  if (!checks.signature) return fail('E-602', '签名不符：License 内容或签名被改动过（篡改/损坏）。')

  const expires = Date.parse(license.expiresAt)
  checks.notExpired = now.getTime() < expires
  if (!checks.notExpired) return fail('E-603', `License 已于 ${license.expiresAt} 过期，需要重新签署。`)

  checks.scope = requiredScope === null ? true : license.scopes.includes(requiredScope)
  if (!checks.scope) return fail('E-604', `License 的 scope 不含 ${requiredScope}，无法进入实训场。`)

  return {
    ok: true,
    code: 'OK',
    reason: `License 有效（subject=${license.subject}，到期 ${license.expiresAt}）。`,
    checks,
    license,
  }
}

/** 从磁盘读取并校验（插件挂载、面板查询都用它） */
export function readLicense(): LicenseFile | null {
  try {
    if (!existsSync(licensePath())) return null
    return JSON.parse(readFileSync(licensePath(), 'utf8')) as LicenseFile
  } catch {
    return null
  }
}

export function checkOnDisk(now: Date = new Date()): LicenseCheck {
  return evaluateLicense(readLicense(), loadKey(), now)
}

export interface IssueOptions {
  subject: string
  scopes?: string[]
  days?: number
  now?: Date
  keyHex?: string
}

/** 签发 License（本地密钥）。返回写入磁盘的凭据。 */
export function issueLicense(opts: IssueOptions): LicenseFile {
  const now = opts.now ?? new Date()
  const days = opts.days ?? 30
  const scopes = opts.scopes ?? [REQUIRED_SCOPE]
  const keyHex = opts.keyHex ?? ensureKey()
  const license: LicenseFile = {
    version: LICENSE_VERSION,
    subject: opts.subject.trim() || '学员',
    scopes,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString(),
    signature: '',
  }
  license.signature = signLicense(license, keyHex)
  ensureDir()
  writeFileSync(licensePath(), JSON.stringify(license, null, 2) + '\n', 'utf8')
  // 签发自检只验结构/签名/时效；scope 是否够用由使用方判定（否则签不出"只读"许可）
  const check = evaluateLicense(license, keyHex, now, null)
  if (!check.ok) {
    throw new Error(`签发后自检失败：${check.code} ${check.reason}`)
  }
  return license
}

/** 吊销：删除 License（保留密钥，便于重签） */
export function revokeLicense(): boolean {
  try {
    if (existsSync(licensePath())) {
      rmSync(licensePath(), { force: true })
      return true
    }
    return false
  } catch {
    return false
  }
}

/** 供面板展示的摘要（不泄露完整签名） */
export function licenseSummary(license: LicenseFile | null) {
  if (!license) return null
  return {
    subject: license.subject,
    scopes: license.scopes,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    signatureShort: `${license.signature.slice(0, 8)}…${license.signature.slice(-4)}`,
  }
}
