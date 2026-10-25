#!/usr/bin/env node
/**
 * publish-release.mjs · 无 gh 也能发版（GitHub REST + token）
 * ---------------------------------------------------------------------------
 * 依赖：只有 git 与 GITHUB_TOKEN（或 GH_TOKEN）
 * 做的事：
 *   1) 用 token 推送 main 与 tag（https://x-access-token:<token>@github.com/...）
 *   2) 创建/复用 Release v<版本>
 *   3) 上传资产：zip / SHA256 校验文件 / 升级说明.md
 *
 * 用法：
 *   $env:GITHUB_TOKEN = "ghp_xxx"
 *   node scripts/publish-release.mjs                 # dry-run：只检查 token/资产/将做什么
 *   node scripts/publish-release.mjs --apply         # 真执行（推送 + Release + 上传）
 *   node scripts/publish-release.mjs --apply --no-push   # 只建 Release 不推送
 *
 * 网络不稳：自带重试（3 次，指数退避），408/5xx 视为可重试
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')
const DELIVERY_ROOT = join(REPO_ROOT, 'packaging', 'artifacts', '交付')
const DIST_JSON = join(REPO_ROOT, 'packaging', 'distribution.json')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const flagValue = (f) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

export function readDist() {
  return JSON.parse(readFileSync(DIST_JSON, 'utf8'))
}

export function zipName(dist) {
  return dist.filePattern
    .replace('{form}', 'portable')
    .replace('{version}', dist.version)
    .replace('{date}', dist.buildDate)
    .replace('{arch}', dist.arch ?? 'x64')
    .replace('{ext}', 'zip')
}

export function resolveRepo(explicit) {
  if (explicit) return explicit
  if (process.env.ZEYUAN_REPO) return process.env.ZEYUAN_REPO
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)
    if (m) return m[1]
  } catch {
    /* ignore */
  }
  return null
}

/** 收集待上传资产：zip + SHA256 文件 + 升级说明 */
export function collectAssets(dist) {
  const zip = zipName(dist)
  const dir = join(DELIVERY_ROOT, `泽元-便携版-v${dist.version}-${dist.buildDate}`)
  const assets = []
  const push = (name) => {
    const p = join(dir, name)
    if (existsSync(p)) assets.push(p)
  }
  push(zip)
  for (const name of ['SHA256校验.txt', 'SHA256SUM.txt', '升级说明.md']) push(name)
  return { dir, assets }
}

export function tokenOf() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retriable = /408|429|5\d\d|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(String(err.message))
      if (i === attempts || !retriable) break
      console.log(`   ↻ ${label} 第 ${i} 次失败（${String(err.message).slice(0, 60)}），${300 * i}ms 后重试`)
      sleep(300 * i)
    }
  }
  throw lastErr
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'zeyuan-release',
      ...headers,
    },
    ...(body ? { body } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${path} ${text.slice(0, 200)}`)
  }
  return res.status === 204 ? null : await res.json()
}

async function uploadAsset(repo, releaseId, file, token) {
  const name = basename(file)
  const data = readFileSync(file)
  const res = await fetch(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(data.length),
      'user-agent': 'zeyuan-release',
    },
    body: data,
  })
  if (res.status === 422) return { skipped: true, name }
  if (!res.ok) throw new Error(`上传 ${name} 失败：HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`)
  return { skipped: false, name }
}

async function main() {
  const dist = readDist()
  const tag = `v${dist.version}`
  const repo = resolveRepo(flagValue('--repo'))
  const token = tokenOf()
  const { dir, assets } = collectAssets(dist)

  console.log('=== 发布计划 ===')
  console.log(`  仓库   : ${repo ?? '❌ 未配置'}`)
  console.log(`  版本   : ${tag}（${dist.buildDate}）`)
  console.log(`  资产目录: ${dir}`)
  for (const a of assets) console.log(`    - ${basename(a)}（${(readFileSync(a).length / 1024 / 1024).toFixed(2)} MB）`)
  console.log(`  token  : ${token ? `已提供（${token.length} 字符）` : '❌ 未提供（GITHUB_TOKEN）'}`)

  if (!has('--apply')) {
    console.log('\n步骤（dry-run）：')
    console.log('  1. git push main + tag（用 token，免交互）')
    console.log(`  2. 创建/复用 Release ${tag}`)
    console.log(`  3. 上传 ${assets.length} 个资产`)
    console.log('\n加 --apply 执行。')
    return
  }
  if (!repo) throw new Error('未配置仓库：加 --repo owner/repo 或设置 remote')
  if (!token) throw new Error('缺少 GITHUB_TOKEN：\n  $env:GITHUB_TOKEN = "ghp_xxx"（仅当前窗口）\n  或 [Environment]::SetEnvironmentVariable("GITHUB_TOKEN","ghp_xxx","User")')
  if (assets.length === 0) throw new Error('没有可上传资产：先 node packaging/scripts/build.mjs --stage 2')

  // 1) 推送
  if (!has('--no-push')) {
    const url = `https://x-access-token:${token}@github.com/${repo}.git`
    console.log('\n[1/3] 推送 main 与 tag…')
    await withRetry('push main', async () => execFileSync('git', ['push', url, 'main'], { cwd: REPO_ROOT, stdio: 'inherit' }))
    await withRetry('push tag', async () => execFileSync('git', ['push', url, tag], { cwd: REPO_ROOT, stdio: 'inherit' }))
    console.log('  ✅ 已推送')
  } else {
    console.log('\n[1/3] 跳过推送（--no-push）')
  }

  // 2) Release
  console.log(`[2/3] 创建/复用 Release ${tag}…`)
  let release = null
  try {
    release = await withRetry('get release', () => api(`/repos/${repo}/releases/tags/${tag}`, { token }))
    console.log(`  ↺ 已存在：${release.html_url}`)
  } catch {
    const upgrade = assets.find((a) => a.endsWith('升级说明.md'))
    const bodyMarkdown = upgrade ? readFileSync(upgrade, 'utf8') : `泽元 ${tag}`
    release = await withRetry('create release', () =>
      api(`/repos/${repo}/releases`, {
        method: 'POST',
        token,
        body: JSON.stringify({ tag_name: tag, name: `泽元 ${tag}`, body: bodyMarkdown, draft: false, prerelease: false }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    console.log(`  ✅ 已创建：${release.html_url}`)
  }

  // 3) 上传
  console.log(`[3/3] 上传 ${assets.length} 个资产…`)
  for (const file of assets) {
    const r = await withRetry(`upload ${basename(file)}`, () => uploadAsset(repo, release.id, file, token))
    console.log(`  ${r.skipped ? '↺ 已存在跳过' : '✅ 已上传'}：${r.name}`)
  }

  console.log('\n=== 完成 ===')
  console.log(`  Release : ${release.html_url}`)
  console.log(`  直链    : https://github.com/${repo}/releases/latest/download/${zipName(dist)}`)
  console.log(`  下载页  : https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/download.html`)
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('publish-release.mjs')
if (isMain) {
  main().catch((err) => {
    console.error('\n❌ ' + err.message)
    process.exit(1)
  })
}
