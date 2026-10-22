// dsh-training-protocol — LV0→LV1 协议授权占位插件（create-dsh-plugin · events 模板生成后二次改造）
//
// 零运行时依赖：只消费宿主注入的 ctx，下面的类型 import 全部在编译期擦除。
// 本插件当前**没有业务逻辑**——只建立「协议等级」骨架与「适配 agent 列表」配置位，
// 等协议签发模块（后续独立板块）落地后再接线。故意不假装已经能授权。
//
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENTS_CONFIG, loadEnabledAgents } from './agents.config.js'
import {
  LEVEL_GATE,
  LEVEL_ORDER,
  canEnterLv1,
  describeGate,
  type ProtocolLevel,
  type ProtocolLicense,
} from './protocol-level.js'

// 插件显示名（loader 诊断里看到的那个）
export const name = 'dsh-training-protocol'

/** 版本号（改写放行判定或动作时同步更新，便于 mount-state 对照） */
export const VERSION = '0.2.0'

/**
 * 挂载标记：桌面端 profile 由 Electron 独占，CLI 无法 boot/dump，
 * 控制台日志也拿不到。所以在 apply() 时落一个文件，
 * 供「重启后离线核验插件是否真的被加载」——验收项 A5 的进程级证据。
 *
 * 目录优先级：DSH_TRAINING_STATE_DIR > %LOCALAPPDATA%\dsh-training > 临时目录
 */
export function mountStatePath(): string {
  const explicit = process.env.DSH_TRAINING_STATE_DIR
  const base = explicit
    ? explicit
    : process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'dsh-training')
      : join(tmpdir(), 'dsh-training')
  return join(base, 'mount-state.json')
}

function writeMountState(payload: Record<string, unknown>): void {
  try {
    const p = mountStatePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      JSON.stringify(
        { plugin: name, version: VERSION, at: new Date().toISOString(), pid: process.pid, ...payload },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch (err) {
    // 写标记失败绝不影响插件本身
    console.warn(`[dsh-training-protocol] 写挂载标记失败（不影响运行）：${(err as Error).message}`)
  }
}

/** 运行时状态（占位：仅进程内存，不落盘、不参与持久化） */
export interface ProtocolState {
  level: ProtocolLevel
  license: ProtocolLicense | null
  /** 最近一次授权尝试的结果，便于诊断 */
  lastAttempt: { at: string; accepted: boolean; reason: string } | null
}

export const state: ProtocolState = {
  level: 'LV0',
  license: null,
  lastAttempt: null,
}

/**
 * 尝试用一张 License 推进到 LV1。
 *
 * ⚠️ 当前恒返回 false：canEnterLv1() 仍是占位实现（见 protocol-level.ts）。
 * 这里刻意保留真实的调用链，等放行判定落地后无需改动本函数。
 */
export function tryGrant(license: ProtocolLicense): boolean {
  state.license = license
  const accepted = canEnterLv1(license)
  state.lastAttempt = {
    at: new Date().toISOString(),
    accepted,
    reason: accepted ? 'LICENSE_ACCEPTED' : 'NOT_IMPLEMENTED（放行判定尚未接入）',
  }
  if (accepted) state.level = 'LV1'
  console.log(`[dsh-training-protocol] tryGrant accepted=${accepted} level=${state.level}`)
  return accepted
}

/** 吊销授权，回到 LV0 */
export function revoke(): void {
  state.license = null
  state.level = 'LV0'
  console.log('[dsh-training-protocol] revoked → LV0')
}

export function apply(ctx: Context) {
  // ① 挂载标志行 —— 实机装载验证的**匹配关键字**，请勿改动格式。
  //    预期：[dsh-training-protocol] mounted — LV0 · 未授权
  console.log(`[dsh-training-protocol] mounted — ${LEVEL_GATE[state.level].label}`)
  console.log(`[dsh-training-protocol] gate: ${describeGate(state.level)}`)

  // ② 适配 agent 列表（配置驱动，空数组是合法状态）
  const { agents, issues } = loadEnabledAgents()
  console.log(
    `[dsh-training-protocol] agents: enabled=${agents.length}/${AGENTS_CONFIG.length}` +
      (AGENTS_CONFIG.length === 0 ? '（列表暂缺，待 src/agents.config.ts 补充）' : ''),
  )
  for (const issue of issues) {
    console.warn(`[dsh-training-protocol] agents config issue @ agents[${issue.index}].${issue.field}: ${issue.message}`)
  }

  // ②b 落挂载标记（A5 进程级证据：重启后读这个文件即可判定"真的被加载了"）
  writeMountState({ event: 'mounted', level: state.level, agentsEnabled: agents.length, host: process.versions.electron ? 'electron' : 'node' })

  // ③ 等级闸门占位：将来订阅协议签发模块的授权事件。
  //    现在只登记一个空 effect，证明「可挂载 / 可卸载」闭环成立。
  ctx.effect(() => {
    // TODO(LV1): 订阅协议签发板块的事件，例：
    //   ctx.on('training/protocol/grant', (license: ProtocolLicense) => { tryGrant(license) })
    //   ctx.on('training/protocol/revoke', () => { revoke() })
    // 在签发模块就位前，不监听任何事件，避免产生「已授权」的错觉。
    return () => {
      console.log('[dsh-training-protocol] gate detached')
    }
  })

  // ④ 可逆清理证明：卸载插件时应看到这一行。
  ctx.effect(
    () => () => {
      writeMountState({ event: 'unmounted', level: state.level })
      console.log('[dsh-training-protocol] DISPOSED — listeners removed, nothing left behind')
    },
  )

  console.log(
    `[dsh-training-protocol] levels=${Object.keys(LEVEL_GATE).join('→')} ` +
      `order=${LEVEL_ORDER.join('→')} canEnterLv1=false（占位）`,
  )
}
