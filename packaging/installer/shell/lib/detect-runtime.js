/**
 * detect-runtime.js · Node 运行时检测核心（**不依赖 Electron**，可单测）
 * ---------------------------------------------------------------------------
 * 为什么要拆出来：main.js 里直接写检测逻辑，就只能在 Electron 里跑，
 * 无法用 Node 复现 E-101/E-102。拆成纯模块后：
 *   - 可被 main.js 的 IPC handler 调用；
 *   - 可被 packaging/scripts/test-detect-node.mjs 用 PATH 手段真实复现三种结果。
 *
 * 契约（与 runtime/node-requirements.json 对齐）：
 *   - 只读：不下载、不安装、不改系统组件
 *   - 返回结构化结果，中文文案由本模块产出，向导只负责渲染
 *
 * 返回结构：
 *   { ok: boolean, code: 'OK'|'E-101'|'E-102', actual: string|null,
 *     minimum: string, message: string, actions: string[], hint?: string }
 * ---------------------------------------------------------------------------
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const REQ_PATH = path.join(__dirname, '..', '..', '..', 'runtime', 'node-requirements.json')

/** 读取最低版本要求；读不到时用硬编码兜底，避免检测本身崩掉 */
function readRequirement() {
  // QA 钩子：允许用环境变量抬/降门槛，用于**端到端复现 E-102**（真机 Node 是新版，
  // 不改门槛就永远走不到「版本过低」分支）。生产环境不设置该变量即为文件里的值。
  const override = process.env.DSH_TRAINING_NODE_MIN
  try {
    const req = JSON.parse(readFileSync(REQ_PATH, 'utf8'))
    const minimum = /^\d+\.\d+\.\d+$/.test(override ?? '') ? override : req.minimum || '22.19.0'
    return {
      minimum,
      onMissing: req.onMissing?.actions ?? [],
      onTooOldHint: req.onTooOld?.hint ?? '检测到 Node {actual}，低于最低要求 {minimum}。',
    }
  } catch {
    const minimum = /^\d+\.\d+\.\d+$/.test(override ?? '') ? override : '22.19.0'
    return { minimum, onMissing: [], onTooOldHint: '检测到 Node {actual}，低于最低要求 {minimum}。' }
  }
}

function parseVersion(raw) {
  const m = String(raw).trim().match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function gte(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return true
}

/**
 * 执行检测。
 * @param {{ probe?: (cmd: string, args: string[]) => string }} [opts] 注入探针，便于单测
 * @returns {{ok:boolean, code:string, actual:string|null, minimum:string, message:string, actions:string[], hint?:string}}
 */
function detectRuntime(opts = {}) {
  const req = readRequirement()
  const probe = opts.probe ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())

  const base = { minimum: req.minimum, actual: null, actions: req.onMissing }

  try {
    const out = probe('node', ['-v'])
    const actual = parseVersion(out)
    if (!actual) {
      return {
        ...base,
        ok: false,
        code: 'E-101',
        message: `检测到了 node 命令，但无法解析版本号（输出：${out.slice(0, 40)}）。`,
        hint: '可能 PATH 里是损坏的 node 安装。请重装 Node，或改用便携版（内置运行时）。',
      }
    }
    const actualStr = actual.join('.')
    if (gte(actual, parseVersion(req.minimum))) {
      return { ...base, ok: true, code: 'OK', actual: actualStr, message: `Node ${actualStr} 可用（最低要求 ${req.minimum}）`, actions: [] }
    }
    return {
      ...base,
      ok: false,
      code: 'E-102',
      actual: actualStr,
      message: req.onTooOldHint.replace('{actual}', actualStr).replace('{minimum}', req.minimum),
      hint: '升级 Node 后点「重新检测」，或改用便携版（内置运行时，不需要系统 Node）。',
    }
  } catch (err) {
    const missing = err && (err.code === 'ENOENT' || /ENOENT|not recognized|不是内部或外部命令/i.test(String(err.message)))
    return {
      ...base,
      ok: false,
      code: 'E-101',
      message: missing
        ? `未检测到 Node 运行时（命令 node 不存在）。本安装包不会自动安装系统级组件。`
        : `检测 Node 时出错：${String(err.message).split('\n')[0]}`,
      hint: missing
        ? '可以：① 去官网装 Node 后点「重新检测」；② 直接用便携版（自带运行时）。'
        : '请点「查看日志」把错误发给培训助手。',
    }
  }
}

module.exports = { detectRuntime, parseVersion, gte }
