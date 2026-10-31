#!/usr/bin/env node
/**
 * im-setup-local.mjs · 在**本机交互式**录入钉钉 webhook + 加签密钥
 * ---------------------------------------------------------------------------
 * 目的：让"钥匙"只留在本机（%LOCALAPPDATA%\zeyuan\data\im.json），
 *       不进命令行参数（避免 shell history）、不发群、不进对话。
 *
 * 用法（在仓库根目录）：
 *   node scripts/im-setup-local.mjs
 *   node scripts/im-setup-local.mjs --yes     # 配完直接发群通知 + 跑 R-219 测试
 *
 * 依次询问：
 *   1) Webhook（粘贴后回车）
 *   2) 加签密钥（SEC…，没有直接回车）
 * 然后：
 *   - 校验 webhook 格式
 *   - 写入本地 im.json（原子写）
 *   - 自动发一条群消息："调度机器人已建好，钥匙已私聊总控"
 *   - 自动发一条测试："R-219 联通测试 <当前时间>"
 *   - 打印回执（HTTP / errcode / attempts），不打印明文 key
 * ---------------------------------------------------------------------------
 */

import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const push = await import(pathToFileURL(join(ROOT, 'plugins/zeyuan-im/dist/push.js')).href)

const stateDir = process.env.DSH_TRAINING_STATE_DIR || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'zeyuan')
const cfgPath = join(stateDir, 'data', 'im.json')
const yes = process.argv.includes('--yes')

/** 把发送回执落成证据文件（供主控直接读取，无需人工转述） */
function writeEvidence(items) {
  const dir = join(ROOT, '交付', 'evidence')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'R-219-发送回执.jsonl')
  const row = { at: new Date().toISOString(), robot: '泽元参谋长', items }
  writeFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', flag: 'a' })
  console.log('\n📄 证据已落盘：' + file)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())))

console.log('=== 泽元 · 钉钉钥匙本机录入（不会显示/回传完整钥匙）===')
console.log('（在钉钉：群设置 → 智能群助手 → 添加机器人 → 自定义 → 勾选"加签" → 复制 webhook 与 SEC 密钥）\n')

const webhook = await ask('1) 粘贴 Webhook（https://oapi.dingtalk.com/robot/send?access_token=…）：\n> ')
if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=/.test(webhook)) {
  console.error('\n❌ 格式不对：必须以 https://oapi.dingtalk.com/robot/send?access_token= 开头')
  rl.close()
  process.exit(1)
}
const secret = await ask('\n2) 粘贴加签密钥（SEC…，没有就直接回车）：\n> ')

mkdirSync(dirname(cfgPath), { recursive: true })
const doc = { schemaVersion: 1, dingtalk: { webhook, secret: secret || '', enabled: true }, updatedAt: new Date().toISOString() }
writeFileSync(cfgPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')

console.log('\n✅ 已写入本地配置（明文只在本机文件，未打印、未入 shell 历史）：')
console.log('   文件    :', cfgPath)
console.log('   webhook :', push.maskWebhook(webhook))
console.log('   secret  :', secret ? '已配置（不显示）' : '未配置（若机器人开了加签，会报 sign 校验失败）')
rl.close()

// 可选：立即发两条消息
const shouldSend = yes || (await (async () => {
  const rl2 = createInterface({ input: process.stdin, output: process.stdout })
  const a = await new Promise((res) => rl2.question('\n是否现在发两条群消息（建好通知 + R-219 测试）？(y/N) ', (x) => res(x.trim().toLowerCase())))
  rl2.close()
  return a === 'y' || a === 'yes'
})())

if (!shouldSend) {
  console.log('\n已跳过发送。之后可单独跑：node scripts/im-notify.mjs --text "…"')
  process.exit(0)
}

const cfg = { webhook, secret: secret || '', enabled: true }
const now = new Date().toLocaleString('zh-CN', { hour12: false })

console.log('\n[1/2] 发送「调度机器人已建好」通知…')
const r1 = await push.sendDingTalk(cfg, push.textMessage('调度机器人已建好，钥匙已私聊总控'))
console.log(r1.ok ? `  ✅ HTTP ${r1.status} / errcode ${r1.errcode ?? 0} / attempts ${r1.attempts}` : `  ❌ ${r1.error}（attempts ${r1.attempts}）`)

console.log('\n[2/2] 发送 R-219 联通测试…')
const r2 = await push.sendDingTalk(cfg, push.textMessage(`R-219 联通测试 ${now}`))
console.log(r2.ok ? `  ✅ HTTP ${r2.status} / errcode ${r2.errcode ?? 0} / attempts ${r2.attempts}` : `  ❌ ${r2.error}（attempts ${r2.attempts}）`)

writeEvidence([
  { msg: '调度机器人已建好，钥匙已私聊总控', ok: r1.ok, status: r1.status ?? null, errcode: r1.errcode ?? null, attempts: r1.attempts },
  { msg: 'R-219 联通测试 ' + now, ok: r2.ok, status: r2.status ?? null, errcode: r2.errcode ?? null, attempts: r2.attempts },
])

if (!r1.ok || !r2.ok) {
  console.log('\n排查提示：errcode 310000 = 关键词不匹配 / 加签校验失败（检查是否勾了"加签"且密钥正确）')
  process.exit(1)
}
console.log('\n完成。请到钉钉群确认两条消息（含群成员列表一起截图即可作为 R-219 证据）。')
