#!/usr/bin/env node
/**
 * build.mjs · 安装包构建入口
 * ---------------------------------------------------------------------------
 * 阶段 1（默认）：只校验清单与结构，打印产物计划，**不写任何产物**
 * 阶段 2（--stage 2）：真出包 —— 便携目录 + zip（复用本地 Electron dist，全程离线）
 * 阶段 3（--stage 3）：安装器 exe + 签名，**仍未实现**（退出码 3）
 *
 * 便携包布局（Electron 官方 portable 形态，不需要 electron-builder）：
 *   dsh-training-portable-v<ver>-<date>-x64/
 *   ├─ dsh-training-installer.exe     ← 由 electron.exe 改名
 *   ├─ *.dll / *.pak / locales/ / resources/
 *   └─ resources/app/
 *      ├─ main.js / preload.js / package.json
 *      ├─ lib/（installer / profile-wire / detect-runtime）
 *      ├─ wizard/（index.html）
 *      └─ payload/（插件 dist + 板块清单，安装器据此写目标目录）
 *
 * 用法：
 *   node packaging/scripts/build.mjs            # 干跑校验
 *   node packaging/scripts/build.mjs --stage 2  # 出便携 zip
 *   node packaging/scripts/build.mjs --stage 3  # 拒绝（未实现，退出码 3）
 *
 * 退出码：0 成功；1 校验/出包失败；3 阶段未实现
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..')
const SHELL_DIR = join(PKG_ROOT, 'installer', 'shell')
const PLUGIN_NAMES = ['dsh-training-protocol', 'dsh-training-tasks']
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'dsh-training-protocol')
const ELECTRON_DIST = join(SHELL_DIR, 'node_modules', 'electron', 'dist')
const ARTIFACTS = join(PKG_ROOT, 'artifacts')

const SEMVER = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

const errors = []
const warnings = []
const ok = []
const fail = (m) => errors.push(m)

function artifactName(dist, form) {
  const f = dist.forms[form]
  return dist.filePattern
    .replace('{form}', form)
    .replace('{version}', dist.version)
    .replace('{date}', dist.buildDate)
    .replace('{arch}', dist.arch)
    .replace('{ext}', f.ext)
}

// ---------------------------------------------------------------- 校验
function validateDistribution() {
  const file = join(PKG_ROOT, 'distribution.json')
  if (!existsSync(file)) {
    fail('缺少 distribution.json')
    return null
  }
  const dist = JSON.parse(readFileSync(file, 'utf8'))
  if (!SEMVER.test(dist.version)) fail(`version 不符合语义化版本：${dist.version}`)
  else ok.push(`版本 v${dist.version}`)
  if (!dist.filePattern.includes('{version}')) fail('filePattern 必须包含 {version}')
  if (!dist.filePattern.includes('{date}')) fail('filePattern 必须包含 {date}')
  if (!dist.runtime?.node) fail('缺少 runtime.node 最低版本要求')
  for (const [form, cfg] of Object.entries(dist.forms ?? {})) {
    if (!cfg.ext) fail(`形态 ${form} 缺少 ext`)
    if (!cfg.stage) fail(`形态 ${form} 缺少 stage`)
  }
  ok.push(`形态 ${Object.keys(dist.forms ?? {}).length} 个`)
  return dist
}

function validateBoards() {
  const file = join(PKG_ROOT, 'boards.json')
  if (!existsSync(file)) {
    fail('缺少 boards.json')
    return []
  }
  const { boards } = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(boards) || boards.length === 0) {
    fail('boards.json 里没有任何板块')
    return []
  }
  const ids = new Set()
  for (const b of boards) {
    if (!ID_PATTERN.test(b.id)) fail(`板块 id 非法：${b.id}`)
    if (ids.has(b.id)) fail(`板块 id 重复：${b.id}`)
    ids.add(b.id)
    if (!['required', 'optional', 'preview'].includes(b.kind)) fail(`${b.id}: kind 非法`)
    if (!['skeleton', 'placeholder', 'ready'].includes(b.status)) fail(`${b.id}: status 非法`)

    const dir = join(PKG_ROOT, b.boardDir)
    if (!existsSync(dir)) fail(`${b.id}: 板块目录不存在 ${b.boardDir}`)
    const boardFile = join(dir, 'board.json')
    if (!existsSync(boardFile)) {
      fail(`${b.id}: 缺少 board.json（跑 scaffold-boards.mjs）`)
      continue
    }
    if (JSON.parse(readFileSync(boardFile, 'utf8')).id !== b.id) fail(`${b.id}: board.json id 不一致`)
    for (const dep of b.dependsOn ?? []) {
      if (!boards.some((x) => x.id === dep)) fail(`${b.id}: 依赖不存在的板块 ${dep}`)
    }
    if (b.kind === 'required' && b.defaultSelected !== true) fail(`${b.id}: 必装板块 defaultSelected 必须为 true`)
  }
  if (!boards.some((b) => b.kind === 'required')) fail('至少需要一个 kind=required 的板块')
  ok.push(`板块 ${boards.length} 个（必装 ${boards.filter((b) => b.kind === 'required').length}）`)
  return boards
}

function validatePayloads() {
  const checks = [
    [join(PLUGIN_DIR, 'dist', 'index.js'), '核心插件 dist（先编译）'],
    [join(REPO_ROOT, 'plugins', 'dsh-training-tasks', 'dist', 'index.js'), '任务插件 dist（先编译）'],
    [join(PLUGIN_DIR, 'lib', 'client.js'), '插件 client 半 lib/client.js'],
    [join(SHELL_DIR, 'main.js'), '安装器 shell main.js'],
    [join(PKG_ROOT, 'installer', 'wizard', 'index.html'), '向导页 installer/wizard/index.html'],
    [ELECTRON_DIST, 'Electron dist（先 pnpm install + node install.js）'],
  ]
  for (const [path, label] of checks) {
    if (!existsSync(path)) fail(`缺少 ${label}：${path}`)
  }
  if (checks.every(([p]) => existsSync(p))) ok.push('载荷与运行时齐备')
}

function printPlan(dist) {
  console.log('\n产物计划（干跑不生成）：')
  for (const form of Object.keys(dist.forms)) console.log(`  ${artifactName(dist, form)}`)
}

// ---------------------------------------------------------------- 阶段 2：出便携包
function dirSize(dir) {
  let total = 0
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name)
      if (e.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dir)
  return total
}

/** 中文交付目录：产物落这里，解决"解压后找不到文件" */
function deliveryDir(dist) {
  return join(ARTIFACTS, '交付', `DSH培训班-便携版-v${dist.version}-${dist.buildDate}`)
}

