#!/usr/bin/env node
/**
 * aliyunpan-upload.mjs · 阿里云盘上传 + 生成分享链接（全自动）
 * ---------------------------------------------------------------------------
 * 用法（token 走文件或环境变量，避免进 shell 历史）：
 *   node scripts/aliyunpan-upload.mjs --token-file "%LOCALAPPDATA%\zeyuan\.aliyun-token" --file "<zip>"
 *   ALIYUNPAN_REFRESH_TOKEN=eyJ... node scripts/aliyunpan-upload.mjs --file "<zip>"
 *
 * 可选：
 *   --name <云端文件名>        默认用本地文件名
 *   --chunk-mb <n>             分片大小，默认 10
 *   --share                   完成后创建分享链接（默认开）
 *   --share-pwd <4位>          默认随机 4 位
 *   --client-id <id>           默认公共 Web 客户端值
 *   --dry                     只换 token + 查 drive，不上传
 *
 * 输出：file_id / share_url / share_pwd / 证据 JSON（不打印 token）
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const API = 'https://openapi.alipan.com'
const DEFAULT_CLIENT_ID = '76917ccccbe74a8aa4a6b2bcd3f93e26'

const args = process.argv.slice(2)
const val = (f, d) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const has = (f) => args.includes(f)

const file = val('--file')
const tokenFile = val('--token-file')
const clientId = val('--client-id', DEFAULT_CLIENT_ID)
const chunkMb = Number(val('--chunk-mb', '10'))
const doShare = !has('--no-share')
const dry = has('--dry')
const sharePwd = val('--share-pwd') ?? String(Math.floor(1000 + Math.random() * 9000))

let refreshToken = process.env.ALIYUNPAN_REFRESH_TOKEN ?? ''
if (!refreshToken && tokenFile) {
  const p = resolve(tokenFile.replace(/^%LOCALAPPDATA%/, process.env.LOCALAPPDATA ?? ''))
  if (!existsSync(p)) {
    console.error(`❌ token 文件不存在：${p}`)
    process.exit(1)
  }
  refreshToken = readFileSync(p, 'utf8').trim()
}
if (!refreshToken) {
  console.error('❌ 缺 refresh_token：用 --token-file 或环境变量 ALIYUNPAN_REFRESH_TOKEN')
  process.exit(1)
}
if (!refreshToken.startsWith('eyJ')) {
  console.warn('⚠️ token 不是 eyJ 开头，阿里云盘 refresh_token 通常是 eyJ 长串；先试，失败看返回')
}
if (!file || !existsSync(resolve(file))) {
  console.error('❌ 缺 --file（要上传的本地文件）')
  process.exit(1)
}

process.on('unhandledRejection', (err) => {
  console.error('\n❌ 失败：' + (err && err.message ? err.message : err))
  process.exit(1)
})

const localPath = resolve(file)
const size = statSync(localPath).size
const name = val('--name') ?? basename(localPath)
console.log(`本地文件：${localPath}（${(size / 1024 / 1024).toFixed(2)} MB）`)

async function api(path, { method = 'POST', body, token, query } = {}) {
  const url = new URL(API + path)
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${json?.code ?? ''} ${json?.message ?? text.slice(0, 200)}`)
  }
  return json
}

// 1) 换 access_token
console.log('\n[1/5] 换 access_token…')
const tokenRes = await api('/oauth/access_token', {
  body: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
})
const accessToken = tokenRes.access_token
const refreshTokenNew = tokenRes.refresh_token ?? refreshToken
const driveId = tokenRes.drive_id ?? tokenRes.default_drive_id
console.log(`  ✅ 拿到 access_token（${accessToken?.length ?? 0} 字符），drive_id=${driveId}`)
// 回写新 refresh_token（阿里云盘会轮换）
if (tokenFile) {
  const p = resolve(tokenFile.replace(/^%LOCALAPPDATA%/, process.env.LOCALAPPDATA ?? ''))
  writeFileSync(p, refreshTokenNew, 'utf8')
  console.log('  ↻ refresh_token 已轮换并回写本机文件')
}

// 2) drive 信息
console.log('[2/5] 查 drive…')
const driveInfo = await api('/adrive/v1.0/user/getDriveInfo', { method: 'GET', token: accessToken })
const rootDrive = driveId ?? driveInfo?.resource_drive_id ?? driveInfo?.default_drive_id
console.log(`  ✅ resource_drive_id=${rootDrive}`)
if (dry) {
  console.log('\n（--dry：到此为止）')
  process.exit(0)
}

// 3) 创建文件（分片）
const chunk = chunkMb * 1024 * 1024
const parts = Math.ceil(size / chunk)
console.log(`[3/5] 创建文件（${parts} 片 × ${chunkMb} MB）…`)
const createRes = await api('/adrive/v1.0/openFile/create', {
  token: accessToken,
  body: {
    drive_id: rootDrive,
    parent_file_id: 'root',
    name,
    type: 'file',
    check_name_mode: 'auto_rename',
    size,
    part_info_list: Array.from({ length: parts }, (_, i) => ({ part_number: i + 1 })),
  },
})
const fileId = createRes.file_id
const uploadId = createRes.upload_id
const uploadUrls = (createRes.part_info_list ?? []).map((p) => p.upload_url)
console.log(`  ✅ file_id=${fileId} upload_id=${uploadId}，分片 URL ${uploadUrls.length} 个`)
if (!uploadUrls.length) throw new Error('create 未返回 upload_url')

// 4) 上传分片
console.log('[4/5] 上传分片…')
const fd = openSync(localPath, 'r')
const buf = Buffer.alloc(chunk)
for (let i = 0; i < uploadUrls.length; i++) {
  const offset = i * chunk
  const len = Math.min(chunk, size - offset)
  readSync(fd, buf, 0, len, offset)
  const body = buf.subarray(0, len)
  const r = await fetch(uploadUrls[i], { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } })
  if (!r.ok) {
    closeSync(fd)
    throw new Error(`分片 ${i + 1}/${uploadUrls.length} 上传失败：HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  }
  const done = Math.min(size, offset + len)
  console.log(`  ✓ 分片 ${i + 1}/${uploadUrls.length}（${(done / 1024 / 1024).toFixed(1)} MB / ${(size / 1024 / 1024).toFixed(1)} MB）`)
}
closeSync(fd)

// 5) 完成 + 分享
console.log('[5/5] 完成上传…')
await api('/adrive/v1.0/openFile/complete', { token: accessToken, body: { drive_id: rootDrive, file_id: fileId, upload_id: uploadId } })
console.log('  ✅ 上传完成')

let share = null
if (doShare) {
  console.log('  创建分享链接…')
  try {
    const s = await api('/adrive/v1.0/openFile/share', {
      token: accessToken,
      body: { drive_id: rootDrive, file_id_list: [fileId], share_pwd: sharePwd, expiration: '7D' },
    })
    share = { url: s.share_url ?? s.shareUrl, pwd: s.share_pwd ?? sharePwd, shareId: s.share_id }
    console.log(`  ✅ 分享：${share.url}  提取码：${share.pwd}`)
  } catch (err) {
    console.warn(`  ⚠️ 分享接口失败（不影响文件已上传）：${err.message}`)
    console.warn('     → 可人工点一次"分享"，或稍后我换接口重试')
  }
}

// 证据
const evDir = join(ROOT, '交付', 'evidence')
mkdirSync(evDir, { recursive: true })
const evFile = join(evDir, `aliyun-upload-${Date.now()}.json`)
const sha = createHash('sha256').update(readFileSync(localPath)).digest('hex')
writeFileSync(
  evFile,
  JSON.stringify(
    { at: new Date().toISOString(), file: localPath, name, size, sha256: sha, driveId: rootDrive, fileId, share, clientId, tokenRotated: Boolean(tokenFile) },
    null,
    2,
  ) + '\n',
  'utf8',
)
console.log(`\n📄 证据：${evFile}`)
if (share?.url) {
  console.log(`\n下一步：node scripts/pan-go-live.mjs --url "${share.url}" --code "${share.pwd}"`)
} else {
  console.log('\n⚠️ 未拿到分享链接，请人工在网盘里分享一次后告诉我链接与提取码')
}
