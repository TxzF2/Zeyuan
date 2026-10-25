#!/usr/bin/env node
/**
 * release.mjs · 泽元发版流水线（P2.8）
 * ---------------------------------------------------------------------------
 * 一条命令：校验产物 → 生成下载页 → 打 tag →（可选）推 GitHub →（可选）传 Release 资产
 *
 * 用法：
 *   node scripts/release.mjs                     # dry-run：只打印计划
 *   node scripts/release.mjs --page-only         # 只重新生成 docs/download.html
 *   node scripts/release.mjs --apply             # 校验 + 生成下载页 + 本地打 tag
 *   node scripts/release.mjs --apply --push      # 再把 commit/tag 推到 origin
 *   node scripts/release.mjs --apply --publish   # 再用 gh 创建 Release 并传资产
 *
 * 仓库地址来源：--repo owner/repo > git remote origin > 环境 ZEYUAN_REPO > 占位符
 * 依赖：git；--publish 需要 gh（GitHub CLI）且已登录
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')
export const ARTIFACTS = join(REPO_ROOT, 'packaging', 'artifacts')
export const DELIVERY = join(ARTIFACTS, '交付')
export const DIST_JSON = join(REPO_ROOT, 'packaging', 'distribution.json')
export const PAGE_OUT = join(REPO_ROOT, 'docs', 'download.html')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const flagValue = (f) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

export function readDist() {
  const d = JSON.parse(readFileSync(DIST_JSON, 'utf8'))
  return { version: d.version, buildDate: d.buildDate, arch: d.arch ?? 'x64', filePattern: d.filePattern }
}

export function zipName(dist) {
  return dist.filePattern
    .replace('{form}', 'portable')
    .replace('{version}', dist.version)
    .replace('{date}', dist.buildDate)
    .replace('{arch}', dist.arch)
    .replace('{ext}', 'zip')
}

export function findZip(dist) {
  const name = zipName(dist)
  if (!existsSync(DELIVERY)) return null
  for (const dir of readdirSync(DELIVERY)) {
    const p = join(DELIVERY, dir, name)
    if (existsSync(p)) return p
  }
  return null
}

export function sha256(file) {
  const h = createHash('sha256')
  h.update(readFileSync(file))
  return h.digest('hex')
}

export function sha8(hash) {
  return String(hash ?? '').slice(0, 8).toUpperCase()
}

export function resolveRepo(explicit) {
  if (explicit) return explicit
  if (process.env.ZEYUAN_REPO) return process.env.ZEYUAN_REPO
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)
    if (m) return m[1]
  } catch {
    /* 无 remote */
  }
  return 'YOUR_GITHUB/zeyuan'
}

const fmtMB = (n) => (n / 1024 / 1024).toFixed(2)

