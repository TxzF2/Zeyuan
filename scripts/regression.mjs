#!/usr/bin/env node
/**
 * regression.mjs · 一键全量回归（契约 v2）
 * ---------------------------------------------------------------------------
 * 串起：插件测试 → 安装线 → profile 接线 → 板块 smoke → 端到端冒烟 → A5 三层 → 产物校验
 * 输出一张表，任一失败退出码 1。
 *
 * 用法：node scripts/regression.mjs [--fast]
 *   --fast 跳过需要 Electron 的端到端冒烟（约省 40s）
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const fast = process.argv.includes('--fast')

/** @type {{name:string,cmd:string,args:string[],cwd:string,optional?:boolean,timeout?:number}[]} */
const SUITES = [
  {
    name: '安装包·运行时检测',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-detect-node.mjs')],
    cwd: REPO,
  },
  {
    name: '安装包·profile 接线',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-profile-wire.mjs')],
    cwd: REPO,
  },
  {
    name: '安装包·安装线',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-install-line.mjs')],
    cwd: REPO,
  },
  {
    name: '插件·License',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-license.mjs')],
    cwd: REPO,
  },
  {
    name: '插件·协议路由',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-protocol-routes.mjs')],
    cwd: REPO,
  },
  {
    name: '任务·模型与状态机',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-tasks-model.mjs')],
    cwd: REPO,
  },
  {
    name: '任务·存储与锁',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-tasks-store.mjs')],
    cwd: REPO,
  },
  {
    name: '任务·路由与权限',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-tasks-routes.mjs')],
    cwd: REPO,
  },
  {
    name: '任务·闸门对等',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/test-tasks-license.mjs')],
    cwd: REPO,
  },
  {
    name: '插件·agents 配置',
    cmd: process.execPath,
    args: [join(REPO, 'scripts/check-agents-config.mjs')],
    cwd: REPO,
  },
  {
    name: '插件·cordis 挂载',
    cmd: process.execPath,
    args: [join(REPO, 'scripts/verify-cordis-mount.mjs')],
    cwd: REPO,
  },
  {
    name: '插件·冒烟挂载',
    cmd: process.execPath,
    args: [join(REPO, 'scripts/smoke-mount.mjs')],
    cwd: REPO,
  },
  {
    name: '板块契约 + 全部 smoke',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/check-boards.mjs'), '--all'],
    cwd: REPO,
  },
  {
    name: '出包干跑（stage 1）',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/build.mjs')],
    cwd: REPO,
  },
  {
    name: '端到端冒烟（Electron）',
    cmd: process.execPath,
    args: [join(REPO, 'scripts/smoke-test.mjs')],
    cwd: REPO,
    optional: fast,
    timeout: 180_000,
  },
  {
    name: 'A5 三层验证',
    cmd: process.execPath,
    args: [join(REPO, 'scripts/verify-a5.mjs')],
    cwd: REPO,
  },
  {
    name: '产物校验（SHA256）',
    cmd: process.execPath,
    args: [join(REPO, 'packaging/scripts/verify.mjs')],
    cwd: REPO,
  },
]

function lastSummary(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const hit = [...lines].reverse().find((l) => /通过\s*\d+\s*项|结果：|A5_RESULT|✅.*合规|RESULT=/.test(l))
  return hit ?? lines.at(-1) ?? ''
}

const rows = []
let failed = 0
const startedAt = Date.now()

for (const s of SUITES) {
  const t0 = Date.now()
  if (s.optional) {
    rows.push({ name: s.name, ok: true, skipped: true, ms: 0, summary: '按 --fast 跳过' })
    continue
  }
  try {
    const out = execFileSync(s.cmd, s.args, {
      cwd: s.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: s.timeout ?? 120_000,
    })
    rows.push({ name: s.name, ok: true, ms: Date.now() - t0, summary: lastSummary(out) })
  } catch (e) {
    failed++
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
    rows.push({ name: s.name, ok: false, ms: Date.now() - t0, summary: lastSummary(out) || e.message })
  }
  process.stdout.write(`· ${s.name} ${rows.at(-1).ok ? '✓' : '✗'}\n`)
}

const width = Math.max(...rows.map((r) => [...r.name].length)) + 2
console.log('\n=== 全量回归 ===')
for (const r of rows) {
  const mark = r.skipped ? '⏭' : r.ok ? '✅' : '❌'
  console.log(`${mark} ${r.name.padEnd(width, ' ')} ${String(r.ms).padStart(6)}ms  ${r.summary}`)
}
const total = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`\n${failed === 0 ? '✅ 全绿' : `❌ ${failed} 套失败`} ｜ ${rows.length} 套 ｜ 用时 ${total}s`)
process.exit(failed === 0 ? 0 : 1)
