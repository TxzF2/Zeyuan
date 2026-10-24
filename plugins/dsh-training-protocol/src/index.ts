// dsh-training-protocol — 协议授权插件（LV0→LV1）
//
// 双半结构（参照 create-dsh-plugin 的 panel 模板）：
//   HOST  半（本文件 → dist/index.js）：跑在 DSH Node 进程，负责 License 校验与 HTTP 路由
//   BROWSER 半（../lib/client.js）：跑在 DSH Web UI，注册 settings.section 面板（协议页常驻）
//
// 关键约束：**不声明 inject:['webServer']**。
// verify-cordis-mount / smoke-mount 用的是裸 Context，没有 webServer；
// 声明 inject 会让插件在这些环境里永远不 apply，测试就绿不了。
// 改为「有 webServer 就注册路由，没有就跳过」，插件本体永远可挂载。
//
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGENTS_CONFIG, loadEnabledAgents } from './agents.config.js'
import {
  evaluateGate,
  levelFor,
  LEVEL_GATE,
  LEVEL_ORDER,
  describeGate,
  requiredScope,
  type ProtocolLevel,
} from './protocol-level.js'
import {
  checkOnDisk,
  issueLicense,
  licensePath,
  licenseSummary,
  keyPath,
  readLicense,
  revokeLicense,
  stateDir,
  REQUIRED_SCOPE,
  type LicenseCheck,
  type LicenseFile,
} from './license.js'

export const name = 'dsh-training-protocol'

/** 版本号（改写放行判定或动作时同步更新，便于 mount-state 对照） */
export const VERSION = '0.3.0'

/**
 * 挂载标记：桌面端 profile 由 Electron 独占，CLI 无法 boot/dump，控制台日志也拿不到。
 * 在 apply() 时落一个文件，供「重启后离线核验插件是否真的被加载」——A5 的进程级证据。
 */
export function mountStatePath(): string {
  return join(stateDir(), 'mount-state.json')
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
    // append-only 事件日志：单文件只保留"最后一次"，热重载/失败排查需要历史
    const line = JSON.stringify({ plugin: name, version: VERSION, at: new Date().toISOString(), pid: process.pid, ...payload }) + '\n'
    appendFileSync(join(stateDir(), 'mount-events.jsonl'), line, 'utf8')
  } catch (err) {
    console.warn(`[dsh-training-protocol] 写挂载标记失败（不影响运行）：${(err as Error).message}`)
  }
}

/** 运行时状态 */
export interface ProtocolState {
  level: ProtocolLevel
  license: LicenseFile | null
  lastCheck: LicenseCheck | null
}

export const state: ProtocolState = {
  level: 'LV0',
  license: null,
  lastCheck: null,
}

/**
 * 状态快照：把「等级 + 六项校验 + 凭据摘要」落到 protocol-state.json。
 * 目的：验收时可以在**不看 UI**的情况下核对「签署后是否 LV1」「HMAC 是否通过」。
 */
export function writeStateSnapshot(check: LicenseCheck): void {
  try {
    const p = join(stateDir(), 'protocol-state.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          plugin: name,
          version: VERSION,
          level: state.level,
          levelLabel: LEVEL_GATE[state.level]?.label,
          code: check.code,
          ok: check.ok,
          checks: check.checks,
          license: licenseSummary(check.license),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch (err) {
    console.warn(`[dsh-training-protocol] 写状态快照失败（不影响运行）：${(err as Error).message}`)
  }
}

/** 重新判定并把结果写进 state */
export function refresh(now: Date = new Date()): LicenseCheck {
  const check = checkOnDisk(now)
  state.lastCheck = check
  state.license = check.license
  state.level = levelFor(check)
  writeStateSnapshot(check)
  return check
}

/**
 * 尝试用一张 License 推进到 LV1（完整校验：存在/格式/验签/时效/scope）。
 * 失败时返回 false，并把原因写进 lastCheck。
 */
export function tryGrant(license: LicenseFile | null): boolean {
  const check = evaluateGate(license)
  state.lastCheck = check
  state.license = check.license
  state.level = levelFor(check)
  writeStateSnapshot(check)
  console.log(`[dsh-training-protocol] tryGrant ok=${check.ok} code=${check.code} level=${state.level}`)
  return check.ok
}

/** 撤回授权（吊销 License 落盘文件） */
export function revoke(): void {
  revokeLicense()
  state.license = null
  state.level = 'LV0'
  state.lastCheck = null
  const after = refresh()
  console.log(`[dsh-training-protocol] revoked → LV0（license.json 已删除，code=${after.code}）`)
}

// ---------------------------------------------------------------------------
// HOST 半：HTTP 路由（面板通过 fetch 调用）
// ---------------------------------------------------------------------------
type RouteSpec = { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => void }
type WebServer = { register: (spec: RouteSpec) => () => void }

function sendJson(res: any, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length })
  res.end(buf)
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
      if (raw.length > 64 * 1024) raw = raw.slice(0, 64 * 1024) // 防超大 body
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function statePayload() {
  const check = refresh()
  return {
    ok: true,
    level: state.level,
    levelLabel: LEVEL_GATE[state.level].label,
    requiredScope: requiredScope(),
    check: { ok: check.ok, code: check.code, reason: check.reason, checks: check.checks },
    license: licenseSummary(state.license),
    paths: { license: licensePath(), key: keyPath(), stateDir: stateDir() },
    version: VERSION,
  }
}

function registerRoutes(ctx: Context): void {
  const ws = (ctx as unknown as { webServer?: WebServer }).webServer
  if (!ws || typeof ws.register !== 'function') {
    console.log('[dsh-training-protocol] webServer 不可用，面板路由跳过（插件仍可用）')
    return
  }

  const routes: Array<[RouteSpec['kind'], string, (req: any, res: any) => void]> = [
    ['exact', '/dsh-training/protocol/state', (_req, res) => sendJson(res, 200, statePayload())],
    [
      'exact',
      '/dsh-training/protocol/verify',
      (_req, res) => {
        const check = refresh()
        sendJson(res, 200, { ok: check.ok, code: check.code, reason: check.reason, level: state.level })
      },
    ],
    [
      'exact',
      '/dsh-training/protocol/sign',
      async (req, res) => {
        const body = await readBody(req)
        // 本地培训场景：签发要求显式 confirm，防误触。
        // 安全边界写在 docs/协议授权与License说明.md：拿到本机文件的人即可签发。
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, code: 'E-607', reason: '签发需要显式确认（confirm:true）' })
          return
        }
        try {
          const license = issueLicense({
            subject: String(body?.subject ?? '本机学员'),
            scopes: Array.isArray(body?.scopes) ? body.scopes : [REQUIRED_SCOPE],
            days: Number(body?.days ?? 30),
          })
          const check = refresh()
          sendJson(res, 200, {
            ok: true,
            code: check.code,
            level: state.level,
            license: licenseSummary(license),
            path: licensePath(),
          })
        } catch (err) {
          sendJson(res, 500, { ok: false, code: 'E-608', reason: (err as Error).message })
        }
      },
    ],
    [
      'exact',
      '/dsh-training/protocol/revoke',
      (_req, res) => {
        const removed = revokeLicense()
        refresh()
        sendJson(res, 200, { ok: true, removed, level: state.level })
      },
    ],
  ]

  ctx.effect(() => {
    const disposers = routes.map(([kind, path, handler]) => {
      const dispose = ws.register({ kind, path, handler })
      console.log(`[dsh-training-protocol] route ${path} registered`)
      return dispose
    })
    return () => disposers.forEach((d) => typeof d === 'function' && d())
  }, 'dsh-training-protocol: routes')
}

