/**
 * installer.js · 安装线核心（**不依赖 Electron**，可被 Node 直接跑故障注入测试）
 * ---------------------------------------------------------------------------
 * 布局（全部在同一个卷内，保证 rename 原子性）：
 *
 *   %LOCALAPPDATA%\dsh-training\        ← 容器目录 targetDir
 *   ├─ app\                             ← 当前生效版本（原子的替换目标）
 *   │  └─ install-manifest.json         ← 装机清单（跟着版本一起回滚）
 *   ├─ .staging\<ts>\                   ← 装配中（失败即删）
 *   ├─ .backup\<ts>\                    ← 上一版本（成功后保留，下次启动再清）
 *   ├─ .failed\<ts>\                    ← 回滚时踢出来的坏版本（留证）
 *   └─ last-install.json                ← 最近一次操作记录（诊断用）
 *
 * 安装顺序（失败必回滚，见 runInstall 的 finally）：
 *   prepare → 写 staging → 校验哈希 → app 改名进 .backup → staging 改名成 app
 *   → 写清单 → 成功
 *
 * 错误码（与《安装包构建说明》第 6 节对齐）：
 *   E-201 目标不可写 / E-202 空间不足 / E-203 文件被占用
 *   E-205 哈希校验不符 / E-206 用户取消 / E-207 装配写盘失败
 *   E-208 安装包内容为空 / E-209 没有可回滚的备份 / E-210 安装目录非法
 * ---------------------------------------------------------------------------
 */

'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const profileWire = require('./profile-wire')

const LAYOUT = {
  app: 'app',
  staging: '.staging',
  backup: '.backup',
  failed: '.failed',
  manifest: 'install-manifest.json',
  lastInstall: 'last-install.json',
}

class InstallError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'InstallError'
    this.code = code
    this.detail = detail ?? null
  }
}

/** 默认安装目录：%LOCALAPPDATA%\dsh-training（免管理员、无中文路径） */
function defaultTargetDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'dsh-training')
}

function pathsFor(targetDir = defaultTargetDir()) {
  const root = path.resolve(targetDir)
  return {
    root,
    app: path.join(root, LAYOUT.app),
    stagingRoot: path.join(root, LAYOUT.staging),
    backupRoot: path.join(root, LAYOUT.backup),
    failedRoot: path.join(root, LAYOUT.failed),
    manifest: path.join(root, LAYOUT.app, LAYOUT.manifest),
    lastInstall: path.join(root, LAYOUT.lastInstall),
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 时间戳用于目录名，必须无冒号（Windows 不允许） */
function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

function mapFsError(err, fallback = 'E-207') {
  const map = { EACCES: 'E-201', EPERM: 'E-201', EROFS: 'E-201', ENOSPC: 'E-202', EBUSY: 'E-203', ENOTEMPTY: 'E-203' }
  return map[err?.code] ?? fallback
}

function describeFsError(err) {
  const m = {
    EACCES: '目标目录没有写入权限',
    EPERM: '目标文件被系统保护或占用',
    EROFS: '目标磁盘为只读',
    ENOSPC: '磁盘空间不足',
    EBUSY: '文件正被占用（可能培训程序还在运行）',
    ENOTEMPTY: '目标目录非空',
  }
  return m[err?.code] ?? `${err?.code ?? '未知错误'}：${err?.message ?? ''}`
}

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true })
}

/** 递归列出目录下的相对文件路径（用于装机清单/卸载） */
async function listFiles(dir) {
  const out = []
  async function walk(cur, prefix) {
    const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const full = path.join(cur, e.name)
      if (e.isDirectory()) await walk(full, rel)
      else if (e.isFile()) out.push(rel)
    }
  }
  await walk(dir, '')
  return out.sort()
}