/** 生成静态下载页（纯 HTML，随 docs 进 GitHub Pages） */
export function renderDownloadPage({ dist, repo, hash, size, upgradeText = '' }) {
  const zip = zipName(dist)
  const tag = `v${dist.version}`
  const latestUrl = `https://github.com/${repo}/releases/latest`
  const directUrl = `https://github.com/${repo}/releases/latest/download/${zip}`
  const archiveUrl = `https://github.com/${repo}/releases`
  const h8 = sha8(hash)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>泽元 · 下载</title>
<style>
  :root { --ink:#0b1a14; --ink2:#10241b; --line:#24483a; --text:#e8f3ec; --muted:#8fae9e; --gold:#d4c07a; --green:#57d68b; }
  * { box-sizing: border-box; }
  body { margin:0; background: radial-gradient(1200px 600px at 20% -10%, #14352a 0%, var(--ink) 60%); color:var(--text);
         font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; min-height:100vh; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
  .brand { display:flex; align-items:center; gap:10px; color:var(--gold); letter-spacing:2px; font-weight:600; }
  .brand span { width:10px; height:10px; border-radius:50%; background:var(--gold); box-shadow:0 0 18px var(--gold); }
  h1 { font-size: 28px; margin: 18px 0 6px; }
  .sub { color:var(--muted); font-size:14px; }
  .card { border:1px solid var(--line); background:var(--ink2); border-radius:14px; padding:20px; margin-top:22px; }
  .row { display:flex; gap:18px; flex-wrap:wrap; font-size:13px; color:var(--muted); }
  .row b { color:var(--text); font-weight:600; }
  .btn { display:inline-block; margin-top:16px; padding:12px 22px; border-radius:10px; background:var(--green);
         color:#062016; font-weight:700; text-decoration:none; }
  .btn.secondary { background:transparent; color:var(--text); border:1px solid var(--line); margin-left:10px; }
  .hash { margin-top:14px; font-family: ui-monospace, Consolas, monospace; font-size:13px; color:var(--gold);
          word-break: break-all; }
  .hint { margin-top:10px; font-size:12.5px; color:var(--muted); line-height:1.7; }
  pre { background:#0a1712; border:1px solid var(--line); border-radius:10px; padding:12px; overflow:auto; font-size:12.5px; }
  .todo { margin-top:18px; padding:10px 12px; border:1px dashed var(--line); border-radius:10px;
          color:var(--muted); font-size:12.5px; }
  a { color: var(--gold); }
  footer { margin-top:28px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span></span>泽元 · ZEYUAN</div>
  <h1>下载泽元</h1>
  <div class="sub">便携版 · 解压即用 · 内置安装向导</div>

  <div class="card">
    <div class="row">
      <div>最新版本 <b>${tag}</b></div>
      <div>发布日期 <b>${dist.buildDate}</b></div>
      <div>大小 <b>${fmtMB(size)} MB</b></div>
      <div>平台 <b>Windows ${dist.arch}</b></div>
    </div>

    <a class="btn" href="${directUrl}">下载 ${zip}</a>
    <a class="btn secondary" href="${latestUrl}">查看 Release</a>

    <div class="hash">SHA256（前 8 位）：<b>${h8}</b></div>
    <div class="hint">
      完整哈希：<span style="font-family:ui-monospace,Consolas,monospace">${hash}</span><br />
      下载后请核对，命令（PowerShell）：<br />
      <code>Get-FileHash .\\${zip} -Algorithm SHA256</code>
    </div>
  </div>

  <div class="card">
    <div style="font-weight:600;margin-bottom:6px">安装步骤</div>
    <div class="hint">
      1. 解压 zip；<br />
      2. 双击 <code>zeyuan-installer.exe</code>，按向导选择安装目录；<br />
      3. 启动后进入 <b>设置 → 泽元 · 协议授权</b> 签署协议；<br />
      4. 面板：任务接发 / 工作台 / 社区 / 协作分组 / 泽元中转站。
    </div>
    ${upgradeText ? `<div class="hint" style="margin-top:12px">${upgradeText}</div>` : ''}
  </div>

  <div class="card">
    <div style="font-weight:600;margin-bottom:6px">历史版本</div>
    <div class="hint">
      所有版本与哈希集中在 <a href="${archiveUrl}">Releases 归档</a>。旧版升级前请先读《升级说明》。
    </div>
  </div>

  <div class="todo">
    国内镜像：<b>待总控决策</b>（Gitee 注册需手机号实名，涉及账号归属，明日议）。<br />
    raw 链接若打不开，请改用<b>仓库文件页</b>下载：<a href="https://github.com/${repo}/tree/main/releases/v${dist.version}">releases / v${dist.version}</a>（点文件 → Download）。
  </div>

  <footer>泽元 · 下载页由 scripts/release.mjs 生成，随 docs 一起发布到 GitHub Pages。</footer>
</div>
</body>
</html>
`
}

/** 只生成下载页 */
export function writePage({ repo, pageOut = PAGE_OUT } = {}) {
  const dist = readDist()
  const zip = findZip(dist)
  if (!zip) throw new Error(`找不到产物：${zipName(dist)}（先跑 node packaging/scripts/build.mjs --stage 2）`)
  const hash = sha256(zip)
  let html = renderDownloadPage({ dist, repo: repo ?? resolveRepo(flagValue('--repo')), hash, size: statSync(zip).size })
  const partsBlock = buildPartsBlock({ dist, repo: repo ?? resolveRepo(flagValue('--repo')) })
  if (partsBlock) html = html.replace('<footer>', partsBlock + '\n\n  <footer>')
  writeFileSync(pageOut, html, 'utf8')
  return { page: pageOut, version: dist.version, buildDate: dist.buildDate, hash, hash8: sha8(hash), zip }
}

/** 分卷下载区块：读 releases/v<ver>/PARTS.txt，生成 raw 链接与合并说明 */
export function buildPartsBlock({ dist, repo }) {
  const dir = join(REPO_ROOT, 'releases', `v${dist.version}`)
  const manifest = join(dir, 'PARTS.txt')
  if (!existsSync(manifest)) return ''
  const rows = readFileSync(manifest, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((c) => c.length === 3)
  if (rows.length === 0) return ''
  const rawBase = `https://raw.githubusercontent.com/${repo}/main/releases/v${dist.version}`
  const link = (name) => `${rawBase}/${encodeURIComponent(name)}`
  const items = rows
    .map(([name, size, sha]) => `<li><a href="${link(name)}">${name}</a> <span style="color:var(--muted)">${(Number(size) / 1024 / 1024).toFixed(2)} MB · sha256 ${sha.slice(0, 12)}…</span></li>`)
    .join('')
  return `  <div class="card" id="parts">
    <div style="font-weight:600;margin-bottom:6px">分卷下载（当前网络首选）</div>
    <div class="hint">整包 ${rows.length} 卷（每卷 ≤25MB）。全部下完后按下面教程合并，合并结果必须与上方 SHA256 一致。</div>
    <ul style="font-size:13px;line-height:1.9;margin:10px 0 4px;padding-left:20px">${items}</ul>
    <div class="hint">配套文件：<a href="${link('merge.cmd')}">merge.cmd</a> · <a href="${link('merge.ps1')}">merge.ps1</a> · <a href="${link('PARTS.txt')}">PARTS.txt</a> · <a href="${link('README.md')}">合并教程</a></div>
    <div style="margin-top:12px"><img src="assets/merge-tutorial.png" alt="合并教程" style="width:100%;border:1px solid var(--line);border-radius:10px" /></div>
    <pre>copy /b zeyuan-v${dist.version}-part1.zip + zeyuan-v${dist.version}-part2.zip + ... + zeyuan-v${dist.version}-part${rows.length}.zip zeyuan-portable.zip</pre>
    <div class="hint">合并后校验：<code>Get-FileHash zeyuan-portable.zip -Algorithm SHA256</code></div>
  </div>`
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('release.mjs')
if (isMain) {
  const dist = readDist()
  const repo = resolveRepo(flagValue('--repo'))
  const zip = findZip(dist)
  const tag = `v${dist.version}`

  console.log('=== 泽元发版计划 ===')
  console.log(`  版本      : ${tag}（${dist.buildDate}）`)
  console.log(`  仓库      : ${repo}${repo.startsWith('YOUR_GITHUB') ? '  ⚠️ 尚未配置（等 GitHub 地址）' : ''}`)
  console.log(`  产物      : ${zip ? zip.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', '') + '  ' + fmtMB(statSync(zip).size) + ' MB' : '❌ 缺失'}`)
  console.log(`  下载页    : docs/download.html`)

  if (has('--page-only')) {
    const r = writePage({ repo })
    console.log(`\n✅ 已生成下载页：${r.page}`)
    console.log(`   版本 ${r.version} / 哈希前 8 位 ${r.hash8}`)
  } else if (!has('--apply')) {
    console.log('\n步骤（dry-run，未执行）：')
    console.log('  1. 校验产物存在 + 计算 SHA256')
    console.log('  2. 生成 docs/download.html（含版本/日期/哈希前 8 位/直链）')
    console.log(`  3. git tag -a ${tag} -m "泽元 ${tag}"`)
    if (has('--push')) console.log(`  4. git push origin main + git push origin ${tag}`)
    if (has('--publish')) console.log(`  5. gh release create ${tag} --title ... --notes-file 升级说明.md + 上传 zip/SHA256SUMS/升级说明.md`)
    console.log('\n加 --apply 执行 1–3；加 --push / --publish 继续。')
  } else {
    if (!zip) {
      console.error('\n❌ 产物缺失，先执行：node packaging/scripts/build.mjs --stage 2')
      process.exit(1)
    }
    const r = writePage({ repo })
    console.log(`\n✅ 1. 产物校验通过：sha256=${r.hash}`)
    console.log(`✅ 2. 下载页已生成：${r.page}（哈希前 8 位 ${r.hash8}）`)

    try {
      execFileSync('git', ['rev-parse', tag], { cwd: REPO_ROOT, stdio: 'ignore' })
      console.log(`⚠️ 3. tag ${tag} 已存在，跳过`)
    } catch {
      execFileSync('git', ['tag', '-a', tag, '-m', `泽元 ${tag}`], { cwd: REPO_ROOT })
      console.log(`✅ 3. 已打 tag：${tag}`)
    }

    if (has('--push')) {
      execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' })
      execFileSync('git', ['push', 'origin', tag], { cwd: REPO_ROOT, stdio: 'inherit' })
      console.log('✅ 4. 已推送到 origin')
    }

    if (has('--publish')) {
      const assets = [zip]
      // 交付目录里历史命名是 SHA256校验.txt，也兼容 SHA256SUM.txt
      for (const name of readdirSync(dirname(zip))) {
        if (/^SHA256/i.test(name)) assets.push(join(dirname(zip), name))
      }
      const upgrade = join(dirname(zip), '升级说明.md')
      if (existsSync(upgrade)) assets.push(upgrade)
      execFileSync('gh', ['release', 'create', tag, '--title', `泽元 ${tag}`, '--notes-file', existsSync(upgrade) ? upgrade : 'README.md', ...assets], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      })
      console.log('✅ 5. Release 已创建并上传资产')
    }
  }
}
