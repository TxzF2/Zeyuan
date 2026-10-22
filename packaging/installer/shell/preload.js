/**
 * dsh-training 安装器外壳 · preload（阶段二 · 第 1 步）
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

  /** 能力表：向导页据此显示「阶段二/三解锁」而不是假装能点 */
  capabilities: {
    detectNode: true,
    install: false,
    rollback: false,
  },

  /** 官方下载页地址集中放这里，渲染层不写死 */
  links: {
    nodeDownload: 'https://nodejs.org/zh-cn/download',
  },
})
