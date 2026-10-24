/**
 * dsh-training 安装器外壳 · 主进程（阶段二 · 第 1 步：接通 detect-node）
 * ---------------------------------------------------------------------------
 * 已接：runtime-info（只读）、detect-node（只读检测）、open-external（白名单外链）
 * 未接：install / rollback（阶段二第 2 步）
 *
 * 安全基线：
 *   - nodeIntegration: false / contextIsolation: true / sandbox: true
 *   - 渲染进程只能通过 preload 白名单 API 与主进程通信
 *   - 外链必须命中白名单域名，否则拒绝（防止被注入任意 URL）
 * ---------------------------------------------------------------------------
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { detectRuntime } = require('./lib/detect-runtime')
const os = require('node:os')
const { runInstall, runRollback, runUninstall, getStatus, defaultTargetDir } = require('./lib/installer')

/** QA 钩子：DSH_TRAINING_SELFTEST=1 时走自检（跑通 IPC → 截图 → 写报告 → 退出） */
const SELFTEST = process.env.DSH_TRAINING_SELFTEST === '1'
/** QA 钩子：DSH_TRAINING_SMOKE=1 时走冒烟测试（真实点击 UI：向导 → 安装 → LV0 协议页） */
const SMOKE = process.env.DSH_TRAINING_SMOKE === '1'
/** QA 钩子：把安装目标改到临时目录，避免自检污染真实安装 */
const TARGET_DIR = process.env.DSH_TRAINING_TARGET_DIR || defaultTargetDir()
/**
 * 自检产物目录。
 * 注意：**必须与发布产物分开**——artifacts/ 根目录是 verify.mjs 扫描发布包的地方，
 * 把 QA 截图丢进去会被判定为「文件名不合规的产物」（这个坑已踩过一次）。
 */
/**
 * 运行形态判断：
 *   开发态（packaging/installer/shell）→ 载荷在打包工程里
 *   便携态（resources/app）           → 载荷在 resources/app/payload 里
 * 两种形态下 __dirname 分别是 shell 目录 / resources/app，路径不能写死。
 */
const HAS_BUNDLED_PAYLOAD = fs.existsSync(path.join(__dirname, 'payload'))
const ARTIFACTS_DIR = HAS_BUNDLED_PAYLOAD
  ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-training', 'qa')
  : path.join(__dirname, '..', '..', 'artifacts', 'qa')
/** 载荷根：开发态=packaging/，便携态=resources/app/payload */
const PACKAGING_ROOT = HAS_BUNDLED_PAYLOAD ? path.join(__dirname, 'payload') : path.join(__dirname, '..', '..')
/** 插件源目录（开发态指向仓库，便携态指向 payload） */
const PLUGIN_SOURCE_DIR = HAS_BUNDLED_PAYLOAD
  ? path.join(__dirname, 'payload', 'dsh-training-protocol')
  : path.join(__dirname, '..', '..', '..', 'plugins', 'dsh-training-protocol')
/** 向导页目录：开发态在 shell 的上一级，便携态在 resources/app/wizard */
const WIZARD_DIR = fs.existsSync(path.join(__dirname, 'wizard'))
  ? path.join(__dirname, 'wizard')
  : path.join(__dirname, '..', 'wizard')
/** 插件在安装目标里的相对位置（app/plugin/dsh-training-protocol） */
const PLUGIN_INSTALL_REL = 'plugin/dsh-training-protocol'
/** 要接入的 DSH profile（默认 desktop；自检用 env 指到临时目录，避免污染真实配置） */
const PROFILE_DIR =
  process.env.DSH_TRAINING_PROFILE_DIR ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')
/** 插件包名（写进 dependencies 与 dsh.profile.bundles 的那个 key） */
const CORE_PLUGIN_NAME = 'dsh-training-protocol'

/** 递归收集目录里的文件，映射成 <base>/<相对路径> */
function collectFiles(dir, base) {
  const out = []
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(full, r)
      else out.push({ path: `${base}/${r}`, sourcePath: full })
    }
  }
  walk(dir, '')
  return out
}

/**
 * 真实安装载荷（阶段三·丙起）：
 *   - 板块清单（boards.json / distribution.json / boards/<id>/*.json）
 *   - 核心插件本体（dist + lib + package.json + cordis.patch.yml）→ 装进 app/plugin/
 * 不再写 STAGE2-PAYLOAD.md 占位说明。
 */
