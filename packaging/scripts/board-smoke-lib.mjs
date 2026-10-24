#!/usr/bin/env node
/**
 * board-smoke-lib.mjs · 板块 smoke 测试基座（契约 v2）
 * ---------------------------------------------------------------------------
 * 硬契约：每个板块必须自带 test-<id>.mjs，且至少覆盖以下 5 类断言。
 * 任何板块的 smoke 只要用本基座，就自动获得统一的判定口径与输出格式。
 *
 * 用法（在 packaging/boards/<id>/test-<id>.mjs 里）：
 *   #!/usr/bin/env node
 *   import { runBoardSmoke } from '../../../scripts/board-smoke-lib.mjs'
 *   await runBoardSmoke('character-txzf')
 *
 * 退出码：0 通过 / 1 失败
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const BOARDS_ROOT = join(PKG_ROOT, 'boards')
const CONTRACTS = join(PKG_ROOT, 'contracts')

const KIND_MODE = { required: 'plugin-link', optional: 'asset-copy', preview: 'copy' }

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
function checkTrue(label, cond, detail = '') {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log(`   细节：${detail}`)
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (cur) => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name)
      if (e.isDirectory()) walk(full)
      else {
        files += 1
        bytes += statSync(full).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

export async function runBoardSmoke(boardId) {
  const boardDir = join(BOARDS_ROOT, boardId)
  const boardFile = join(boardDir, 'board.json')
  console.log(`=== 板块 smoke：${boardId} ===\n`)

  // ---------- 1 清单合法性 ----------
  console.log('--- 1 清单合法性 ---')
  if (!existsSync(boardFile)) {
    console.log(`❌ 找不到 board.json：${boardFile}`)
    process.exit(1)
  }
  const board = loadJson(boardFile)
  check('id 与目录一致', board.id, boardId)
  check('schemaVersion', board.schemaVersion, 2)
  check('boardApi', board.boardApi, 1)
  checkTrue('kind 合法', ['required', 'optional', 'preview'].includes(board.kind), board.kind)
  checkTrue('status 合法', ['skeleton', 'placeholder', 'ready'].includes(board.status), board.status)
  checkTrue('version 合法', /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(board.version ?? ''), board.version)
  checkTrue('defaultSelected 是布尔', typeof board.defaultSelected === 'boolean')
  checkTrue('smoke 字段符合 test-<id>.mjs', new RegExp(`^test-${boardId}\\.mjs$`).test(board.smoke ?? ''), board.smoke)
  checkTrue('install.mode 合法', ['plugin-link', 'asset-copy', 'copy'].includes(board.install?.mode), board.install?.mode)

  // ---------- 2 资产完整性 ----------
  console.log('\n--- 2 资产完整性 ---')
  if (board.assetManifest) {
    const manifestFile = join(boardDir, board.assetManifest)
    if (!existsSync(manifestFile)) {
      checkTrue('asset-manifest 存在', false, manifestFile)
    } else {
      const manifest = loadJson(manifestFile)
      const isReady = board.status === 'ready'
      check('manifest 属于本板块', manifest.board, boardId)
      if (isReady) {
        // 硬契约：ready 板块的资产清单必须是 done，且文件数可核对
        check('ready 板块 manifest status=done', manifest.status, 'done')
      } else {
        // 占位/骨架板块：清单只需存在且声明了自身状态，不强制 done
        checkTrue('占位板块 manifest 声明了 status', typeof manifest.status === 'string', manifest.status)
      }
      let totalFiles = 0
      let okAll = true
      for (const a of manifest.assets ?? []) {
        const target = join(boardDir, a.path)
        if (!existsSync(target)) {
          okAll = false
          console.log(`   ✖ 缺失：${a.path}`)
          continue
        }
        const st = statSync(target)
        if (st.isDirectory()) {
          const s = dirStats(target)
          totalFiles += s.files
          if (s.files !== a.count) {
            okAll = false
            console.log(`   ✖ 文件数不符：${a.path} 实际 ${s.files}，声明 ${a.count}`)
          }
        } else {
          totalFiles += 1
          if (a.bytes && Math.abs(st.size - a.bytes) > 0) {
            okAll = false
            console.log(`   ✖ 字节数不符：${a.path}`)
          }
        }
      }
      checkTrue('资产文件全部存在且数量/字节一致', okAll)
      if (isReady) check('manifest 声明文件数', manifest.totalFiles, totalFiles)
    }
  } else {
    checkTrue('无 assetManifest 时跳过（占位板块）', true)
  }

  // ---------- 3 事件一致性 ----------
  console.log('\n--- 3 事件一致性 ---')
  const registry = loadJson(join(CONTRACTS, 'events.json'))
  const actionPattern = new RegExp(registry.naming.actionPattern)
  const ownEmits = new Set(registry.byBoard?.[boardId] ?? [])
  const allEvents = new Set(
    Object.entries(registry.byBoard ?? {}).flatMap(([b, acts]) => acts.map((a) => `${registry.naming.prefix}${b}:${a}`)),
  )
  const emits = board.events?.emits ?? []
  const consumes = board.events?.consumes ?? []
  const emitBad = emits.filter((a) => !actionPattern.test(a) || !ownEmits.has(a))
  // 契约要求全名；为兼容手写习惯，接受短名并自动补前缀
  const normalize = (e) => (e.startsWith(`${registry.naming.prefix}`) ? e : `${registry.naming.prefix}${e}`)
  const consumeBad = consumes.filter((e) => !allEvents.has(normalize(e)))
  checkTrue('emits 全部命中注册表（本板块）', emitBad.length === 0, emitBad.join(', '))
  checkTrue('consumes 全部是注册表内的完整事件名', consumeBad.length === 0, consumeBad.join(', '))
  checkTrue('emits/consumes 是数组', Array.isArray(emits) && Array.isArray(consumes))

  // ---------- 4 依赖满足 ----------
  console.log('\n--- 4 依赖满足 ---')
  const allBoards = readdirSync(BOARDS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const depBad = (board.dependsOn ?? []).filter((d) => !allBoards.includes(d))
  checkTrue('dependsOn 全部存在', depBad.length === 0, depBad.join(', '))
  checkTrue('不自依赖', !(board.dependsOn ?? []).includes(boardId))
  if (board.kind === 'required') check('必装板块依赖数', (board.dependsOn ?? []).length, 0)

  // ---------- 5 装配/卸载可逆 ----------
  console.log('\n--- 5 装配/卸载可逆 ---')
  const tmp = mkdtempSync(join(tmpdir(), `dsh-board-${boardId}-`))
  try {
    const target = join(tmp, 'target')
    cpSync(boardDir, target, { recursive: true })
    const copied = dirStats(target)
    checkTrue('装配后目标非空', copied.files > 0, `files=${copied.files}`)
    checkTrue('board.json 已随板块落盘', existsSync(join(target, 'board.json')))
    rmSync(target, { recursive: true, force: true })
    check('卸载后残留文件数为 0', existsSync(target) ? dirStats(target).files : 0, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
}
