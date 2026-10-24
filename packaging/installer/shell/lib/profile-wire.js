/**
 * profile-wire.js · DSH profile 写入/撤回（纯 Node，可单测）
 * ---------------------------------------------------------------------------
 * 为什么单独一层：安装器要把「核心板块」接进 DSH 的 profile，而 profile 在
 * 安装目录之外，属于**外部副作用**，必须能幂等、能备份、能回滚、能撤回。
 *
 * profile 结构（DSH）：
 *   { "dependencies": { "pkg": "link:<abs>" },
 *     "dsh": { "profile": { "bundles": ["pkg", ...] } } }
 *   —— 两条缺一不可：只写 dependencies 插件不会被加载（本项目已踩过）。
 *
 * 错误码：E-501 文件缺失 / E-502 JSON 非法 / E-503 写入被拒 / E-504 备份恢复失败
 * ---------------------------------------------------------------------------
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

class ProfileWireError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'ProfileWireError'
    this.code = code
    this.detail = detail ?? null
  }
}

const BUNDLE_KEY = 'dsh'
const PROFILE_KEY = 'profile'
const BUNDLES_KEY = 'bundles'

function pathsFor(profileDir) {
  const dir = path.resolve(profileDir)
  const file = path.join(dir, 'package.json')
  return { dir, file }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    throw new ProfileWireError('E-501', `找不到 profile 的 package.json：${file}`)
  }
  // 容忍 UTF-8 BOM：Windows 上手工编辑的配置文件经常带 BOM，
  // 而 JSON.parse 会直接抛错。剥掉 BOM 但不改写原文件。
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  try {
    return { json: JSON.parse(raw), raw }
  } catch (err) {
    throw new ProfileWireError('E-502', `profile 的 package.json 不是合法 JSON，已拒绝写入：${err.message}`)
  }
}

/** 备份（保留最近 3 份，避免堆垃圾） */
function backup(file) {
  const ts = stamp()
  const target = `${file}.bak-${ts}`
  fs.copyFileSync(file, target)
  const dir = path.dirname(file)
  const olds = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('package.json.bak-'))
    .sort()
  while (olds.length > 3) {
    const victim = path.join(dir, olds.shift())
    try {
      fs.rmSync(victim, { force: true })
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
  return target
}

/** 原子写：临时文件 + rename，避免写一半留下坏 JSON */
function writeJsonAtomic(file, json) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const text = JSON.stringify(json, null, 2) + '\n'
  // 写之前再校验一次，杜绝把坏数据落到磁盘
  JSON.parse(text)
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    const map = { EACCES: 'E-503', EPERM: 'E-503', EBUSY: 'E-503', EROFS: 'E-503' }
    throw new ProfileWireError(map[err.code] ?? 'E-503', `写入 profile 失败（${err.code ?? '未知'}）：${err.message}`, {
      errno: err.code,
    })
  }
}

function ensureShape(json) {
  if (!json.dsh || typeof json.dsh !== 'object') json.dsh = {}
  if (!json.dsh.profile || typeof json.dsh.profile !== 'object') json.dsh.profile = {}
  if (!Array.isArray(json.dsh.profile[BUNDLES_KEY])) json.dsh.profile[BUNDLES_KEY] = []
  if (!json.dependencies || typeof json.dependencies !== 'object') json.dependencies = {}
  return json
}

/**
 * 维护 profile/node_modules/<pkg> 的链接（Windows 用 junction，免管理员）。
 * 必须做：DSH 按 node_modules 里的包解析插件，而不是读 package.json 的 link:；
 * 只改 package.json 会出现「清单指向安装目录、实际仍加载仓库」的分裂（2026-10-24 踩到）。
 */
function ensureNodeModulesLink(profileDir, packageName, linkPath) {
  const nm = path.join(path.resolve(profileDir), 'node_modules')
  const target = path.join(nm, packageName)
  const desired = path.resolve(linkPath)

  // lstat 能识别"悬空 junction"（目标已不存在），realpath 不能
  let linkExists = false
  try {
    fs.lstatSync(target)
    linkExists = true
  } catch {
    linkExists = false
  }
  let currentReal = null
  try {
    currentReal = fs.realpathSync(target)
  } catch {
    currentReal = null
  }
  let desiredReal
  try {
    desiredReal = fs.realpathSync(desired)
  } catch {
    desiredReal = desired
  }
  if (currentReal && currentReal.toLowerCase() === desiredReal.toLowerCase()) {
    return { changed: false, target, real: currentReal }
  }

  fs.mkdirSync(nm, { recursive: true })
  if (linkExists) fs.rmSync(target, { recursive: true, force: true })
  try {
    fs.symlinkSync(desired, target, 'junction')
  } catch (err) {
    throw new ProfileWireError('E-503', `创建 node_modules 链接失败（${err.code ?? '未知'}）：${err.message}`, { target, desired })
  }
  // 目标目录可能尚不存在（安装前的预接线 / 单测），realpath 失败不算错
  let real = null
  try {
    real = fs.realpathSync(target)
  } catch {
    real = null
  }
  return { changed: true, target, real }
}

