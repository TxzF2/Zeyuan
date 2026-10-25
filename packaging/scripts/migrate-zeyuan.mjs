#!/usr/bin/env node
/**
 * migrate-zeyuan.mjs · 技术 id 全量改名（dsh-training-* → zeyuan-*）的**数据迁移**脚本
 * ---------------------------------------------------------------------------
 * 只做数据与接线迁移，不改包本身。用途：改名版本发布前/后，把旧环境平滑切到新命名空间。
 *
 * 迁移项：
 *   1) 状态目录：%LOCALAPPDATA%/dsh-training → %LOCALAPPDATA%/zeyuan（复制，旧目录保留）
 *   2) 事件日志：event 字段 dsh-training:<board>:<action> → zeyuan:<board>:<action>
 *   3) 挂载标记：mount-events.jsonl 里 plugin 名 dsh-training-* → zeyuan-*
 *   4) profile 接线：package.json 的 dependencies 键、dsh.profile.bundles 项 dsh-training-* → zeyuan-*
 *
 * 原则：
 *   - 默认 dry-run（只打印计划，不写盘）；--apply 才执行
 *   - 幂等：重复执行不重复迁移、不追加备份
 *   - 非破坏：旧状态目录不删；profile 改写前备份 package.json
 *   - 可回滚：打印回滚指令（把备份 package.json 还原 + 删除新状态目录即可）
 *
 * 用法：
 *   node packaging/scripts/migrate-zeyuan.mjs            # dry-run
 *   node packaging/scripts/migrate-zeyuan.mjs --apply    # 执行
 *   node packaging/scripts/migrate-zeyuan.mjs --apply --force   # 新状态目录已存在时覆盖
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const OLD_PREFIX = 'dsh-training'
export const NEW_PREFIX = 'zeyuan'
export const OLD_NS = 'dsh-training:'
export const NEW_NS = 'zeyuan:'

export const isOldName = (name) => typeof name === 'string' && name.startsWith(OLD_PREFIX)
export const renameName = (name) => (isOldName(name) ? NEW_PREFIX + name.slice(OLD_PREFIX.length) : name)
export const renameEvent = (type) => (typeof type === 'string' && type.startsWith(OLD_NS) ? NEW_NS + type.slice(OLD_NS.length) : type)

export function defaultPaths(env = process.env) {
  const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const dshHome = env.DSH_HOME || join(homedir(), '.dsh')
  return {
    oldStateDir: env.ZEYUAN_OLD_STATE_DIR || join(base, OLD_PREFIX),
    newStateDir: env.ZEYUAN_NEW_STATE_DIR || join(base, NEW_PREFIX),
    profileDir: env.ZEYUAN_PROFILE_DIR || env.DSH_TRAINING_PROFILE_DIR || join(dshHome, 'profiles', 'desktop'),
  }
}

/** 统计一次迁移计划（不写盘） */
/** 改写 link: 依赖值里的插件目录段（仓库名 dsh-training 不动） */
export function renameLinkValue(value) {
  if (typeof value !== 'string') return value
  return value.replace(/([\\/]app[\\/]plugins[\\/])dsh-training-/g, '$1zeyuan-')
}

