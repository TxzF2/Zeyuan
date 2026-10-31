/**
 * pan-block.mjs · 下载页「网盘备用通道」区块生成器
 * ---------------------------------------------------------------------------
 * 读 docs/download-links.json（总控上传网盘后填 url/code 即可）
 * 返回 HTML 片段；未配置时显示"链接待补入"占位（不隐藏区块，保留位置）
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readLinks(rootDir) {
  const p = join(rootDir, 'docs', 'download-links.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {object} o
 * @param {string} o.rootDir  仓库根
 * @param {string} o.repo     owner/repo
 * @param {object} o.dist     { version, buildDate }
 * @param {string} o.sha8     完整包 SHA256 前 8 位（大写）
 * @returns {string} HTML 片段（无配置时返回空串）
 */
export function buildPanBlock({ rootDir, repo, dist, sha8 }) {
  const cfg = readLinks(rootDir)
  if (!cfg) return ''
  const pan = cfg.pan ?? {}
  const mirror = cfg.mirror ?? {}
  const hasUrl = typeof pan.url === 'string' && pan.url.trim().length > 0
  const label = pan.label || '网盘'

  const linkHtml = hasUrl
    ? `<a href="${pan.url}" target="_blank" rel="noopener">打开 ${label}分享页</a>`
    : '<span style="color:var(--muted)">链接待总控上传后补入（位置已预留）</span>'

  const codeHtml =
    hasUrl && pan.code
      ? `<div style="margin-top:4px">提取码：<b style="font-family:ui-monospace,Consolas,monospace;color:var(--gold)">${pan.code}</b>（先复制提取码，再打开链接）</div>`
      : ''

  const noteHtml = pan.note ? `<div class="hint" style="margin-top:2px">${pan.note}</div>` : ''

  const mirrorHtml = mirror.url
    ? `<a href="${mirror.url}" target="_blank" rel="noopener">${mirror.label || '镜像'}</a>`
    : `<span style="color:var(--muted)">${mirror.label || 'Gitee 镜像'}：${mirror.status || '立项中'}</span>`

  const tutorialUrl = `https://github.com/${repo}/blob/main/releases/v${dist.version}/README.md`

  return `  <div class="card" id="pan">
    <div style="font-weight:600;margin-bottom:6px">网盘备用下载（国内网络推荐）</div>
    <div class="hint" style="margin-bottom:8px">GitHub 直连在国内常被限速或截断，优先用网盘整包下载；下完直接解压安装，<b>不需要合并分卷</b>。</div>
    <div style="font-size:13.5px;line-height:2">
      <div>① ${linkHtml}</div>
      ${codeHtml}
      ${noteHtml}
      <div>② 下载后校验：整包 SHA256 前 8 位应为 <b style="color:var(--gold)">${sha8}</b>（完整值见上方卡片）</div>
      <div>③ 镜像通道：${mirrorHtml}</div>
      <div>④ 若仍用分卷：合并教程见 <a href="${tutorialUrl}" target="_blank" rel="noopener">releases/v${dist.version}/README.md</a></div>
    </div>
  </div>`
}