/** 移除 node_modules 链接 */
function removeNodeModulesLink(profileDir, packageName) {
  const target = path.join(path.resolve(profileDir), 'node_modules', packageName)
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return { removed: true, target }
  } catch {
    return { removed: false, target }
  }
}
/** 只读检查 */
function inspect({ profileDir, packageName }) {
  const { dir, file } = pathsFor(profileDir)
  const { json } = readJson(file)
  const dep = json.dependencies?.[packageName]
  const bundles = json.dsh?.profile?.[BUNDLES_KEY] ?? []
  return {
    profileDir: dir,
    file,
    hasDep: typeof dep === 'string',
    depSpec: dep ?? null,
    hasBundle: bundles.includes(packageName),
    bundleCount: bundles.length,
    ready: typeof dep === 'string' && bundles.includes(packageName),
  }
}

/**
 * 写入（幂等）。已存在相同值时不改文件。
 * @returns {{changed:boolean, backup:string|null, depSpec:string, bundleAdded:boolean, file:string}}
 */
function wire({ profileDir, packageName, linkPath, dryRun = false }) {
  if (!packageName) throw new ProfileWireError('E-501', '缺少 packageName')
  const { file } = pathsFor(profileDir)
  const { json } = readJson(file)
  const depSpec = `link:${path.resolve(linkPath).replace(/\\/g, '/')}`

  const before = JSON.stringify(json)
  ensureShape(json)
  const bundleAdded = !json.dsh.profile[BUNDLES_KEY].includes(packageName)
  json.dependencies[packageName] = depSpec
  if (bundleAdded) json.dsh.profile[BUNDLES_KEY].push(packageName)
  const after = JSON.stringify(json)

  if (before === after) {
    // 清单没变，但 junction 可能仍指向旧路径（如仓库）——这里也必须纠正
    const linkNoop = ensureNodeModulesLink(profileDir, packageName, linkPath)
    return { changed: false, backup: null, depSpec, bundleAdded: false, file, nodeModulesLink: linkNoop }
  }
  if (dryRun) {
    return { changed: true, backup: null, depSpec, bundleAdded, file, dryRun: true, nodeModulesLink: { changed: false, target: null } }
  }

  const preRaw = fs.readFileSync(file, 'utf8')
  const backupPath = backup(file)
  try {
    writeJsonAtomic(file, json)
  } catch (err) {
    // 原子写失败时目标通常**尚未被触碰**：只有确实变了才需要恢复，
    // 否则会误报 E-504（把"文件只读"说成"恢复失败"，测试 5 已抓到）。
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (current !== preRaw) {
      try {
        fs.copyFileSync(backupPath, file)
      } catch (restoreErr) {
        throw new ProfileWireError(
          'E-504',
          `写入失败且备份恢复失败，请手工用 ${backupPath} 覆盖 ${file}（${restoreErr.message}）`,
        )
      }
    }
    throw err
  }
  // 同步 node_modules 链接：否则 DSH 仍从旧路径（如仓库）解析插件
  const link = ensureNodeModulesLink(profileDir, packageName, linkPath)
  return { changed: true, backup: backupPath, depSpec, bundleAdded, file, nodeModulesLink: link }
}

/**
 * 撤回（卸载/回滚用）。幂等。
 * @returns {{changed:boolean, backup:string|null, removedDep:boolean, removedBundle:boolean, file:string}}
 */
function unwire({ profileDir, packageName, dryRun = false }) {
  const { file } = pathsFor(profileDir)
  const { json } = readJson(file)
  ensureShape(json)

  const hadDep = Object.prototype.hasOwnProperty.call(json.dependencies, packageName)
  const bundleIdx = json.dsh.profile[BUNDLES_KEY].indexOf(packageName)
  const hadBundle = bundleIdx >= 0

  if (!hadDep && !hadBundle) {
    const linkNoop = removeNodeModulesLink(profileDir, packageName)
    return { changed: false, backup: null, removedDep: false, removedBundle: false, file, nodeModulesLink: linkNoop }
  }
  if (hadDep) delete json.dependencies[packageName]
  if (hadBundle) json.dsh.profile[BUNDLES_KEY].splice(bundleIdx, 1)

  if (dryRun) {
    return { changed: true, backup: null, removedDep: hadDep, removedBundle: hadBundle, file, dryRun: true, nodeModulesLink: { removed: false, target: null } }
  }

  const preRaw = fs.readFileSync(file, 'utf8')
  const backupPath = backup(file)
  try {
    writeJsonAtomic(file, json)
  } catch (err) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (current !== preRaw) {
      try {
        fs.copyFileSync(backupPath, file)
      } catch (restoreErr) {
        throw new ProfileWireError(
          'E-504',
          `撤回失败且备份恢复失败，请手工用 ${backupPath} 覆盖 ${file}（${restoreErr.message}）`,
        )
      }
    }
    throw err
  }
  const link = removeNodeModulesLink(profileDir, packageName)
  return { changed: true, backup: backupPath, removedDep: hadDep, removedBundle: hadBundle, file, nodeModulesLink: link }
}

module.exports = { ProfileWireError, inspect, wire, unwire, pathsFor, ensureNodeModulesLink, removeNodeModulesLink }