/** 取目录下最新一个子目录（.backup / .failed 用） */
async function latestSubdir(rootDir) {
  const names = await fsp.readdir(rootDir).catch(() => [])
  if (names.length === 0) return null
  const withStat = await Promise.all(
    names.map(async (n) => ({ name: n, stat: await fsp.stat(path.join(rootDir, n)).catch(() => null) })),
  )
  const dirs = withStat.filter((x) => x.stat?.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
  return dirs.length ? path.join(rootDir, dirs[dirs.length - 1].name) : null
}

/** 进度回调的阶段定义 */
const PHASES = [
  ['prepare', '检查安装目录', 5],
  ['stage', '装配到临时目录', 45],
  ['verify', '校验文件完整性', 20],
  ['backup', '备份上一版本', 10],
  ['commit', '原子替换到安装目录', 15],
  ['finish', '写入装机清单', 5],
]

/**
 * 安装主流程。
 *
 * @param {object} opts
 * @param {string} [opts.targetDir]      容器目录，默认 %LOCALAPPDATA%\dsh-training
 * @param {Array<{path:string, content?:Buffer|string, sourcePath?:string}>} opts.payload 要安装的文件（相对 app/）
 * @param {string} [opts.version]        版本号
 * @param {string[]} [opts.boards]       本次勾选的板块 id
 * @param {(p:{phase:string,percent:number,message:string})=>void} [opts.onProgress]
 * @param {object} [opts.faults]         故障注入（仅供测试）：{ failWriteAt, corruptFile, cancelAt }
 * @param {AbortSignal} [opts.signal]    取消信号
 */
async function runInstall(opts) {
  const {
    targetDir = defaultTargetDir(),
    payload = [],
    version = '0.0.0',
    boards = [],
    onProgress = () => {},
    faults = {},
    signal,
    /** { profileDir, packageName, linkPath } —— 把核心板块接进 DSH profile（外部副作用，随安装事务一起回滚） */
    profileWire: wireOpt = null,
  profileWires = [],
  } = opts

  const P = pathsFor(targetDir)
  const ts = stamp()
  const stagingDir = path.join(P.stagingRoot, ts)
  let backupDir = null
  let movedAppToBackup = false
  let committed = false
  let wiredOk = false
  const wiredOpts = []

  const emit = (phase, percent, message) => {
    try {
      onProgress({ phase, percent, message })
    } catch {
      /* 进度回调不应影响安装 */
    }
  }

  const cancelled = () => {
    if (signal?.aborted) return true
    return faults.cancelAt === 'after-stage' || faults.cancelAt === 'after-backup'
  }

  try {
    // ---- 1. prepare ----
    emit('prepare', 0, '检查安装目录')
    if (!payload.length) throw new InstallError('E-208', '安装包内容为空：没有可安装的文件。')
    if (typeof targetDir !== 'string' || !path.isAbsolute(P.root)) {
      throw new InstallError('E-210', '安装目录必须是绝对路径。')
    }
    await ensureDir(P.root)
    await ensureDir(P.stagingRoot)
    await ensureDir(P.backupRoot)
    await ensureDir(P.failedRoot)
    emit('prepare', PHASES[0][2], '安装目录就绪：' + P.root)

    // ---- 2. stage ----
    let written = 0
    for (const [i, file] of payload.entries()) {
      if (faults.failWriteAt === i) {
        const err = Object.assign(new Error('模拟写盘失败'), { code: 'EACCES' })
        throw new InstallError(mapFsError(err), `装配写盘失败：${file.path}（${describeFsError(err)}）`, { file: file.path })
      }
      const dest = path.join(stagingDir, ...file.path.split('/'))
      await ensureDir(path.dirname(dest))
      const content = file.content ?? (await fsp.readFile(file.sourcePath))
      await fsp.writeFile(dest, content)
      written++
      emit('stage', 5 + Math.round((45 * (i + 1)) / payload.length), `装配 ${written}/${payload.length}：${file.path}`)
    }

    if (faults.cancelAt === 'after-stage' || signal?.aborted) {
      throw new InstallError('E-206', '已取消安装，临时文件已清理。')
    }

    // ---- 3. verify ----
    emit('verify', 50, '校验文件完整性')
    const staged = await listFiles(stagingDir)
    const expected = payload.map((f) => f.path).sort()
    if (staged.length !== expected.length || staged.some((f, i) => f !== expected[i])) {
      throw new InstallError('E-205', '校验失败：装配出的文件清单与安装包不一致。', { staged, expected })
    }
    const files = []
    for (const rel of staged) {
      const buf = await fsp.readFile(path.join(stagingDir, ...rel.split('/')))
      const digest = sha256(buf)
      const want = sha256(payload.find((f) => f.path === rel).content ?? (await fsp.readFile(payload.find((f) => f.path === rel).sourcePath)))
      if (faults.corruptFile === rel) {
        throw new InstallError('E-205', `校验失败：${rel} 的哈希与安装包不一致（文件可能在传输中损坏）。`, { file: rel, got: digest, want })
      }
      if (digest !== want) {
        throw new InstallError('E-205', `校验失败：${rel} 的哈希不符。`, { file: rel, got: digest, want })
      }
      files.push({ path: rel, sha256: digest, size: buf.length })
    }
    emit('verify', 70, `校验通过：${files.length} 个文件`)

    // ---- 4. backup ----
    if (await exists(P.app)) {
      backupDir = path.join(P.backupRoot, ts)
      emit('backup', 72, '备份上一版本')
      await fsp.rename(P.app, backupDir)
      movedAppToBackup = true
    } else {
      emit('backup', 78, '没有旧版本，跳过备份')
    }

    if (faults.cancelAt === 'after-backup') {
      throw new InstallError('E-206', '已取消安装，已恢复原版本。')
    }

    // ---- 5. commit（原子 rename，同卷）----
    emit('commit', 85, '原子替换到安装目录')
    await fsp.rename(stagingDir, P.app)
    committed = true

    // ---- 5.5 把核心板块接进 DSH profile（外部副作用）----
    let wireResult = null
    if (wireOpt) {
      emit('wire', 92, '把核心板块接入 DSH profile')
      wireResult = profileWire.wire(wireOpt)
        wiredOpts.push(wireOpt)
      wiredOk = true
      emit('wire', 96, wireResult.changed ? 'profile 已更新（依赖 + bundles）' : 'profile 已是目标状态（幂等跳过）')
    }

    // 额外插件接线（如任务接发板块）：与核心插件同样走 wire，失败即整体回滚
    const extraWires = []
    for (const opt of profileWires) {
      const r = profileWire.wire(opt)
      wiredOpts.push(opt)
      extraWires.push({ opt, result: r })
      wiredOk = true
    }

    // ---- 6. manifest（写在 app 内，跟随版本一起回滚）----
    const manifest = {
      product: 'dsh-training',
      version,
      boards,
      installedAt: new Date().toISOString(),
      stagingId: ts,
      backupDir: backupDir ? path.relative(P.root, backupDir) : null,
      files,
      externalWrites: [
        ...(wireResult && wireOpt
          ? [
              {
                type: 'profile-wire',
                profileDir: wireOpt.profileDir,
                packageName: wireOpt.packageName,
                depSpec: wireResult.depSpec,
                backup: wireResult.backup,
                changed: wireResult.changed,
              },
            ]
          : []),
        ...extraWires.map(({ opt, result }) => ({
          type: 'profile-wire',
          profileDir: opt.profileDir,
          packageName: opt.packageName,
          depSpec: result.depSpec,
          backup: result.backup,
          changed: result.changed,
        })),
      ],
    }
    await fsp.writeFile(path.join(P.app, LAYOUT.manifest), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    emit('finish', 100, `安装完成：v${version}`)

    await fsp
      .writeFile(
        P.lastInstall,
        JSON.stringify({ at: new Date().toISOString(), action: 'install', version, boards, result: 'ok' }, null, 2) + '\n',
        'utf8',
      )
      .catch(() => {})

    return { ok: true, version, installedTo: P.app, fileCount: files.length, backupDir, manifest }
  } catch (err) {
    // ---- 失败一律回滚到「原来的样子」 ----
    emit('rollback', 0, `出错了，正在回滚：${err.message}`)
    try {
      await fsp.rm(stagingDir, { recursive: true, force: true })
    } catch {
      /* 清不掉也不该覆盖原始错误 */
    }
    if (movedAppToBackup && !committed) {
      try {
        if (!(await exists(P.app))) await fsp.rename(backupDir, P.app)
      } catch {
        /* 回滚失败要暴露给上层，但别掩盖原因 */
      }
    }
    if (committed) {
      // 已经替换成功但后续步骤失败：把坏版本踢到 .failed，恢复备份
      try {
        const bad = path.join(P.failedRoot, ts)
        await fsp.rename(P.app, bad)
        if (backupDir && (await exists(backupDir))) await fsp.rename(backupDir, P.app)
      } catch {
        /* 同上 */
      }
    }
    // 外部副作用也要撤回，否则会留下「装了又回滚、profile 里还有条目」的脏状态
    if (wiredOpts.length) {
      for (const opt of wiredOpts) {
        try {
          profileWire.unwire(opt)
        } catch (unwireErr) {
          console.error('[install] 回滚时撤销 profile 接线失败：', unwireErr.message)
        }
      }
      emit('rollback', 50, 'profile 写入已撤销')
    }    await fsp
      .writeFile(
        P.lastInstall,
        JSON.stringify({ at: new Date().toISOString(), action: 'install', version, result: 'failed', code: err.code ?? 'E-207', message: err.message }, null, 2) + '\n',
        'utf8',
      )
      .catch(() => {})

    if (err instanceof InstallError) throw err
    // profile 写入类错误要原样透出（E-50x），不能被兜底成 E-207
    if (err && err.name === "ProfileWireError") {
      throw new InstallError(err.code, err.message, err.detail ?? null)
    }
    throw new InstallError(mapFsError(err), `安装失败：${describeFsError(err)}`, { raw: err?.message })
  }
}

/** 回滚到最近一个备份 */
async function runRollback({ targetDir = defaultTargetDir(), onProgress = () => {} } = {}) {
  const P = pathsFor(targetDir)
  onProgress({ phase: 'rollback', percent: 0, message: '查找上一版本备份' })
  const backupDir = await latestSubdir(P.backupRoot)
  if (!backupDir) throw new InstallError('E-209', '没有可回滚的备份（这是第一次安装）。')

  const ts = stamp()
  const failedDir = path.join(P.failedRoot, ts)
  try {
    if (await exists(P.app)) {
      onProgress({ phase: 'rollback', percent: 40, message: '移出当前版本' })
      await ensureDir(P.failedRoot)
      await fsp.rename(P.app, failedDir)
    }
    onProgress({ phase: 'rollback', percent: 70, message: '恢复上一版本' })
    await fsp.rename(backupDir, P.app)
    onProgress({ phase: 'rollback', percent: 100, message: '回滚完成' })
    await fsp
      .writeFile(
        P.lastInstall,
        JSON.stringify({ at: new Date().toISOString(), action: 'rollback', result: 'ok', restoredFrom: path.basename(backupDir) }, null, 2) + '\n',
        'utf8',
      )
      .catch(() => {})
    return { ok: true, restoredFrom: path.basename(backupDir), failedDir }
  } catch (err) {
    throw new InstallError('E-401', `回滚失败：${describeFsError(err)}（已保留现场，请导出日志）`, { raw: err?.message })
  }
}

/** 自底向上删除空目录（卸载收尾用） */
async function pruneEmptyDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name))
  }
  const rest = await fsp.readdir(dir).catch(() => [])
  if (rest.length === 0) await fsp.rmdir(dir).catch(() => {})
}

