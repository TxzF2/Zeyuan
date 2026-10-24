/**
 * profile-gate.ts · 板块真启停（写 DSH profile）
 * ---------------------------------------------------------------------------
 * 目标：控制台开关板块 = 真正改 `~/.dsh/profiles/desktop/package.json`
 *   dependencies[<pkg>] = link:<安装目录>/app/plugins/<pkg>
 *   dsh.profile.bundles 增/删 <pkg>
 *   同步 node_modules/<pkg> junction（与 profile-wire 同语义）
 *
 * 安全措施：
 *   - 改动前备份 package.json.bak-<ts>，最多保留 3 份
 *   - 临时文件 + rename 原子替换
 *   - core / dsh-training-protocol 受保护（E-1106）
 *   - 失败时恢复备份
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stateDir } from './license-gate.js'

export const PROTECTED_PACKAGES = ['dsh-training-protocol'] as const
export const PROTECTED_BOARDS = ['core', 'console'] as const
export const MAX_BACKUPS = 3

export class ProfileError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ProfileError'
  }
}

export function profileDir(): string {
  return process.env.DSH_TRAINING_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop')
}

export function profileFile(): string {
  return join(profileDir(), 'package.json')
}

export function pluginInstallPath(pkg: string): string {
  return join(stateDir(), 'app', 'plugins', pkg)
}

function readProfile(): Record<string, unknown> {
  const file = profileFile()
  if (!existsSync(file)) throw new ProfileError('E-1220', `找不到 profile：${file}`)
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    throw new ProfileError('E-1221', `profile package.json 解析失败：${(err as Error).message}`)
  }
}

function backupProfile(now: Date = new Date()): string | null {
  const file = profileFile()
  if (!existsSync(file)) return null
  const backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`
  writeFileSync(backup, readFileSync(file, 'utf8'), 'utf8')
  // 只保留最近 3 份
  try {
    const dir = profileDir()
    const backups = readdirSync(dir)
      .filter((f) => f.startsWith('package.json.bak-'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const stale of backups.slice(MAX_BACKUPS)) rmSync(join(dir, stale.f), { force: true })
  } catch {
    /* 清理失败不影响主流程 */
  }
  return backup
}

function writeProfile(doc: Record<string, unknown>): void {
  const file = profileFile()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** 维护 node_modules 链接 */
function syncLink(pkg: string, enable: boolean): { changed: boolean } {
  const nm = join(profileDir(), 'node_modules')
  const target = join(nm, pkg)
  const desired = pluginInstallPath(pkg)
  if (!enable) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
      return { changed: true }
    }
    return { changed: false }
  }
  try {
    if (existsSync(desired) && existsSync(target)) {
      const real = readdirSync(desired) // 仅探测可读
      void real
    }
  } catch {
    /* ignore */
  }
  mkdirSync(nm, { recursive: true })
  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    symlinkSync(desired, target, 'junction')
    return { changed: true }
  } catch (err) {
    throw new ProfileError('E-1222', `创建插件链接失败：${(err as Error).message}`)
  }
}

export interface ToggleResult {
  changed: boolean
  backup: string | null
  enabled: boolean
  bundles: string[]
  restartRequired: boolean
}

/** 启用/停用一个插件（同时改 dependencies 与 bundles） */
export function setPluginEnabled(pkg: string, enabled: boolean, now: Date = new Date()): ToggleResult {
  if (!enabled && PROTECTED_PACKAGES.includes(pkg as (typeof PROTECTED_PACKAGES)[number])) {
    throw new ProfileError('E-1106', `插件 ${pkg} 受保护，不能停用。`)
  }
  const doc = readProfile()
  const before = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>

  const deps = (doc.dependencies ?? {}) as Record<string, string>
  const dsh = (doc.dsh ?? {}) as Record<string, unknown>
  const profile = (dsh.profile ?? {}) as Record<string, unknown>
  const bundles = Array.isArray(profile.bundles) ? (profile.bundles as string[]) : []

  let nextDeps = { ...deps }
  let nextBundles = [...bundles]

  if (enabled) {
    nextDeps[pkg] = `link:${pluginInstallPath(pkg).replace(/\\/g, '/')}`
    if (!nextBundles.includes(pkg)) nextBundles.push(pkg)
  } else {
    delete nextDeps[pkg]
    nextBundles = nextBundles.filter((b) => b !== pkg)
  }

  const changed = JSON.stringify(nextDeps) !== JSON.stringify(deps) || JSON.stringify(nextBundles) !== JSON.stringify(bundles)
  if (!changed) {
    return { changed: false, backup: null, enabled, bundles: nextBundles, restartRequired: false }
  }

  const backup = backupProfile(now)
  try {
    doc.dependencies = nextDeps
    dsh.profile = { ...profile, bundles: nextBundles }
    doc.dsh = dsh
    writeProfile(doc)
    syncLink(pkg, enabled)
  } catch (err) {
    // 回滚
    try {
      writeProfile(before)
    } catch {
      /* ignore */
    }
    throw err instanceof ProfileError ? err : new ProfileError('E-1223', `写入 profile 失败：${(err as Error).message}`)
  }

  return { changed: true, backup, enabled, bundles: nextBundles, restartRequired: true }
}

/** 读取当前 profile 里某插件是否启用 */
export function isPluginEnabled(pkg: string): boolean {
  try {
    const doc = readProfile()
    const deps = (doc.dependencies ?? {}) as Record<string, string>
    const bundles = (((doc.dsh ?? {}) as Record<string, unknown>).profile ?? {}) as Record<string, unknown>
    const list = Array.isArray(bundles.bundles) ? (bundles.bundles as string[]) : []
    return Boolean(deps[pkg]) && list.includes(pkg)
  } catch {
    return false
  }
}
