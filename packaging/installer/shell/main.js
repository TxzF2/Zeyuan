/**
 * dsh-training 安装器外壳 · 主进程（阶段一骨架 · 最小可运行）
 * ---------------------------------------------------------------------------
 * 本轮目标：壳能起来、能显示向导窗口，其余全部留 TODO 给阶段二。
 * 明确不做：不装配运行时、不写 profile、不产出 exe。
 *
 * 安全基线（阶段二/三不得放宽）：
 *   - nodeIntegration: false
 *   - contextIsolation: true
 *   - 渲染进程只能通过 preload 暴露的白名单 API 与主进程通信
 * ---------------------------------------------------------------------------
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')

/** 阶段一固定尺寸；阶段二按向导页调整 */
const WIN_OPTIONS = {
  width: 960,
  height: 680,
  minWidth: 860,
  minHeight: 600,
  backgroundColor: '#0a0e1a', // 星辰底色，避免白屏闪烁
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

  // 外链一律交给系统浏览器，不在壳内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })
}

// --- IPC 白名单（阶段一只有探测/信息类，全部只读） -------------------------

/** 运行时信息：渲染进程显示用 */
ipcMain.handle('dsh-training:runtime-info', () => ({
  shellVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}))

// TODO(阶段二): 这里接三件事
//   1) 'dsh-training:detect-node'   → 调 packaging/runtime/detect-node.mjs（--json）
//   2) 'dsh-training:install'       → staging 装配 + 校验 + 原子替换（失败自动回滚）
//   3) 'dsh-training:rollback'      → 按装机清单回滚到上一版本

// TODO(阶段三): 代码签名、自动更新（electron-updater）、板块增删（控制面板）

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Windows 上关窗即退出；macOS 保留常驻
  if (process.platform !== 'darwin') app.quit()
})