function buildPortable(dist, boards) {
  const name = `dsh-training-portable-v${dist.version}-${dist.buildDate}-${dist.arch}`
  const stageRoot = join(ARTIFACTS, '.staging-portable')
  const appDir = join(stageRoot, name)
  const outDir = deliveryDir(dist)
  const zipPath = join(outDir, `${name}.zip`)

  console.log(`\n=== 阶段 2：装配便携包 ${name} ===`)
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(appDir, { recursive: true })

  console.log('· 复制 Electron 运行时…')
  cpSync(ELECTRON_DIST, appDir, { recursive: true })

  console.log('· 改造主程序（改名 + 去掉 default_app）…')
  const exeSrc = join(appDir, 'electron.exe')
  if (!existsSync(exeSrc)) throw new Error('Electron dist 里没有 electron.exe')
  cpSync(exeSrc, join(appDir, 'dsh-training-installer.exe'))
  rmSync(exeSrc, { force: true })
  const defaultApp = join(appDir, 'resources', 'default_app.asar')
  if (existsSync(defaultApp)) rmSync(defaultApp, { force: true })

  const locales = join(appDir, 'locales')
  if (existsSync(locales)) {
    let removed = 0
    for (const f of readdirSync(locales)) {
      if (!/^(zh-CN|en-US)\.pak$/.test(f)) {
        rmSync(join(locales, f), { force: true })
        removed++
      }
    }
    console.log(`· 语言包瘦身：移除 ${removed} 个，保留 zh-CN / en-US`)
  }

  console.log('· 写入 resources/app（向导 + 主进程 + lib）…')
  const appRes = join(appDir, 'resources', 'app')
  mkdirSync(appRes, { recursive: true })
  cpSync(join(SHELL_DIR, 'main.js'), join(appRes, 'main.js'))
  cpSync(join(SHELL_DIR, 'preload.js'), join(appRes, 'preload.js'))
  cpSync(join(SHELL_DIR, 'package.json'), join(appRes, 'package.json'))
  cpSync(join(SHELL_DIR, 'lib'), join(appRes, 'lib'), { recursive: true })
  cpSync(join(PKG_ROOT, 'installer', 'wizard'), join(appRes, 'wizard'), { recursive: true })

  console.log('· 写入 payload（插件 dist + 板块清单 + 角色资产）…')
  const payload = join(appRes, 'payload')
  const pluginsOut = join(payload, 'plugins')
  for (const pluginName of PLUGIN_NAMES) {
    const src = join(REPO_ROOT, 'plugins', pluginName)
    if (!existsSync(src)) {
      console.warn(`   ! 插件缺失，跳过：${pluginName}`)
      continue
    }
    const out = join(pluginsOut, pluginName)
    mkdirSync(out, { recursive: true })
    for (const sub of ['dist', 'lib']) {
      if (existsSync(join(src, sub))) cpSync(join(src, sub), join(out, sub), { recursive: true })
    }
    for (const f of ['package.json', 'cordis.patch.yml']) cpSync(join(src, f), join(out, f))
  }
  const pluginOut = join(pluginsOut, 'dsh-training-protocol')

  cpSync(join(PKG_ROOT, 'boards.json'), join(payload, 'boards.json'))
  cpSync(join(PKG_ROOT, 'distribution.json'), join(payload, 'distribution.json'))
  const boardsRoot = join(payload, 'boards')
  for (const b of boards) {
    const from = join(PKG_ROOT, b.boardDir)
    const to = join(boardsRoot, b.id)
    // 整目录复制：清单之外还要带上 assets/（角色 FBX、三视图、动作帧）
    cpSync(from, to, { recursive: true })
  }

  const must = [
    join(appDir, 'dsh-training-installer.exe'),
    join(appRes, 'main.js'),
    join(appRes, 'wizard', 'index.html'),
    join(appRes, 'lib', 'installer.js'),
    join(appRes, 'lib', 'profile-wire.js'),
    join(pluginOut, 'dist', 'index.js'),
    join(pluginsOut, 'dsh-training-tasks', 'dist', 'index.js'),
    join(payload, 'boards.json'),
  ]
  const missing = must.filter((p) => !existsSync(p))
  if (missing.length) throw new Error(`装配缺文件：\n  ${missing.join('\n  ')}`)

  console.log('· 压缩为 zip（Compress-Archive，离线）…')
  // 清掉旧交付目录与遗留 zip，发布目录只保留本次产物
  const deliveryRoot = join(ARTIFACTS, '交付')
  if (existsSync(deliveryRoot)) rmSync(deliveryRoot, { recursive: true, force: true })
  for (const f of readdirSync(ARTIFACTS)) {
    if (/^dsh-training-portable-.*\.zip$/.test(f)) rmSync(join(ARTIFACTS, f), { force: true })
  }
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit' },
  )

  const zipSize = statSync(zipPath).size
  const unpacked = dirSize(appDir)

  // 中文交付说明（避免解压后不知道点哪个）
  writeFileSync(
    join(outDir, '怎么用.txt'),
    [
      'DSH Agent 培训班 · 便携版',
      `版本：v${dist.version}    构建日期：${dist.buildDate}`,
      '',
      '1. 右键本目录里的 zip → 「全部解压缩」（路径不要带中文）',
      '2. 进入解出的文件夹，双击 dsh-training-installer.exe',
      '3. 若提示「Windows 已保护你的电脑」→ 更多信息 → 仍要运行',
      '4. 按向导走完 → 重启 DSH Desktop',
      '5. 到 设置 → 培训班 · 协议授权 签署协议',
      '',
      `解压后占用约 ${(unpacked / 1024 / 1024).toFixed(0)} MB`,
      '',
    ].join('\\r\\n'),
    'utf8',
  )
  const manualSrc = join(REPO_ROOT, 'docs', '下载者安装手册.md')
  if (existsSync(manualSrc)) cpSync(manualSrc, join(outDir, '安装步骤.md'))
  console.log(`\n✅ 便携包已生成：${zipPath}`)
  console.log(`   解压后 ${(unpacked / 1024 / 1024).toFixed(1)} MB → zip ${(zipSize / 1024 / 1024).toFixed(1)} MB`)
  console.log(`   双击 ${name}\\dsh-training-installer.exe 运行向导`)
  console.log(`   交付目录：${outDir}`)
  return { zipPath, zipSize, unpacked, name, outDir }
}

