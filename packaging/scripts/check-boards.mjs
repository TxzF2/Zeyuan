#!/usr/bin/env node
/**
 * check-boards.mjs · 板块契约校验 + smoke 闸门（契约 v2）
 * ---------------------------------------------------------------------------
 * 校验内容：
 *   1 清单字段（schemaVersion=2 / boardApi=1 / 枚举 / install / smoke 命名）
 *   2 依赖图：存在性、自依赖、成环、层级规则（required 不依赖、preview 不被 required 依赖）
 *   3 事件：emits 必须属于本板块且命中注册表；consumes 必须是注册表内完整事件名
 *   4 **smoke 硬闸门**：status=ready 的板块必须 smoke 存在且跑通；缺失/失败即失败
 *
 * 用法：
 *   node packaging/scripts/check-boards.mjs            # 校验 + 只跑 ready 板块 smoke
 *   node packaging/scripts/check-boards.mjs --all      # 校验 + 跑所有板块 smoke
 *   node packaging/scripts/check-boards.mjs --json     # 机器可读输出
 *
 * 退出码：0 通过 / 1 失败
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const BOARDS_ROOT = join(PKG_ROOT, 'boards')
const CONTRACTS = join(PKG_ROOT, 'contracts')

const ARGS = process.argv.slice(2)
const runAll = ARGS.includes('--all')
const asJson = ARGS.includes('--json')

const errors = []
const warnings = []
const ok = []
const smokeResults = []

const err = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ---------------------------------------------------------------- 载入
const boardsDoc = readJson(join(PKG_ROOT, 'boards.json'))
const registry = readJson(join(CONTRACTS, 'events.json'))
const ids = boardsDoc.boards.map((b) => b.id)
const boards = new Map()

for (const b of boardsDoc.boards) {
  const dir = join(BOARDS_ROOT, b.id)
  const file = join(dir, 'board.json')
  if (!existsSync(file)) {
    err(`${b.id}: 缺少 board.json`)
    continue
  }
  const board = readJson(file)
  boards.set(b.id, { board, dir })
}

// ---------------------------------------------------------------- 1 字段校验
const KINDS = ['required', 'optional', 'preview']
const STATUSES = ['skeleton', 'placeholder', 'ready']
const MODES = ['plugin-link', 'asset-copy', 'copy']
const SEMVER = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/
const ID_RE = /^[a-z][a-z0-9-]*$/

for (const [id, { board }] of boards) {
  if (board.id !== id) err(`${id}: board.json 的 id 是 ${board.id}`)
  if (!ID_RE.test(board.id ?? '')) err(`${id}: id 格式非法`)
  if (board.schemaVersion !== 2) err(`${id}: schemaVersion 必须是 2（当前 ${board.schemaVersion}）`)
  if (board.boardApi !== 1) err(`${id}: boardApi 必须是 1（整数、只兼容相等；当前 ${board.boardApi}）`)
  if (!board.displayName) err(`${id}: 缺少 displayName`)
  if (!KINDS.includes(board.kind)) err(`${id}: kind 非法`)
  if (!STATUSES.includes(board.status)) err(`${id}: status 非法`)
  if (!SEMVER.test(board.version ?? '')) err(`${id}: version 非法（${board.version}）`)
  if (!Array.isArray(board.dependsOn)) err(`${id}: dependsOn 必须是数组`)
  if (typeof board.defaultSelected !== 'boolean') err(`${id}: defaultSelected 必须是布尔`)
  if (!board.install || !MODES.includes(board.install.mode)) err(`${id}: install.mode 非法`)
  if (!board.install?.target) err(`${id}: 缺少 install.target`)
  if (board.smoke !== `test-${id}.mjs`) err(`${id}: smoke 必须是 test-${id}.mjs（当前 ${board.smoke}）`)
  if (!existsSync(join(BOARDS_ROOT, id, board.smoke ?? ''))) err(`${id}: smoke 文件不存在：${board.smoke}`)
  // 落点与类型一致性
  if (board.kind === 'required' && board.install?.mode !== 'plugin-link') err(`${id}: required 板块 mode 应为 plugin-link`)
  if (board.kind === 'required' && ((board.dependsOn ?? []).length > 0)) err(`${id}: required 板块不应有依赖`)
  if (board.id.startsWith('character-') || board.id.startsWith('theme-')) {
    if (board.install?.mode !== 'asset-copy') err(`${id}: 角色/主题板块 mode 应为 asset-copy`)
  }
  if (board.id.startsWith('feature-') && board.install?.mode !== 'copy') err(`${id}: 功能板块 mode 应为 copy`)
}

// ---------------------------------------------------------------- 2 依赖图
const requiredIds = [...boards.values()].filter((x) => x.board.kind === 'required').map((x) => x.board.id)
if (requiredIds.length !== 1) err(`required 板块应恰好 1 个，当前 ${requiredIds.length}（${requiredIds.join(', ')}）`)

for (const [id, { board }] of boards) {
  for (const dep of board.dependsOn ?? []) {
    if (!boards.has(dep)) err(`${id}: 依赖不存在的板块 ${dep}`)
    if (dep === id) err(`${id}: 自依赖`)
  }
}

// 环检测（DFS）
const state = new Map()
function visit(id, trail) {
  if (state.get(id) === 'done') return
  if (state.get(id) === 'visiting') {
    err(`依赖成环：${[...trail, id].join(' → ')}`)
    return
  }
  state.set(id, 'visiting')
  for (const dep of boards.get(id)?.board.dependsOn ?? []) {
    if (boards.has(dep)) visit(dep, [...trail, id])
  }
  state.set(id, 'done')
}
for (const id of boards.keys()) visit(id, [])

// 层级规则：preview 不得被 required 依赖（required 本来就无依赖，这里再兜一层）
for (const [id, { board }] of boards) {
  if (board.kind === 'required') continue
  for (const dep of board.dependsOn ?? []) {
    const depBoard = boards.get(dep)?.board
    if (depBoard?.kind === 'preview' && board.kind === 'required') err(`${id}: required 不得依赖 preview 板块 ${dep}`)
  }
}

// ---------------------------------------------------------------- 3 事件
const actionPattern = new RegExp(registry.naming.actionPattern)
const allEvents = new Set(
  Object.entries(registry.byBoard ?? {}).flatMap(([b, acts]) =>
    acts.map((a) => `${registry.naming.prefix}${b}:${a}`),
  ),
)
for (const [id, { board }] of boards) {
  const own = new Set(registry.byBoard?.[id] ?? [])
  if (!board.events || !Array.isArray(board.events.emits) || !Array.isArray(board.events.consumes)) {
    err(`${id}: events.emits/consumes 必须是数组`)
    continue
  }
  for (const a of board.events.emits) {
    if (!actionPattern.test(a)) err(`${id}: emits 里 ${a} 不符合 kebab-case action 规范`)
    else if (!own.has(a)) err(`${id}: emits 未在注册表登记：${a}`)
  }
  for (const e of board.events.consumes) {
    if (!allEvents.has(e)) err(`${id}: consumes 未在注册表登记：${e}`)
  }
}

// ---------------------------------------------------------------- 4 smoke 闸门
const toRun = [...boards.values()].filter(({ board }) => runAll || board.status === 'ready')
for (const { board, dir } of toRun) {
  const smokePath = join(dir, board.smoke)
  if (!existsSync(smokePath)) {
    err(`${board.id}: status=${board.status} 但 smoke 不存在，不允许 ready`)
    smokeResults.push({ board: board.id, ok: false, reason: 'smoke 缺失' })
    continue
  }
  try {
    const out = execFileSync(process.execPath, [smokePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const tail = out.trim().split(/\r?\n/).filter((l) => l.includes('通过')).pop() ?? ''
    smokeResults.push({ board: board.id, ok: true, summary: tail })
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const tail = out.trim().split(/\r?\n/).filter((l) => l.includes('通过')).pop() ?? e.message
    smokeResults.push({ board: board.id, ok: false, summary: tail })
    err(`${board.id}: smoke 失败（${tail}）`)
  }
}

// ready 板块若没有 assetManifest 而装了资产，提示（非错误）
for (const [id, { board, dir }] of boards) {
  if (board.status !== 'ready') continue
  const hasAssets = existsSync(join(dir, 'assets'))
  if (hasAssets && !board.assetManifest) warn(`${id}: 有 assets/ 但未声明 assetManifest`)
}

// ---------------------------------------------------------------- 输出
const readyBoards = [...boards.values()].filter((x) => x.board.status === 'ready').length
ok.push(`板块 ${boards.size} 个（required ${requiredIds.length} / ready ${readyBoards}）`)
ok.push(`事件注册表 ${allEvents.size} 个事件 / ${Object.keys(registry.byBoard ?? {}).length} 个板块`)
ok.push(`smoke 执行 ${smokeResults.filter((s) => s.ok).length}/${smokeResults.length} 通过`)

if (asJson) {
  console.log(JSON.stringify({ ok, warnings, errors, smokeResults }, null, 2))
} else {
  console.log('=== 板块契约校验（v2）===\n')
  ok.forEach((l) => console.log(`  ✅ ${l}`))
  if (smokeResults.length) {
    console.log('\n  smoke 明细：')
    smokeResults.forEach((s) => console.log(`    ${s.ok ? '✅' : '❌'} ${s.board} — ${s.summary ?? ''}`))
  }
  if (warnings.length) {
    console.log('\n  提醒：')
    warnings.forEach((l) => console.log(`    ⚠️  ${l}`))
  }
  if (errors.length) {
    console.log('\n  错误：')
    errors.forEach((l) => console.log(`    ❌ ${l}`))
  }
  console.log(`\n结果：${errors.length === 0 ? 'PASS' : 'FAIL'}（错误 ${errors.length} / 提醒 ${warnings.length}）`)
}

process.exit(errors.length === 0 ? 0 : 1)