export function buildPlan(paths) {
  const actions = []
  const { oldStateDir, newStateDir, profileDir } = paths

  if (!existsSync(oldStateDir)) {
    actions.push({ kind: 'skip', what: 'state-dir', detail: `旧状态目录不存在：${oldStateDir}（可能已迁移或从未安装）` })
  } else if (existsSync(newStateDir)) {
    actions.push({ kind: 'skip', what: 'state-dir', detail: `新状态目录已存在：${newStateDir}（用 --force 覆盖）` })
  } else {
    const files = countFiles(oldStateDir)
    actions.push({ kind: 'copy', what: 'state-dir', detail: `复制 ${files} 个文件：${oldStateDir} → ${newStateDir}` })
  }

  const logOld = join(oldStateDir, 'event-log.jsonl')
  const logNew = join(newStateDir, 'event-log.jsonl')
  const logSrc = existsSync(logNew) ? logNew : logOld
  if (existsSync(logSrc)) {
    const { lines, renamed } = planEventLog(logSrc)
    actions.push({ kind: renamed > 0 ? 'rewrite' : 'skip', what: 'event-log', detail: `事件 ${lines} 条，需改名 ${renamed} 条（${logSrc}）` })
  }

  const mountOld = join(newStateDir, 'mount-events.jsonl')
  const mountSrc = existsSync(mountOld) ? mountOld : join(oldStateDir, 'mount-events.jsonl')
  if (existsSync(mountSrc)) {
    const { lines, renamed } = planMountEvents(mountSrc)
    actions.push({ kind: renamed > 0 ? 'rewrite' : 'skip', what: 'mount-events', detail: `挂载记录 ${lines} 条，需改名 ${renamed} 条` })
  }

  const pkg = join(profileDir, 'package.json')
  if (existsSync(pkg)) {
    const { deps, bundles } = planProfile(pkg)
    actions.push({
      kind: deps + bundles > 0 ? 'rewrite' : 'skip',
      what: 'profile',
      detail: `dependencies 需改 ${deps} 项，bundles 需改 ${bundles} 项（${pkg}）`,
    })
  } else {
    actions.push({ kind: 'skip', what: 'profile', detail: `profile 不存在：${pkg}` })
  }

  const pending = actions.filter((a) => a.kind !== 'skip').length
  return { actions, pending }
}

function countFiles(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countFiles(p)
    else n++
  }
  return n
}


