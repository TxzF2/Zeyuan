// 发布流水线 / 下载页测试（不联网、不依赖 GitHub）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const rel = await import(pathToFileURL(resolve(ROOT, 'scripts/release.mjs')).href)

const dist = { version: '9.9.9', buildDate: '20991231', arch: 'x64', filePattern: 'zeyuan-{form}-v{version}-{date}-{arch}.{ext}' }

test('release: zip 名称按规则拼装', () => {
  assert.equal(rel.zipName(dist), 'zeyuan-portable-v9.9.9-20991231-x64.zip')
})

test('release: 下载页包含版本/日期/哈希前 8 位/直链/归档/镜像 TODO', () => {
  const hash = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789'
  const html = rel.renderDownloadPage({ dist, repo: 'zeyuan-org/zeyuan', hash, size: 149.35 * 1024 * 1024 })
  assert.ok(html.includes('v9.9.9'), '含版本号')
  assert.ok(html.includes('20991231'), '含发布日期')
  assert.equal(rel.sha8(hash), 'ABCDEF01')
  assert.ok(html.includes('ABCDEF01'), '含哈希前 8 位')
  assert.ok(html.includes('https://github.com/zeyuan-org/zeyuan/releases/latest/download/zeyuan-portable-v9.9.9-20991231-x64.zip'), '含下载直链')
  assert.ok(html.includes('https://github.com/zeyuan-org/zeyuan/releases'), '含历史归档链接')
  assert.ok(html.includes('国内镜像：'), '含镜像说明')
  assert.ok(html.includes('待总控决策'), '镜像升级为待决策项（D-009）')
  assert.ok(html.includes('Get-FileHash'), '含哈希核对指引')
  assert.ok(html.includes('zeyuan-installer.exe'), '含安装步骤')
})

test('release: 真实产物能生成下载页（写到临时文件，不污染 docs）', { skip: !existsSync(join(ROOT, 'packaging/artifacts/交付')) }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'zeyuan-page-'))
  try {
    const out = join(tmp, 'download.html')
    const r = rel.writePage({ repo: 'zeyuan-org/zeyuan', pageOut: out })
    assert.ok(existsSync(out))
    const html = readFileSync(out, 'utf8')
    assert.ok(html.includes(`v${r.version}`), '版本号应来自 distribution.json')
    assert.equal(html.includes(r.hash), true, '完整哈希应出现在页面')
    assert.equal(r.hash8.length, 8)
    assert.ok(html.includes('github.com/zeyuan-org/zeyuan/releases/latest/download/'), '直链')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('release: 未配置仓库时回落占位符（不崩）', () => {
  const repo = rel.resolveRepo('')
  assert.equal(typeof repo, 'string')
  assert.ok(repo.length > 0)
})
