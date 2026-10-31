#!/usr/bin/env node
/**
 * serve-pack.mjs · 内网分发服务（仅私有网段 + token）
 * ---------------------------------------------------------------------------
 * 路由：
 *   GET /health                  （需 token）
 *   GET /m/<machine>.ps1?k=      （ASCII 引导脚本：预检端口 → 拉包 → 解压 → install → 清理）
 *   GET /pack/<machine>.zip?k=   （接入包，含 im.json）
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = process.argv.slice(2)
const val = (f, d) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const DIR = resolve(val('--dir', join(process.env.TEMP ?? '.', 'zeyuan-access-pack')))
const PORT = Number(val('--port', '19600'))
const TOKEN = val('--token', randomBytes(6).toString('hex'))
const LAN = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address)[0]
const LOG = join(ROOT, '交付', 'evidence', 'serve-pack.log')
mkdirSync(join(ROOT, '交付', 'evidence'), { recursive: true })
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`
  console.log(line)
  try {
    appendFileSync(LOG, line + '\n')
  } catch {}
}

const isPrivate = (ip) => {
  if (!ip) return false
  const p = ip.replace(/^::ffff:/, '')
  return p === '127.0.0.1' || p === '::1' || p.startsWith('10.') || p.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(p)
}

// 引导脚本：纯 ASCII，避免 PowerShell 编码解析问题
const boot = (machine) => `# Zeyuan access pack bootstrap (${machine})
$ErrorActionPreference = 'Stop'
$ip = '${LAN}'
$k  = '${TOKEN}'
$m  = '${machine}'

Write-Host "[0/4] connectivity check (19600 pack / 19501 report)..."
foreach ($p in 19600, 19501) {
  $ok = Test-NetConnection $ip -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue
  if (-not $ok) {
    Write-Host "FAIL: port $p unreachable on $ip (same subnet? firewall?)" -ForegroundColor Red
    exit 1
  }
  Write-Host "  OK port $p"
}

$tmp = Join-Path $env:TEMP ("zeyuan-pack-" + $m)
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory $tmp | Out-Null

Write-Host "[1/4] download pack..."
$url = "http://$ip" + ":" + "19600/pack/$m.zip?k=$k"
Invoke-WebRequest $url -OutFile (Join-Path $tmp 'pack.zip') -UseBasicParsing
Write-Host ("  OK " + [math]::Round((Get-Item (Join-Path $tmp 'pack.zip')).Length/1KB,1) + " KB")

Write-Host "[2/4] extract..."
Expand-Archive (Join-Path $tmp 'pack.zip') $tmp -Force
if (-not (Test-Path (Join-Path $tmp 'install.ps1'))) { Write-Host 'FAIL: install.ps1 missing' -ForegroundColor Red; exit 1 }

Write-Host "[3/4] install (config + scheduled tasks 09:00/21:00 + self-check)..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp 'install.ps1')
$code = $LASTEXITCODE

Write-Host "[4/4] cleanup temp copy..."
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Write-Host "FAIL: install exit code $code (temp cleaned)" -ForegroundColor Red; exit $code }

Write-Host ("DONE: $m connected. Reports 09:00/21:00 -> http://" + $ip + ":19501/report") -ForegroundColor Green
`

const server = createServer((req, res) => {
  const ip = req.socket.remoteAddress
  const u = new URL(req.url, 'http://x')
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  if (!isPrivate(ip)) {
    log(`DENY public ${ip} ${u.pathname}`)
    return send(403, 'text/plain; charset=utf-8', 'forbidden: private networks only')
  }
  if (u.searchParams.get('k') !== TOKEN) {
    log(`DENY bad token ${ip} ${u.pathname}`)
    return send(403, 'text/plain; charset=utf-8', 'forbidden: bad token')
  }

  if (u.pathname === '/health') {
    const machines = existsSync(DIR) ? readdirSync(DIR).filter((x) => !x.includes('.')) : []
    return send(200, 'application/json', JSON.stringify({ ok: true, port: PORT, machines }))
  }
  if (u.pathname === '/') {
    const list = existsSync(DIR) ? readdirSync(DIR).filter((x) => !x.includes('.')).join(', ') : ''
    return send(200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><h3>Zeyuan LAN pack</h3><p>machines: ${list}</p>`)
  }
  const mb = u.pathname.match(/^\/m\/([a-z0-9-]+)\.ps1$/)
  if (mb) {
    const m = mb[1]
    if (!existsSync(join(DIR, m))) return send(404, 'text/plain', 'unknown machine')
    log(`boot ${m} -> ${ip}`)
    return send(200, 'text/plain; charset=utf-8', boot(m))
  }
  const pz = u.pathname.match(/^\/pack\/([a-z0-9-]+)\.zip$/)
  if (pz) {
    const f = normalize(join(DIR, pz[1] + '.zip'))
    if (!f.startsWith(DIR) || !existsSync(f)) return send(404, 'text/plain', 'not found')
    const size = statSync(f).size
    log(`pack ${pz[1]} (${(size / 1024).toFixed(0)} KB) -> ${ip}`)
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': size, 'cache-control': 'no-store' })
    return createReadStream(f).pipe(res)
  }
  return send(404, 'text/plain', 'not found')
})

server.listen(PORT, '0.0.0.0', () => {
  log(`serve-pack on :${PORT} dir=${DIR}`)
  console.log(`LAN ${LAN}:${PORT} | report hub http://${LAN}:19501/report`)
  for (const m of ['dsh-2', 'dsh-3']) {
    console.log(`\n${m}:\npowershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'http://${LAN}:${PORT}/m/${m}.ps1?k=${TOKEN}' | iex"`)
  }
})
