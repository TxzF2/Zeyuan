/**
 * dsh-training 安装器外壳 · preload（阶段一骨架）
 * ---------------------------------------------------------------------------
 * 只暴露白名单 API：window.dshTraining
 * 严禁在此暴露 require / ipcRenderer 原始对象（否则 contextIsolation 形同虚设）。
 * ---------------------------------------------------------------------------
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshTraining', {
  /** 外壳与运行时版本信息（只读） */
  runtimeInfo: () => ipcRenderer.invoke('dsh-training:runtime-info'),

  /** 阶段一：占位，向导页据此显示「该能力阶段二解锁」 */
  capabilities: {
    detectNode: false,
    install: false,
    rollback: false,
  },

  // TODO(阶段二): detectNode / install / rollback 各自替换为真实 invoke，
  //               并同步把上面的 capabilities 置 true。
})