export function apply(ctx: Context) {
  // ① 挂载标志行 —— 实机装载验证的匹配关键字，勿改格式
  const initial = refresh()
  console.log(`[dsh-training-protocol] mounted — ${LEVEL_GATE[state.level].label}`)
  console.log(`[dsh-training-protocol] license: code=${initial.code} ${initial.reason}`)

  // ② 适配 agent 列表（配置驱动，空数组/占位均合法）
  const { agents, issues } = loadEnabledAgents()
  console.log(
    `[dsh-training-protocol] agents: enabled=${agents.length}/${AGENTS_CONFIG.length}` +
      (AGENTS_CONFIG.length === 0 ? '（列表暂缺，待 src/agents.config.ts 补充）' : ''),
  )
  for (const issue of issues) {
    console.warn(`[dsh-training-protocol] agents config issue @ agents[${issue.index}].${issue.field}: ${issue.message}`)
  }

  // ③ 落挂载标记（A5 进程级证据；含协议等级，便于 A6 核验）
  writeMountState({
    event: 'mounted',
    level: state.level,
    licenseCode: initial.code,
    host: process.versions.electron ? 'electron' : 'node',
  })

  // ④ 面板路由：**动态等待 webServer**。
  //    不能声明 inject:['webServer']——裸 Context（单测/冒烟）里没有该服务，
  //    声明后插件永不 apply，A5 的 L2 证据会失效。
  //    也不能只在 apply 时查一次 ctx.webServer——DSH 里服务是稍后就绪的，
  //    实测 apply 时它还没挂上，导致路由 404（2026-10-24 踩到）。
  //    正确做法：ctx.inject(deps, cb)，服务就绪时才执行注册。
  try {
    const anyCtx = ctx as unknown as { inject?: (deps: string[], cb: (c: Context) => void) => unknown }
    if (typeof anyCtx.inject === 'function') {
      anyCtx.inject(['webServer'], (inner: Context) => {
        try {
          registerRoutes(inner)
        } catch (err) {
          console.warn(`[dsh-training-protocol] 注册路由失败（不影响授权判定）：${(err as Error).message}`)
        }
      })
      console.log('[dsh-training-protocol] 已在 webServer 就绪后注册面板路由')
    } else if ((ctx as unknown as { webServer?: unknown }).webServer) {
      registerRoutes(ctx)
    } else {
      console.log('[dsh-training-protocol] 无 inject 且无 webServer，面板路由跳过（插件仍可用）')
    }
  } catch (err) {
    console.warn(`[dsh-training-protocol] 等待 webServer 失败：${(err as Error).message}`)
  }

  // ⑤ 可逆清理证明：卸载时应看到 DISPOSED，并把标记改成 unmounted
  ctx.effect(
    () => () => {
      writeMountState({ event: 'unmounted', level: state.level })
      console.log('[dsh-training-protocol] DISPOSED — listeners removed, nothing left behind')
    },
  )

  console.log(
    `[dsh-training-protocol] levels=${Object.keys(LEVEL_GATE).join('→')} order=${LEVEL_ORDER.join('→')} ` +
      `requiredScope=${requiredScope()} license=${readLicense() ? 'present' : 'absent'} ` +
      `gate=${describeGate(state.level).slice(0, 12)}…`,
  )
}
