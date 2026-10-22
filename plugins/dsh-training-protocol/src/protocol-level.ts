/**
 * dsh-training-protocol · 协议授权等级（LV0 → LV1）
 * ---------------------------------------------------------------------------
 * 本文件是「协议授权」的**占位骨架**，只定义数据结构与闸门语义，
 * 不含任何真实授权逻辑。LV0→LV1 的放行判定目前一律返回 false（见 canEnterLv1）。
 *
 * 设计意图：
 *   LV0 = 未授权。学员能读课程目录，但无法进入实训场（playground）与
 *         调用任何需要授权的能力。
 *   LV1 = 已授权。学员签署《培训班协议》并由带教角色（星辰 TxzF / 长征姬）
 *         之一签发 License 后才可进入。
 *
 * 为什么不在插件里直接判定：
 *   协议签发涉及身份、审计与时效，后续应由独立模块（板块化原则）负责，
 *   本插件只消费「已签发的 License」这一标准接口产物。
 * ---------------------------------------------------------------------------
 */

/** 授权等级 */
export type ProtocolLevel = 'LV0' | 'LV1'

/** 授权凭证（后续由协议签发模块产出，本插件只读） */
export interface ProtocolLicense {
  /** 签发人：星辰（TxzF）或长征姬的标识 */
  grantedBy: string
  /** 签发时间 ISO 8601 */
  grantedAt: string
  /** 协议版本，例：dsh-training-protocol@0.1.0 */
  protocolVersion: string
  /** 授权范围，占位用；后续按板块拆分为细粒度 scope */
  scopes: string[]
}

/** 等级闸门说明 */
export interface LevelGate {
  readonly label: string
  readonly requiresLicense: boolean
  readonly description: string
}

/** 等级定义表 —— 只放语义，不放业务判定 */
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

/** 等级推进顺序（只允许沿着这个方向走，禁止跳级/回退以外的隐式变更） */
export const LEVEL_ORDER: readonly ProtocolLevel[] = ['LV0', 'LV1'] as const

/**
 * LV0 → LV1 放行判定。
 *
 * ⚠️ 占位实现：恒返回 false。
 * TODO(LV1): 接入协议签发模块后，这里应校验
 *   - License 是否存在且未过期（signature / expiresAt）
 *   - protocolVersion 与当前插件版本是否兼容
 *   - scopes 是否覆盖请求的能力（如 training:playground）
 * 在校验逻辑落地前，**故意保持不可放行**，避免出现「假授权」。
 */
export function canEnterLv1(license: ProtocolLicense | null): boolean {
  void license
  return false
}

/** 供日志/诊断使用的可读描述 */
export function describeGate(level: ProtocolLevel): string {
  const gate = LEVEL_GATE[level]
  return `${gate.label}${gate.requiresLicense ? '（需 License）' : '（免授权）'} — ${gate.description}`
}