/** 把一行事件 JSON 规整为 canonical 信封并改名；返回 {line, changed, upgraded} */
export function convertLine(line) {
  let env
  try {
    env = JSON.parse(line)
  } catch {
    return { line, changed: false, upgraded: false }
  }
  // 旧信封：{ v,id,at,source,type,subject,payload }
  if (env && typeof env.type === 'string' && typeof env.event === 'string') {
    // 同时存在：以 event 为准，只改名
    const renamed = renameEvent(env.event)
    if (renamed === env.event) return { line, changed: false, upgraded: false }
    return { line: JSON.stringify({ ...env, event: renamed }), changed: true, upgraded: false }
  }
  if (env && typeof env.event === 'string') {
    const renamed = renameEvent(env.event)
    if (renamed === env.event) return { line, changed: false, upgraded: false }
    return { line: JSON.stringify({ ...env, event: renamed }), changed: true, upgraded: false }
  }
  if (env && typeof env.type === 'string') {
    const canonical = {
      event: renameEvent(env.type),
      id: typeof env.id === 'string' ? env.id : `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: typeof env.at === 'string' ? env.at : new Date().toISOString(),
      actor: env.payload && typeof env.payload === 'object' && typeof env.payload.by === 'string' ? env.payload.by : null,
      payload: env.payload && typeof env.payload === 'object' ? env.payload : {},
    }
    return { line: JSON.stringify(canonical), changed: true, upgraded: true }
  }
  return { line, changed: false, upgraded: false }
}

export function planEventLog(file) {
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  let renamed = 0
  for (const line of lines) {
    if (convertLine(line).changed) renamed++
  }
  return { lines: lines.length, renamed }
}

export function planMountEvents(file) {
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  let renamed = 0
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      if (renameName(row.plugin) !== row.plugin) renamed++
    } catch {
      /* ignore */
    }
  }
  return { lines: lines.length, renamed }
}

export function planProfile(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const deps = Object.keys(doc.dependencies ?? {}).filter(isOldName).length
  const bundles = (doc.dsh?.profile?.bundles ?? []).filter(isOldName).length
  const links = Object.values(doc.dependencies ?? {}).filter((v) => renameLinkValue(v) !== v).length
  return { deps, bundles, links }
}

/** 实际执行 */
export function applyMigration(paths, { force = false, skipProfile = false, now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const done = []

  if (existsSync(paths.oldStateDir) && (!existsSync(paths.newStateDir) || force)) {
    mkdirSync(paths.newStateDir, { recursive: true })
    cpSync(paths.oldStateDir, paths.newStateDir, { recursive: true, force: true })
    done.push(`复制状态目录 → ${paths.newStateDir}`)
  }

  const log = join(paths.newStateDir, 'event-log.jsonl')
  if (existsSync(log)) {
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    let n = 0
    const out = lines.map((line) => {
      const conv = convertLine(line)
      if (conv.changed) n++
      return conv.line
    })
    if (n > 0) {
      writeFileSync(log, out.join('\n') + '\n', 'utf8')
      done.push(`事件日志改名 ${n} 条`)
    }
  }

  const mount = join(paths.newStateDir, 'mount-events.jsonl')
  if (existsSync(mount)) {
    const lines = readFileSync(mount, 'utf8').trim().split('\n').filter(Boolean)
    let n = 0
    const out = lines.map((line) => {
      try {
        const row = JSON.parse(line)
        if (renameName(row.plugin) !== row.plugin) {
          row.plugin = renameName(row.plugin)
          n++
        }
        return JSON.stringify(row)
      } catch {
        return line
      }
    })
    if (n > 0) {
      writeFileSync(mount, out.join('\n') + '\n', 'utf8')
      done.push(`挂载记录改名 ${n} 条`)
    }
  }

  const pkg = join(paths.profileDir, 'package.json')
  if (!skipProfile && existsSync(pkg)) {
    const raw = readFileSync(pkg, 'utf8')
    const doc = JSON.parse(raw)
    let changed = 0
    if (doc.dependencies) {
      for (const key of Object.keys(doc.dependencies)) {
        const value = renameLinkValue(doc.dependencies[key])
        if (value !== doc.dependencies[key]) changed++
        if (isOldName(key)) {
          doc.dependencies[renameName(key)] = value
          delete doc.dependencies[key]
          changed++
        } else {
          doc.dependencies[key] = value
        }
      }
    }
    const bundles = doc.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      doc.dsh.profile.bundles = bundles.map((b) => {
        if (!isOldName(b)) return b
        changed++
        return renameName(b)
      })
    }
    if (changed > 0) {
      const backup = `${pkg}.bak-${stamp}`
      copyFileSync(pkg, backup)
      writeFileSync(pkg, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      done.push(`profile 接线改名 ${changed} 项（备份：${backup}）`)
    }
  }

  return { done, rollback: [`还原 profile：cp "${pkg}.bak-${stamp}" "${pkg}"（若存在备份）`, `删除新状态目录：rm -rf "${paths.newStateDir}"`] }
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  const apply = process.argv.includes('--apply')
  const force = process.argv.includes('--force')
  const paths = defaultPaths()
  console.log('迁移目标：')
  console.log(`  旧状态目录：${paths.oldStateDir}`)
  console.log(`  新状态目录：${paths.newStateDir}`)
  console.log(`  profile  ：${paths.profileDir}`)
  const plan = buildPlan(paths)
  console.log('\n计划：')
  for (const a of plan.actions) console.log(`  [${a.kind}] ${a.what} — ${a.detail}`)
  if (!apply) {
    console.log(`\n共 ${plan.pending} 项待执行。**dry-run**，未写盘。加 --apply 执行。`)
  } else {
    const skipProfile = process.argv.includes('--no-profile')
    const { done, rollback } = applyMigration(paths, { force, skipProfile })
    console.log('\n已执行：')
    for (const d of done) console.log('  ✓ ' + d)
    if (done.length === 0) console.log('  （无变更，已是最新）')
    console.log('\n回滚：')
    for (const r of rollback) console.log('  - ' + r)
  }
}
