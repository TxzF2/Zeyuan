/**
 * dsh-training 安装器外壳 · preload（阶段二第 2 步：安装 / 回滚已接通）
 * ---------------------------------------------------------------------------
 * 只暴露白名单 API：window.dshTraining
 * 严禁暴露 require / ipcRenderer 原始对象（否则 contextIsolation 形同虚设）。
 * ---------------------------------------------------------------------------
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshTraining', {
  /** 外壳与运行时版本信息（只读） */
  runtimeInfo: () => ipcRenderer.invoke('dsh-training:runtime-info'),

  /**
   * 检测本机 Node 运行时。
   * @returns {Promise<{ok:boolean, code:'OK'|'E-101'|'E-102', actual:string|null,
   *   minimum:string, message:string, actions:string[], hint?:string,
   *   elapsedMs:number, at:string}>}
   */
  detectNode: () => ipcRenderer.invoke('dsh-training:detect-node'),

  /** 打开外链（主进程侧有域名白名单） */
  openExternal: (url) => ipcRenderer.invoke('dsh-training:open-external', url),

  /** 安装状态：是否已装、版本、是否可回滚 */
  status: () => ipcRenderer.invoke('dsh-training:status'),

  /**
   * 开始安装（staging → 校验 → 原子替换；失败自动回滚）
   * @param {{boards?: string[]}} [opts]
   * @returns {Promise<{ok:boolean, version?:string, fileCount?:number, code?:string, message?:string}>}
   */
  install: (opts) => ipcRenderer.invoke('dsh-training:install', opts),

  /** 回滚到上一版本（install 的子流程，但允许单独触发） */
  rollback: () => ipcRenderer.invoke('dsh-training:rollback'),

  /** 卸载（只删装机清单内的文件） */
  uninstall: () => ipcRenderer.invoke('dsh-training:uninstall'),

  /**
   * 订阅安装进度。
   * @param {(p:{phase:string,percent:number,message:string})=>void} cb
   * @returns {() => void} 取消订阅
   */
  onInstallProgress: (cb) => {
    const handler = (_event, p) => cb(p)
    ipcRenderer.on('dsh-training:install-progress', handler)
    return () => ipcRenderer.removeListener('dsh-training:install-progress', handler)
  },

  /** 能力表：向导页据此决定按钮是否可点，不假装能点 */
  capabilities: {
    detectNode: true,
    install: true,
    rollback: true,
  },

  /** 外链地址集中放这里，渲染层不写死 */
  links: {
    nodeDownload: 'https://nodejs.org/zh-cn/download',
  },
})