function buildPayload() {
  const files = []
  const add = (absPath, relPath) => {
    if (fs.existsSync(absPath)) files.push({ path: relPath, sourcePath: absPath })
  }

  add(path.join(PACKAGING_ROOT, 'boards.json'), 'boards.json')
  add(path.join(PACKAGING_ROOT, 'distribution.json'), 'distribution.json')

  // 板块清单
  try {
    const { boards } = JSON.parse(fs.readFileSync(path.join(PACKAGING_ROOT, 'boards.json'), 'utf8'))
    for (const b of boards ?? []) {
      const dir = path.join(PACKAGING_ROOT, 'boards', b.id)
      if (!fs.existsSync(dir)) continue
      // 按板块契约的 install 落点装配（契约 v2）：
      //   plugin-link → 插件单独装（跳过，见 PLUGIN_INSTALL_REL）
      //   asset-copy  → assets/characters|themes/<name>
      //   copy        → features/<name>
      let meta = null
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'))
      } catch (err) {
        console.warn(`[payload] ${b.id} 的 board.json 解析失败：`, err.message)
      }
      const mode = meta?.install?.mode ?? 'copy'
      if (mode === 'plugin-link') continue
      const target = (meta?.install?.target ?? `boards/${b.id}`).replace(/^\/+|\/+$/g, '')
      files.push(...collectFiles(dir, target))
    }
  } catch (err) {
    console.warn('[payload] 读取 boards.json 失败：', err.message)
  }

  // 核心插件本体
  if (fs.existsSync(PLUGIN_SOURCE_DIR)) {
    for (const sub of ['dist', 'lib']) {
      const dir = path.join(PLUGIN_SOURCE_DIR, sub)
      if (fs.existsSync(dir)) files.push(...collectFiles(dir, `${PLUGIN_INSTALL_REL}/${sub}`))
    }
    for (const f of ['package.json', 'cordis.patch.yml']) {
      add(path.join(PLUGIN_SOURCE_DIR, f), `${PLUGIN_INSTALL_REL}/${f}`)
    }
  } else {
    console.warn('[payload] 插件源目录不存在，安装后无法 wire 插件：', PLUGIN_SOURCE_DIR)
  }

  return files
}

/** 把核心板块接进 profile 时，link: 指向**安装后的插件目录** */
function corePluginLinkPath() {
  return path.join(TARGET_DIR, 'app', ...PLUGIN_INSTALL_REL.split('/'))
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGING_ROOT, 'distribution.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

/** 允许从向导页打开的外链（加域名要在这里加，别在渲染层判断） */
const ALLOWED_EXTERNAL = [/^https:\/\/nodejs\.org(\/|$)/i, /^https:\/\/npmmirror\.com(\/|$)/i]

const WIN_OPTIONS = {
  width: 960,
  height: 680,
  minWidth: 860,
  minHeight: 600,
  backgroundColor: '#0a0e1a',
  show: false,
  autoHideMenuBar: true,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
}

/** @type {BrowserWindow | null} */
let win = null

function createWindow() {
  win = new BrowserWindow(WIN_OPTIONS)
  win.loadFile(path.join(WIZARD_DIR, 'index.html'))
  win.once('ready-to-show', () => win && win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ALLOWED_EXTERNAL.some((re) => re.test(url))) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })

  if (SELFTEST) win.webContents.once('did-finish-load', () => runSelfTest())
  if (SMOKE) win.webContents.once('did-finish-load', () => runSmokeTest())
}

/** 轮询直到条件成立（渲染层异步渲染用） */
async function pollUntil(check, { timeoutMs = 25000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last?.ok) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { ok: false, timeout: true, last }
}

/**
 * 冒烟测试：模拟「新用户从启动向导到 LV0 协议页」的全路径，**走真实 UI 点击**。
 * 判定结果写入 artifacts/qa/smoke-report.json，退出码 0=PASS / 1=FAIL。
 * 由 scripts/smoke-test.mjs 调用，也可手动带环境变量启动 electron。
 */
