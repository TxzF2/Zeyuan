#!/usr/bin/env node
/**
 * fetch-parts.mjs · 机器自主下载分卷（移动端 UA + 断点续传 + 重试 + 哈希校验）
 * ---------------------------------------------------------------------------
 * 用途：在慢速/易断网络下，用循环续传把 6 个分卷完整拉下来并校验。
 * 用法：
 *   node scripts/fetch-parts.mjs [--out <dir>] [--max-minutes 180] [--base <url 前缀>]
 *
 * 行为：
 *   - 每个分卷按 30s 分段续传（-C -），直到字节数与 PARTS.txt 一致
 *   - 全部分卷完成后逐卷比对 SHA256，最后合并并校验整包哈希
 *   - 进度与结果写入 交付/evidence/fetch-<ts>.log / .json
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = process.argv.slice(2)
const val = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const VERSION = '0.4.0'
const OUT = resolve(val('--out') ?? join(process.env.TEMP ?? '.', `zeyuan-parts-${VERSION}`))
const MAX_MIN = Number(val('--max-minutes') ?? 180)
const BASE = val('--base') ?? `https://raw.githubusercontent.com/TxzF2/Zeyuan/main/releases/v${VERSION}`
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

const evDir = join(ROOT, '交付', 'evidence')
mkdirSync(evDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const logFile = join(evDir, `fetch-${ts}.log`)
const jsonFile = join(evDir, `fetch-${ts}.json`)

const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`
  console.log(line)
  appendFileSync(logFile, line + '\n', 'utf8')
}

// 读 PARTS.txt（本地仓库副本为准）
const partsFile = join(ROOT, 'releases', `v${VERSION}`, 'PARTS.txt')
const expected = new Map()
for (const line of readFileSync(partsFile, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const [name, size, sha] = line.split('\t')
  if (name) expected.set(name, { size: Number(size), sha256: sha })
}
log(`目标 ${expected.size} 卷 → ${OUT}`)

mkdirSync(OUT, { recursive: true })
const started = Date.now()
const results = []

for (const [name, meta] of expected) {
  const file = join(OUT, name)
  let attempt = 0
  while (true) {
    if (Date.now() - started > MAX_MIN * 60_000) {
      log(`⏱ 超时（${MAX_MIN} 分钟），中止于 ${name}`)
      writeFileSync(jsonFile, JSON.stringify({ at: new Date().toISOString(), aborted: true, results }, null, 2) + '\n', 'utf8')
      process.exit(2)
    }
    const have = existsSync(file) ? statSync(file).size : 0
    if (have >= meta.size) break
    attempt++
    try {
      execFileSync('curl', ['-sS', '-L', '--ssl-no-revoke', '--max-time', '30', '-A', UA, '-C', '-', '-o', file, `${BASE}/${name}`], { stdio: 'ignore' })
    } catch {
      /* 每次超时都算正常，继续续传 */
    }
    const now = existsSync(file) ? statSync(file).size : 0
    if (attempt % 5 === 0 || now >= meta.size) log(`  ${name}: ${now}/${meta.size} B（第 ${attempt} 段，+${now - have}）`)
  }
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
  const ok = sha === meta.sha256
  log(`  ✅ ${name} 完成 ${statSync(file).size} B | sha256 ${ok ? '一致' : '❌不一致'}`)
  results.push({ name, size: statSync(file).size, expected: meta.size, sha256: sha, ok })
  if (!ok) {
    writeFileSync(jsonFile, JSON.stringify({ at: new Date().toISOString(), results, failed: name }, null, 2) + '\n', 'utf8')
    process.exit(1)
  }
}

// 合并 + 整包校验
const merged = join(OUT, 'zeyuan-portable.zip')
const h = createHash('sha256')
if (existsSync(merged)) writeFileSync(merged, '') // truncate
for (const [name] of expected) {
  const buf = readFileSync(join(OUT, name))
  h.update(buf)
  appendFileSync(merged, buf)
}
const whole = h.digest('hex')
const expectWhole = '32590cb9d1f91a0219feedd3ffffe74bf3a47960e18ee04943a50eded54d2dce'
log(`整包 sha256 = ${whole} → ${whole === expectWhole ? '✅ 与官方一致' : '❌ 不一致'}`)
writeFileSync(jsonFile, JSON.stringify({ at: new Date().toISOString(), results, merged, whole, ok: whole === expectWhole }, null, 2) + '\n', 'utf8')
console.log(`\n证据：${jsonFile}`)
process.exit(whole === expectWhole ? 0 : 1)
