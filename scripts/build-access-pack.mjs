#!/usr/bin/env node
/**
 * build-access-pack.mjs · 生成三机接入包（含本机 webhook，落临时目录，不入库）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/build-access-pack.mjs --machines dsh-2,dsh-3 [--out <dir>]
 *
 * 产出（每个机器一个子目录）：
 *   machine-report.mjs   自包含上报脚本
 *   im.json              {webhook, secret}（**含密钥，仅本机/传输用，严禁入库**）
 *   install.ps1          一键安装：写配置 + 建 09:00/21:00 计划任务 + 自检上报
 *   README.txt           三行操作说明
 *
 * 安全：默认输出到 %TEMP%\zeyuan-access-pack；不写入仓库、不打印明文密钥。
 * ---------------------------------------------------------------------------
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || '', 'zeyuan')

const args = process.argv.slice(2)
const val = (f, d) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const machines = (val('--machines', 'dsh-2,dsh-3') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const out = resolve(val('--out', join(process.env.TEMP ?? '.', 'zeyuan-access-pack')))

// 读本机 im.json
const cfgFile = join(stateDir, 'data', 'im.json')
if (!existsSync(cfgFile)) {
  console.error(`❌ 本机未配置 webhook：${cfgFile}`)
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')).dingtalk
if (!cfg?.webhook) {
  console.error('❌ im.json 里没有 webhook')
  process.exit(1)
}

const srcScript = join(ROOT, 'scripts', 'machine-report.mjs')
if (!existsSync(srcScript)) {
  console.error('❌ 缺 scripts/machine-report.mjs')
  process.exit(1)
}

const installPs1 = (m) => `# 泽元三机接入 · ${m}（一键）
# 用法：右键"使用 PowerShell 运行"，或： powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host '❌ 未安装 Node.js（需 v18+）' -ForegroundColor Red; exit 1 }

Write-Host "[1/3] 写配置…"
$cfgPath = Join-Path $here 'im.json'
if (-not (Test-Path $cfgPath)) { Write-Host '❌ 缺 im.json（接入包里应自带）' -ForegroundColor Red; exit 1 }

Write-Host "[2/3] 建计划任务（09:00 / 21:00）…"
$script = Join-Path $here 'machine-report.mjs'
$tr = '"' + $node + '" "' + $script + '" --machine ${m}'
schtasks /Create /SC DAILY /ST 09:00 /TN "Zeyuan-Report-${m}-AM" /TR $tr /F | Out-Null
schtasks /Create /SC DAILY /ST 21:00 /TN "Zeyuan-Report-${m}-PM" /TR $tr /F | Out-Null
Write-Host '  ✅ 任务已建'

Write-Host "[3/3] 自检上报…"
& $node $script --machine ${m} --selfcheck
if ($LASTEXITCODE -ne 0) { Write-Host '❌ 自检失败：检查网络/密钥/群机器人' -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host '✅ ${m} 接入完成：群里应看到一条 [${m}] 接入自检' -ForegroundColor Green
Write-Host '提示：装完后可删除本目录里的 im.json 只有本机需要；若整包外传请先删 im.json'
`

mkdirSync(out, { recursive: true })
for (const m of machines) {
  const dir = join(out, m)
  mkdirSync(dir, { recursive: true })
  cpSync(srcScript, join(dir, 'machine-report.mjs'))
  writeFileSync(join(dir, 'im.json'), JSON.stringify({ webhook: cfg.webhook, secret: cfg.secret ?? '' }, null, 2) + '\n', 'utf8')
  writeFileSync(join(dir, 'install.ps1'), installPs1(m), 'utf8')
  writeFileSync(
    join(dir, 'README.txt'),
    [
      `泽元三机接入 · ${m}`,
      '',
      '1) 把整个目录拷到该机器（任意路径）',
      '2) 右键 install.ps1 → 使用 PowerShell 运行（需本机已装 Node.js 18+）',
      '3) 群里出现一条 "[%s] 接入自检" 即成功' % m,
      '',
      '安全：im.json 内含 webhook+加签密钥，勿上传到任何仓库/群；装完可删。',
      '卸载：schtasks /Delete /TN "Zeyuan-Report-%s-AM" /F 与 -PM' % m,
    ].join('\n'),
    'utf8',
  )
  console.log(`✅ ${m} → ${dir}`)
}

console.log(`\n接入包目录：${out}`)
console.log('⚠️ 包内含密钥（im.json）：只走人工拷贝/安全传输，勿入库、勿发群')
