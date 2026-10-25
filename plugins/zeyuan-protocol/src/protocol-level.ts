/**
 * protocol-level.ts · 协议等级与放行判定（LV0 → LV1）
 * ---------------------------------------------------------------------------
 * LV0 = 未授权：可浏览课程目录，不能进实训场。
 * LV1 = 已授权：持有有效 License（存在 + 未过期 + scope 覆盖 + 签名正确）。
 *
 * 放行判定已落地为**完整校验**（阶段三·乙），不再是占位：
 *   evaluateGate(license) → { ok, code, reason, checks }
 * 错误码与 license.ts 一致（E-601~E-606）。
 * ---------------------------------------------------------------------------
 */

import { evaluateLicense, loadKey, REQUIRED_SCOPE, type LicenseCheck, type LicenseFile } from './license.js'

export type ProtocolLevel = 'LV0' | 'LV1'

/** 兼容旧类型：早期占位用的凭据结构（已由 LicenseFile 取代） */
export interface ProtocolLicense {
  grantedBy: string
  grantedAt: string
  protocolVersion: string
  scopes: string[]
}

export interface LevelGate {
  readonly label: string
  readonly requiresLicense: boolean
  readonly description: string
}

export const LEVEL_GATE: Readonly<Record<ProtocolLevel, LevelGate>> = {
  LV0: {
    label: 'LV0 · 未授权',
    requiresLicense: false,
    description: '可浏览课程目录与公开讲义；不可进入实训场，不可调起 agent 演练。',
  },
  LV1: {
    label: 'LV1 · 已授权',
    requiresLicense: true,
    description: '需持有有效 License；解锁实训场、随堂演练与星辰/长征姬的引导式陪练。',
  },
} as const

export const LEVEL_ORDER: readonly ProtocolLevel[] = ['LV0', 'LV1'] as const

/** 是否需要某个 scope 才能进 LV1 */
export function requiredScope(): string {
  return REQUIRED_SCOPE
}

/** 完整判定：返回结构化结果（面板/测试都用它） */
export function evaluateGate(license: LicenseFile | null, now: Date = new Date(), keyHex?: string | null): LicenseCheck {
  const key = keyHex === undefined ? loadKey() : keyHex
  return evaluateLicense(license, key, now, REQUIRED_SCOPE)
}

/** 布尔快捷判定（放行判定入口） */
export function canEnterLv1(license: LicenseFile | null): boolean {
  return evaluateGate(license).ok
}

/** 等级映射：通过 → LV1，否则 LV0 */
export function levelFor(check: LicenseCheck): ProtocolLevel {
  return check.ok ? 'LV1' : 'LV0'
}

/** 供日志/诊断使用的可读描述 */
export function describeGate(level: ProtocolLevel): string {
  const gate = LEVEL_GATE[level]
  return `${gate.label}${gate.requiresLicense ? '（需 License）' : '（免授权）'} — ${gate.description}`
}