async function runSmokeTest() {
  const report = { mode: 'smoke', startedAt: new Date().toISOString(), steps: [], result: 'FAIL', targetDir: TARGET_DIR }
  const step = (name, data, ok) => {
    report.steps.push({ name, data, ok: ok ?? true })
    console.log(`[smoke] ${ok === false ? '✖' : '✔'} ${name}`, JSON.stringify(data))
  }
  const js = (expr) => win.webContents.executeJavaScript(expr)

  try {
    // 1. 向导首屏
    const shellInfo = await js(`({
      steps: document.querySelectorAll('.step').length,
      hasInstallBtn: !!document.getElementById('btn-install'),
      title: document.querySelector('header h1')?.textContent ?? '',
    })`)
    step('向导首屏渲染', shellInfo, shellInfo.steps === 5 && shellInfo.hasInstallBtn)

    // 2. 环境检测（页面加载即自动执行）
    const env = await pollUntil(() =>
      js(`(() => {
        const c = document.getElementById('env-card')
        if (!c || c.dataset.state === 'idle' || c.dataset.state === 'checking') return { ok: false }
        return { ok: true, state: c.dataset.state,
                 code: document.getElementById('env-code')?.textContent,
                 pill: document.getElementById('env-pill')?.textContent }
      })()`),
    )
    step('运行环境自动检测', env, env.ok === true && env.state === 'ok' && env.code === 'OK')

    // 3. 板块默认勾选（新用户开箱默认）
    const boards = await js(`(() => {
      const boxes = [...document.querySelectorAll('label.board input[type="checkbox"]')]
      return { total: boxes.length, checked: boxes.filter((b) => b.checked).length,
               coreDisabled: !!boxes.find((b) => b.dataset.board === 'core')?.disabled }
    })()`)
    step('板块默认勾选', boards, boards.total === 5 && boards.coreDisabled === true && boards.checked === 4)

    // 4. 新用户点「开始安装」
    await js(`document.getElementById('btn-install').click(); true`)
    const installed = await pollUntil(() =>
      js(`(() => {
        const meta = document.getElementById('install-meta')
        const hint = document.getElementById('install-hint')
        const text = meta?.hidden ? '' : (meta?.textContent ?? '')
        if (!text.includes('已安装')) return { ok: false, hint: hint?.textContent }
        return { ok: true, meta: text, hint: hint?.textContent }
      })()`),
    )
    step('点击安装并完成', installed, installed.ok === true)

    // 5. 落盘核验（主进程直接读文件系统，不信任 UI 自述）
    const { pathsFor } = require('./lib/installer')
    const P = pathsFor(TARGET_DIR)
    const manifestPath = path.join(P.app, 'install-manifest.json')
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null
    const version = readVersion()
    const disk = {
      appExists: fs.existsSync(P.app),
      manifestVersion: manifest?.version ?? null,
      expectedVersion: version,
      fileCount: manifest?.files?.length ?? 0,
      boards: manifest?.boards ?? [],
    }
    step(
      '安装落盘核验',
      disk,
      disk.appExists && disk.manifestVersion === version && disk.fileCount >= 3 && disk.boards.includes('core'),
    )

    // 6. LV0 协议页入口（当前为占位，但入口与文案必须在）
    const lv0 = await js(`(() => {
      const s = document.getElementById('lv0-section')
      const t = s?.textContent ?? ''
      return { exists: !!s, hasLv0: t.includes('LV0'), hasLv1: t.includes('LV1'),
               state: document.getElementById('lv0-state')?.textContent ?? '' }
    })()`)
    step('LV0 协议页入口', lv0, lv0.exists === true && lv0.hasLv0 === true && lv0.hasLv1 === true)

    // 6.5 真实载荷核验：插件是否真的装进 app/plugin，且 profile 接线指向它
    const pluginEntry = path.join(TARGET_DIR, 'app', ...PLUGIN_INSTALL_REL.split('/'), 'dist', 'index.js')
    let wired = { hasDep: false, linkOk: false, inBundles: false }
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'))
      const dep = pj.dependencies?.[CORE_PLUGIN_NAME]
      wired = {
        hasDep: typeof dep === 'string',
        linkOk: typeof dep === 'string' && path.resolve(dep.replace(/^link:/, '')).toLowerCase() === path.resolve(corePluginLinkPath()).toLowerCase(),
        inBundles: (pj.dsh?.profile?.bundles ?? []).includes(CORE_PLUGIN_NAME),
      }
    } catch (err) {
      wired = { hasDep: false, linkOk: false, inBundles: false, error: err.message }
    }
    const payloadOk = fs.existsSync(pluginEntry) && wired.hasDep && wired.linkOk && wired.inBundles
    step('真实载荷与 profile 接线', { pluginEntryExists: fs.existsSync(pluginEntry), ...wired }, payloadOk)

    // 7. 截图留证（可选步骤：capturePage 在窗口最小化/GPU 异常时会抛 UnknownVizError，
    //    这属于取证失败而不是功能失败，不能让整条冒烟挂掉）
    try {
      if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
      const image = await win.webContents.capturePage()
      fs.writeFileSync(path.join(ARTIFACTS_DIR, 'smoke-wizard.png'), image.toPNG())
      step('截图', 'artifacts/qa/smoke-wizard.png', true)
    } catch (err) {
      step('截图（可选，失败不判功能失败）', `capturePage 失败：${err?.message ?? err}`, true)
    }

    // 8. 测试后清理（避免占用真实安装位）
    const un = await js(`window.dshTraining.uninstall()`)
    step('测试后清理', { removed: un?.removedFiles, leftovers: un?.leftovers?.length ?? -1 }, un?.ok === true && (un?.leftovers?.length ?? 1) === 0)

    report.result = report.steps.every((s) => s.ok) ? 'PASS' : 'FAIL'
  } catch (err) {
    step('异常', { message: err?.message ?? String(err) }, false)
    report.result = 'FAIL'
  } finally {
    report.finishedAt = new Date().toISOString()
    try {
      if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
      fs.writeFileSync(path.join(ARTIFACTS_DIR, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    } catch (e) {
      console.error('[smoke] 写报告失败', e.message)
    }
    console.log(`[smoke] RESULT=${report.result}`)
    app.exit(report.result === 'PASS' ? 0 : 1)
  }
}

/**
 * 自检：在真实 Electron 里跑一遍「渲染进程 → preload → 主进程 IPC」链路，
 * 把结果写成 artifacts/qa/selftest-report.json，并截一张真实渲染图。
 * 仅 QA 用（DSH_TRAINING_SELFTEST=1），不影响正常启动。
 */
async function runSelfTest() {
  const report = { startedAt: new Date().toISOString(), steps: [], result: 'FAIL' }
  const step = (name, data) => {
    report.steps.push({ name, data })
    console.log(`[selftest] ${name}`, JSON.stringify(data))
  }

  try {
    await new Promise((r) => setTimeout(r, 700)) // 等向导页自动检测跑完并渲染

    const detect = await win.webContents.executeJavaScript('window.dshTraining.detectNode()')
    step('detectNode', { code: detect?.code, ok: detect?.ok, actual: detect?.actual, minimum: detect?.minimum })

    const info = await win.webContents.executeJavaScript('window.dshTraining.runtimeInfo()')
    step('runtimeInfo', info)

    const denied = await win.webContents.executeJavaScript(
      "window.dshTraining.openExternal('https://evil.example.com/steal')",
    )
    step('openExternal(未白名单，应被拒)', denied)

    const caps = await win.webContents.executeJavaScript('window.dshTraining.capabilities')
    step('capabilities', caps)

    // 阶段二第 2 步：安装线 IPC 自检（需 DSH_TRAINING_SELFTEST_INSTALL=1，且目标目录指向临时目录）
    let installOk = true
    if (process.env.DSH_TRAINING_SELFTEST_INSTALL === '1') {
      const install1 = await win.webContents.executeJavaScript('window.dshTraining.install({ boards: ["core"] })')
      step('install#1（首次，无备份）', install1)
      const install2 = await win.webContents.executeJavaScript(
        'window.dshTraining.install({ boards: ["core","character-txzf"] })',
      )
      step('install#2（升级，产生备份）', install2)
      const st1 = await win.webContents.executeJavaScript('window.dshTraining.status()')
      step('status（升级后）', { installed: st1.installed, version: st1.manifest?.version, canRollback: st1.canRollback })
      const rb = await win.webContents.executeJavaScript('window.dshTraining.rollback()')
      step('rollback', rb)
      const st2 = await win.webContents.executeJavaScript('window.dshTraining.status()')
      step('status（回滚后）', { installed: st2.installed, version: st2.manifest?.version })
      installOk = install1?.ok === true && install2?.ok === true && st1?.canRollback === true && rb?.ok === true && st2?.installed === true
      report.installOk = installOk
    }

    // UI 状态核对：卡片是否进入 ok 状态、安装按钮是否仍锁着（install 未接）
    const uiState = await win.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('env-card')
      return {
        state: card?.dataset.state,
        pill: document.getElementById('env-pill')?.textContent,
        code: document.getElementById('env-code')?.textContent,
        installDisabled: document.getElementById('btn-install')?.disabled,
        downloadHidden: document.getElementById('btn-download')?.hidden,
      }
    })()`)
    step('UI 状态', uiState)

    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
    const image = await win.webContents.capturePage()
    const shotName = `selftest-wizard-${detect?.code ?? 'unknown'}.png`
    fs.writeFileSync(path.join(ARTIFACTS_DIR, shotName), image.toPNG())
    step('screenshot', `artifacts/${shotName}`)

    // 期望的错误码：默认 OK；可用 DSH_TRAINING_SELFTEST_EXPECT=E-101|E-102 验证失败态界面
    const EXPECT = process.env.DSH_TRAINING_SELFTEST_EXPECT || 'OK'
    report.expect = EXPECT

    // UI 断言：成功态要求「检测显示通过、安装按钮可点、下载页隐藏」；
    // 失败态要求「状态等于错误码、下载页可见、安装按钮锁着」
    const uiOk =
      EXPECT === 'OK'
        ? uiState?.state === 'ok' && uiState?.installDisabled === false && uiState?.downloadHidden === true
        : uiState?.state === EXPECT && uiState?.installDisabled === true && uiState?.downloadHidden === false

    const pass =
      detect?.code === EXPECT &&
      typeof info?.electron === 'string' &&
      denied?.ok === false &&
      caps?.detectNode === true &&
      caps?.install === true &&
      uiOk &&
      installOk
    report.result = pass ? 'PASS' : 'FAIL'
  } catch (err) {
    step('exception', { message: err?.message ?? String(err) })
    report.result = 'FAIL'
  } finally {
    report.finishedAt = new Date().toISOString()
    try {
      if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
      fs.writeFileSync(path.join(ARTIFACTS_DIR, 'selftest-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    } catch (e) {
      console.error('[selftest] 写报告失败', e.message)
    }
    console.log(`[selftest] RESULT=${report.result}`)
    app.exit(report.result === 'PASS' ? 0 : 1)
  }
}

// --- IPC：只读能力 ---------------------------------------------------------

ipcMain.handle('dsh-training:runtime-info', () => ({
  shellVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}))

/**
 * Node 运行时检测。
 * 核心逻辑在 lib/detect-runtime.js（不依赖 Electron，可被 Node 单测复现 E-101/E-102）。
 */
ipcMain.handle('dsh-training:detect-node', () => {
  const started = Date.now()
  const result = detectRuntime()
  const elapsedMs = Date.now() - started
  console.log(`[detect-node] code=${result.code} actual=${result.actual} minimum=${result.minimum} ${elapsedMs}ms`)
  return { ...result, elapsedMs, at: new Date().toISOString() }
})

/** 打开外链（白名单） */
ipcMain.handle('dsh-training:open-external', (_event, url) => {
  if (typeof url !== 'string' || !ALLOWED_EXTERNAL.some((re) => re.test(url))) {
    console.warn(`[open-external] 拒绝非白名单 URL：${String(url).slice(0, 120)}`)
    return { ok: false, error: 'URL_NOT_ALLOWED' }
  }
  shell.openExternal(url)
  return { ok: true }
})

// --- IPC：安装 / 回滚 / 状态（阶段二第 2 步）-------------------------------

ipcMain.handle('dsh-training:status', () => getStatus({ targetDir: TARGET_DIR }))

ipcMain.handle('dsh-training:install', async (event, opts = {}) => {
  const boards = Array.isArray(opts.boards) ? opts.boards : []
  try {
    const result = await runInstall({
      targetDir: TARGET_DIR,
      payload: buildPayload(),
      version: readVersion(),
      boards,
      profileWire: { profileDir: PROFILE_DIR, packageName: CORE_PLUGIN_NAME, linkPath: corePluginLinkPath() },
      onProgress: (p) => {
        // 进度事件走独立通道，渲染层订阅即可
        if (!event.sender.isDestroyed()) event.sender.send('dsh-training:install-progress', p)
      },
    })
    return { ok: true, version: result.version, fileCount: result.fileCount, backupDir: result.backupDir, targetDir: TARGET_DIR, externalWrites: result.manifest?.externalWrites ?? [] }
  } catch (err) {
    console.error(`[install] 失败 code=${err.code} ${err.message}`)
    return { ok: false, code: err.code ?? 'E-207', message: err.message }
  }
})

ipcMain.handle('dsh-training:rollback', async () => {
  try {
    const result = await runRollback({ targetDir: TARGET_DIR })
    return { ok: true, restoredFrom: result.restoredFrom }
  } catch (err) {
    console.error(`[rollback] 失败 code=${err.code} ${err.message}`)
    return { ok: false, code: err.code ?? 'E-401', message: err.message }
  }
})

ipcMain.handle('dsh-training:uninstall', async () => {
  try {
    return { ok: true, ...(await runUninstall({ targetDir: TARGET_DIR })) }
  } catch (err) {
    return { ok: false, code: err.code ?? 'E-303', message: err.message }
  }
})

// TODO(阶段三): 代码签名、自动更新、控制面板板块增删

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
