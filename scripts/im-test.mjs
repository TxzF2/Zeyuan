#!/usr/bin/env node
/**
 * im-test.mjs · 泽元 IM 钉钉一键配置 + 连通性测试
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/im-test.mjs --webhook "https://oapi.dingtalk.com/robot/send?access_token=xxx"
 *   node scripts/im-test.mjs --webhook "..." --secret "SECxxx"     # 机器人开了「加签」
 *   node scripts/im-test.mjs --show                                # 只看当前配置（脱敏）
 *   node scripts/im-test.mjs --send-only                           # 用现有配置发一条测试
 *
 * 存储：%LOCALAPPDATA%\zeyuan\data\im.json（H-KEY 档：仅本地，不进 git）
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const push = await import(pathToFileURL(join(ROOT, 'plugins/zeyuan-im/dist/push.js')).href)

const args = process.argv.slice(2)
const val = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (f) => args.includes(f)

const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'zeyuan')
const cfgPath = join(stateDir, 'data', 'im.json')

function readCfg() {
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch {
    return { schemaVersion: 1, dingtalk: { webhook: '', secret: '', enabled: false }, updatedAt: null }
  }
}

function writeCfg(dingtalk) {
  mkdirSync(dirname(cfgPath), { recursive: true })
  const doc = { schemaVersion: 1, dingtalk: { ...dingtalk, enabled: dingtalk.enabled !== false }, updatedAt: new Date().toISOString() }
  writeFileSync(cfgPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return doc
}

const webhookArg = val('--webhook')
const secretArg = val('--secret')
let cfg = readCfg().dingtalk

if (webhookArg) {
  if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=/.test(webhookArg)) {
    console.error('❌ webhook 必须是 https://oapi.dingtalk.com/robot/send?access_token=…')
    process.exit(1)
  }
  cfg = writeCfg({ webhook: webhookArg.trim(), secret: (secretArg ?? cfg.secret ?? '').trim(), enabled: true })
  console.log('✅ 已写入配置：' + cfgPath)
}

if (has('--show') || (!webhookArg && !has('--send-only'))) {
  console.log('当前配置（脱敏）：')
  console.log('  webhook :', push.maskWebhook(readCfg().dingtalk.webhook) || '(未配置)')
  console.log('  secret  :', readCfg().dingtalk.secret ? '已配置（不显示）' : '(未配置)')
  console.log('  文件    :', cfgPath, existsSync(cfgPath) ? '' : '（尚未创建）')
  if (!webhookArg && !has('--send-only')) {
    console.log('\n用法：node scripts/im-test.mjs --webhook "<钉钉 webhook>" [--secret "<加签密钥>"]')
    process.exit(0)
  }
}

const cur = readCfg().dingtalk
if (!cur.webhook) {
  console.error('❌ 还没有 webhook，先加 --webhook')
  process.exit(1)
}

console.log('\n发送测试消息…')
const r = await push.sendDingTalk(cur, push.textMessage('【泽元】钉钉连通性测试 ✅ 协作层已就绪'))
if (r.ok) {
  console.log(`✅ 发送成功（attempts=${r.attempts}，HTTP ${r.status}）——请到钉钉群确认收到`)
} else {
  console.error(`❌ 发送失败（attempts=${r.attempts}）：${r.error}`)
  process.exit(1)
}