/** 卸载：只删清单里列出的文件（不做整目录硬删） */
async function runUninstall({ targetDir = defaultTargetDir() } = {}) {
  const P = pathsFor(targetDir)
  if (!(await exists(P.app))) return { ok: true, removedFiles: 0, leftovers: [] }

  const manifestPath = path.join(P.app, LAYOUT.manifest)
  if (!(await exists(manifestPath))) {
    throw new InstallError('E-303', '装机清单缺失，无法精确卸载。可在控制面板执行「修复清单」。')
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  let removed = 0
  for (const f of manifest.files ?? []) {
    const full = path.join(P.app, ...f.path.split('/'))
    try {
      await fsp.rm(full, { force: true })
      removed++
    } catch {
      /* 单个文件删不掉就继续，最后统计 leftovers */
    }
  }

  // 清单本身不在 manifest.files 里（它描述的是被装文件），卸载时要单独删，
  // 否则会留下「唯一的残留」——这正是测试 8 抓到的缺陷。
  try {
    await fsp.rm(manifestPath, { force: true })
    removed++
  } catch {
    /* ignore */
  }

  await pruneEmptyDirs(P.app)
  const leftovers = await listFiles(P.app).catch(() => [])

  // 撤回装机清单里记录的外部副作用（profile 写入）
  const unwired = []
  for (const w of manifest.externalWrites ?? []) {
    if (w.type !== "profile-wire") continue
    try {
      const r = profileWire.unwire({ profileDir: w.profileDir, packageName: w.packageName })
      unwired.push({ profileDir: w.profileDir, packageName: w.packageName, changed: r.changed })
    } catch (err) {
      unwired.push({ profileDir: w.profileDir, packageName: w.packageName, error: err.message, code: err.code ?? null })
    }
  }

  return { ok: true, removedFiles: removed, leftovers, unwired }
}

/** 查询当前安装状态（向导首屏用） */
async function getStatus({ targetDir = defaultTargetDir() } = {}) {
  const P = pathsFor(targetDir)
  const installed = await exists(P.app)
  let manifest = null
  if (installed) {
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(P.app, LAYOUT.manifest), 'utf8'))
    } catch {
      manifest = null
    }
  }
  const backupDir = await latestSubdir(P.backupRoot)
  return { installed, targetDir: P.root, manifest, canRollback: Boolean(backupDir) }
}

module.exports = {
  InstallError,
  LAYOUT,
  defaultTargetDir,
  pathsFor,
  runInstall,
  runRollback,
  runUninstall,
  getStatus,
  listFiles,
  sha256,
  stamp,
}
