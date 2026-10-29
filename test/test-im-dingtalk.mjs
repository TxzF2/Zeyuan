// 泽元 IM · 钉钉推送测试（本地 mock 服务器，不联网）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHmac } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = resolve(ROOT, 'plugins/zeyuan-im/dist')

const STATE = mkdtempSync(join(tmpdir(), 'zeyuan-im-'))
mkdirSync(join(STATE, 'data'), { recursive: true })
process.env.DSH_TRAINING_STATE_DIR = STATE

const load = (f) => import(pathToFileURL(resolve(DIST, f)).href)
const push = await load('push.js')

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${typeof actual === 'object' ? JSON.stringify(actual) : actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const checkTrue = (label, cond, detail = '') => {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log(`   细节：${detail}`)
}

// ---------- mock 钉钉 ----------
const received = []
let mode = 'ok'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    received.push({ body: JSON.parse(body || '{}'), query: Object.fromEntries(url.searchParams) })
    if (mode === 'fail') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errcode: 310000, errmsg: 'invalid token' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
let mockBase = ''
const port = server.address().port
mockBase = `http://127.0.0.1:${port}`
const webhook = () => `${mockBase}/robot/send?access_token=abcdef0123456789abcdef`

test('mask: webhook 脱敏只留首尾', () => {
  const m = push.maskWebhook(webhook())
  checkTrue('含省略号', m.includes('…'))
  checkTrue('不含完整 token', !m.includes('abcdef0123456789abcdef'))
  checkTrue('保留末 6 位', m.includes('abcdef'))
})

test('sign: 配置 secret 时带 timestamp+sign，且签名可复核', async () => {
  received.length = 0
  const now = 1730000000000
  const url = push.signUrl(webhook() + '&x=1', 'SECxyz', now)
  const u = new URL(url)
  check('timestamp', u.searchParams.get('timestamp'), String(now))
  const expect = createHmac('sha256', 'SECxyz').update(`${now}\nSECxyz`).digest('base64')
  check('sign 正确', u.searchParams.get('sign'), expect)
})

test('send: 成功返回 attempts=1 且 payload 为 markdown', async () => {
  received.length = 0
  const r = await push.sendDingTalk({ webhook: webhook() }, push.markdownMessage('标题', '### 正文'), { fetchImpl: fetch })
  check('ok', r.ok, true)
  check('attempts', r.attempts, 1)
  check('msgtype', received[0].body.msgtype, 'markdown')
})

test('send: 钉钉 errcode != 0 视为失败并重试', async () => {
  received.length = 0
  mode = 'fail'
  const r = await push.sendDingTalk({ webhook: webhook() }, push.textMessage('x'), { retries: 1, fetchImpl: fetch })
  check('ok=false', r.ok, false)
  check('尝试 2 次', r.attempts, 2)
  checkTrue('错误含 errcode', String(r.error).includes('310000'), r.error)
  mode = 'ok'
})

test('render: 三种任务事件文案正确', () => {
  const c = push.renderTaskEvent('claimed', { taskId: 't1', title: '写周报', to: 'alice' })
  checkTrue('领取含标题', c.text.includes('写周报'))
  checkTrue('领取含任务ID', c.text.includes('t1'))
  checkTrue('领取含领取人', c.text.includes('alice'))
  const a = push.renderTaskEvent('accepted', { taskId: 't2', title: '交付物', to: 'bob', bounty: 50 })
  checkTrue('验收含赏金', a.text.includes('50'))
  const j = push.renderTaskEvent('rejected', { taskId: 't3', title: '草稿', actor: 'carol', reason: '格式不对' })
  checkTrue('驳回含原因', j.text.includes('格式不对'))
})

test('service: 事件 → 推送（配置后）', async () => {
  const svc = await load('index.js')
  received.length = 0
  svc.writeConfig({ webhook: webhook(), enabled: true })
  const r = await svc.notifyTaskEvent('accepted', { taskId: 't9', title: '联调任务', to: 'alice', bounty: 20 })
  check('ok', r.ok, true)
  checkTrue('mock 收到 1 条', received.length === 1)
  check('markdown 标题含验收', received[0].body.markdown.title.includes('验收通过'), true)
})

test('service: 未配置时跳过且不报错', async () => {
  const svc = await load('index.js')
  svc.writeConfig({ webhook: '', enabled: true })
  const r = await svc.notifyTaskEvent('claimed', { taskId: 't10' })
  check('ok=false', r.ok, false)
  check('skipped=not-configured', r.skipped, 'not-configured')
})

after(() => {
  server.close()
  rmSync(STATE, { recursive: true, force: true })
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  if (fail > 0) process.exitCode = 1
})