// ---------------------------------------------------------------- 入口
function main(argv) {
  const stageArg = argv.indexOf('--stage')
  const stage = stageArg > -1 ? Number(argv[stageArg + 1]) : 1

  console.log('dsh-training 构建\n')
  const dist = validateDistribution()
  const boards = validateBoards()
  validatePayloads()

  console.log('已通过：')
  ok.forEach((l) => console.log(`  ✅ ${l}`))
  if (warnings.length) {
    console.log('\n提醒：')
    warnings.forEach((l) => console.log(`  ⚠️  ${l}`))
  }
  if (errors.length) {
    console.log('\n错误：')
    errors.forEach((l) => console.log(`  ❌ ${l}`))
    console.log(`\n构建失败：${errors.length} 项错误`)
    return 1
  }
  if (!dist) return 1

  if (stage === 3) {
    console.error('\n⛔ 阶段 3（安装器 exe + 签名 + 自动更新）尚未实现。')
    console.error('   当前阶段 2 产出便携 zip；阶段 3 才做 NSIS 安装器与签名。')
    return 3
  }

  if (stage === 2) {
    // 契约闸门：板块 smoke 必须全绿（status=ready 的板块强制），否则拒绝出包
    try {
      console.log('\n=== 板块契约校验（出包闸门）===')
      execFileSync(process.execPath, [join(HERE, 'check-boards.mjs')], { stdio: 'inherit' })
    } catch {
      console.error('\n⛔ 板块契约校验未通过，拒绝出包。')
      return 1
    }
    try {
      const r = buildPortable(dist, boards)
      writeFileSync(
        join(ARTIFACTS, '.last-build.json'),
        JSON.stringify({ at: new Date().toISOString(), stage: 2, ...r, boards: boards.length }, null, 2) + '\n',
        'utf8',
      )
      return 0
    } catch (err) {
      console.error(`\n❌ 出包失败：${err.message}`)
      return 1
    }
  }

  printPlan(dist)
  console.log('\n✅ 干跑通过。要真出包：node packaging/scripts/build.mjs --stage 2')
  return 0
}

process.exit(main(process.argv.slice(2)))
