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

/** QA 钩子：DSH_TRAINING_SELFTEST=1 时走自检（跑通 IPC → 截图 → 写报告 → 退出） */
const SELFTEST = process.env.DSH_TRAINING_SELFTEST === '1'
const ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'artifacts')

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
  win.loadFile(path.join(__dirname, '..', 'wizard', 'index.html'))
  win.once('ready-to-show', () => win && win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ALLOWED_EXTERNAL.some((re) => re.test(url))) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })

  if (SELFTEST) win.webContents.once('did-finish-load', () => runSelfTest())
}

/**
 * 自检：在真实 Electron 里跑一遍「渲染进程 → preload → 主进程 IPC」链路，
 * 把结果写成 artifacts/selftest-report.json，并截一张真实渲染图。
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

    // UI 断言：成功态要求「按钮仍锁着、下载页隐藏」；失败态要求「状态、下载页可见、按钮锁着」
    const uiOk =
      EXPECT === 'OK'
        ? uiState?.state === 'ok' && uiState?.installDisabled === true && uiState?.downloadHidden === true
        : uiState?.state === EXPECT && uiState?.installDisabled === true && uiState?.downloadHidden === false

    const pass =
      detect?.code === EXPECT &&
      typeof info?.electron === 'string' &&
      denied?.ok === false &&
      caps?.detectNode === true &&
      caps?.install === false &&
      uiOk
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

// TODO(阶段二第 2 步): 'dsh-training:install' 与 'dsh-training:rollback'
//   staging 装配 → 校验 → 原子替换；失败自动回滚。rollback 作为 install 的子流程，不单独立项。

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
