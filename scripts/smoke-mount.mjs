#!/usr/bin/env node
// 强制隔离：冒烟挂载不能往真实状态目录写 mount-events（否则会把 A5 的最后一条事件覆盖成 host:"node"）
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.env.DSH_TRAINING_STATE_DIR) {
  process.env.DSH_TRAINING_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-smoke-mount-'))
}

/**
 * smoke-mount.mjs · 模块级冒烟测试（**不等于 loader 挂载验证**）
 * ---------------------------------------------------------------------------
 * 作用：直接 import 构建产物 dist/index.js，用一个最小的假 ctx 调用 apply()，
 *      验证插件模块可被 Node 正常加载、apply() 不抛异常、并打印出挂载标记行。
 *
 * 边界声明：
 *   通过本脚本 ≠ 插件已被 DSH 的 cordis loader 挂载。
 *   真正的 loader 挂载必须由 DSH 进程内完成，桌面端需重启应用后才会发生。
 *
 * 用法：node scripts/smoke-mount.mjs
 * 退出码：0 = 冒烟通过；1 = 失败
 * ---------------------------------------------------------------------------
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, '..', 'plugins', 'zeyuan-protocol', 'dist', 'index.js')

if (!existsSync(ENTRY)) {
  console.error(`❌ 找不到构建产物：${ENTRY}\n   请先在插件目录执行 pnpm run build`)
  process.exit(1)
}

/** 极简 ctx 桩：只实现插件当前用到的 effect / on */
const disposers = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  on() {
    /* 插件当前不监听任何事件 */
  },
}

let failures = 0
const origError = console.error
console.error = (...a) => {
  failures += 1
  origError(...a)
}

console.log(`模块入口：${ENTRY}\n--- 以下为插件自身输出 ---`)

try {
  const mod = await import(pathToFileURL(ENTRY).href)
  if (typeof mod.apply !== 'function') throw new Error('导出缺少 apply(ctx)')
  mod.apply(ctx)
} catch (err) {
  failures += 1
  console.error(`\n❌ apply() 执行失败：${err.stack ?? err.message}`)
}

console.log('--- 插件输出结束 ---')

// 卸载路径验证：disposer 应能正常执行（打印 DISPOSED）
for (const d of disposers) {
  try {
    d()
  } catch (err) {
    failures += 1
    console.error(`❌ disposer 执行失败：${err.message}`)
  }
}

const expected = 'mounted — LV0 · 未授权'
if (failures === 0) {
  console.log(`\n✅ 模块级冒烟通过（disposer ${disposers.length} 个已执行）`)
  console.log(`   预期关键字「${expected}」是否出现，请看上方插件输出。`)
  process.exit(0)
}
console.log(`\n❌ 冒烟失败，错误数 ${failures}`)
process.exit(1)
