#!/usr/bin/env node
/** test-console-profile.mjs · 板块真启停（写 profile / 备份 / 保护 / 回滚） */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASE = mkdtempSync(join(tmpdir(), 'dsh-console-profile-'))
const STATE = join(BASE, 'state')
const PROFILE = join(BASE, 'profile')
mkdirSync(STATE, { recursive: true })
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
process.env.DSH_TRAINING_STATE_DIR = STATE
process.env.DSH_TRAINING_PROFILE_DIR = PROFILE

// 造一个"已安装"的插件目录
const PKG = 'zeyuan-tasks'
mkdirSync(join(STATE, 'app', 'plugins', PKG, 'dist'), { recursive: true })
writeFileSync(join(STATE, 'app', 'plugins', PKG, 'dist', 'index.js'), 'export function apply() {}\n', 'utf8')
writeFileSync(join(STATE, 'app', 'plugins', PKG, 'package.json'), JSON.stringify({ name: PKG, version: '0.1.0' }), 'utf8')

function writeProfile(bundles, deps = {}) {
  writeFileSync(
    join(PROFILE, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: deps, dsh: { profile: { bundles } } }, null, 2) + '\n',
    'utf8',
  )
}
writeProfile(['@deepseek-ai/dsh-base'])

const pg = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-console/dist/profile-gate.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${typeof actual === 'object' ? JSON.stringify(actual) : actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const codeOf = (fn) => {
  try {
    fn()
    return 'NO_ERROR'
  } catch (err) {
    return err.code ?? err.message
  }
}
const readP = () => JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))

try {
  console.log('=== 1 · 初始 ===')
  check('未启用', pg.isPluginEnabled(PKG), false)

  console.log('\n=== 2 · 启用 ===')
  const r1 = pg.setPluginEnabled(PKG, true)
  check('changed', r1.changed, true)
  check('需要重启', r1.restartRequired, true)
  check('dependencies 写入', Boolean(readP().dependencies[PKG]), true)
  check('link 指向安装目录', readP().dependencies[PKG].includes('app/plugins'), true)
  check('bundles 追加', readP().dsh.profile.bundles.includes(PKG), true)
  check('node_modules 链接存在', existsSync(join(PROFILE, 'node_modules', PKG)), true)
  check('备份已生成', readdirSync(PROFILE).filter((f) => f.includes('.bak-')).length, 1)
  check('再次启用幂等', pg.setPluginEnabled(PKG, true).changed, false)

  console.log('\n=== 3 · 停用 ===')
  const r2 = pg.setPluginEnabled(PKG, false)
  check('停用 changed', r2.changed, true)
  check('dependencies 移除', PKG in readP().dependencies, false)
  check('bundles 移除', readP().dsh.profile.bundles.includes(PKG), false)
  check('node_modules 链接移除', existsSync(join(PROFILE, 'node_modules', PKG)), false)

  console.log('\n=== 4 · 保护 ===')
  check('停用 protocol → E-1106', codeOf(() => pg.setPluginEnabled('zeyuan-protocol', false)), 'E-1106')

  console.log('\n=== 5 · 备份上限 ===')
  for (let i = 0; i < 5; i++) {
    pg.setPluginEnabled(PKG, i % 2 === 0)
    pg.setPluginEnabled(PKG, i % 2 !== 0 ? false : true)
  }
  const backups = readdirSync(PROFILE).filter((f) => f.includes('.bak-')).length
  check('备份 ≤ 3', backups <= pg.MAX_BACKUPS, true)

  console.log('\n=== 6 · 失败回滚 ===')
  writeProfile(['@deepseek-ai/dsh-base']) // 干净起点
  rmSync(join(PROFILE, 'node_modules'), { recursive: true, force: true })
  writeFileSync(join(PROFILE, 'node_modules'), 'i am a file', 'utf8') // 让 symlink 失败
  const code = codeOf(() => pg.setPluginEnabled(PKG, true))
  check('创建链接失败会报错（任一错误码）', code !== 'NO_ERROR', true)
  const after = readP()
  check('失败后 dependencies 未残留', PKG in after.dependencies, false)
  check('失败后 bundles 未残留', after.dsh.profile.bundles.includes(PKG), false)
} finally {
  rmSync(BASE, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
