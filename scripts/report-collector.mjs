#!/usr/bin/env node
/**
 * report-collector.mjs · 三机上报收集器（方案 A 补：让汇总能自动合并两台上报）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/report-collector.mjs [--port 19501]
 *
 * 行为：
 *   - 监听 0.0.0.0:<port>（默认 19501），打印本机局域网 URL
 *   - POST /report  接收 {machine, at, done, blocked, next, host, node, head, ...}
 *     → 写 交付/evidence/machine-reports/<machine>-<ts>.json
 *   - GET  /health  返回 {ok:true, count}
 *   - 只接受内网来源（同网段/回环），拒绝公网请求
 *
 * 配合：
 *   machine-report.mjs --hub http://<本机IP>:19501/report
 *   coordination-brief.mjs 读取目录后合并进三栏表
 * ---------------------------------------------------------------------------
 */

import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, '交付', 'evidence', 'machine-reports')
const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.ZEYUAN_HUB_PORT ?? 19501)

mkdirSync(OUT, { recursive: true })

const isPrivate = (ip) => {
  if (!ip) return false
  const p = ip.replace(/^::ffff:/, '')
  return (
    p === '127.0.0.1' ||
    p === '::1' ||
    p.startsWith('10.') ||
    p.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(p)
  )
}

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`
  console.log(line)
  try {
    appendFileSync(join(OUT, '_collector.log'), line + '\n', 'utf8')
  } catch {}
}

const server = createServer((req, res) => {
  const ip = req.socket.remoteAddress
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  if (!isPrivate(ip)) {
    log(`⛔ 拒绝公网来源 ${ip}`)
    return send(403, { ok: false, error: 'only private networks allowed' })
  }
  if (req.method === 'GET' && req.url === '/health') {
    const n = existsSync(OUT) ? 0 : 0
    return send(200, { ok: true, port: PORT, n })
  }
  if (req.method !== 'POST' || req.url !== '/report') return send(404, { ok: false, error: 'not found' })

  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 64 * 1024) req.destroy()
  })
  req.on('end', () => {
    try {
      const j = JSON.parse(body || '{}')
      const machine = String(j.machine ?? 'unknown').replace(/[^\w.-]/g, '_')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const file = join(OUT, `${machine}-${ts}.json`)
      writeFileSync(file, JSON.stringify({ ...j, receivedAt: new Date().toISOString(), from: ip }, null, 2) + '\n', 'utf8')
      log(`✅ ${machine} 上报入库：${file}`)
      send(200, { ok: true, file })
    } catch (e) {
      log(`❌ 解析失败：${e.message}`)
      send(400, { ok: false, error: e.message })
    }
  })
})

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  log(`收集器已启动，端口 ${PORT}`)
  console.log('本机可用的上报地址（发给 dsh-2 / dsh-3）：')
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/report`)
  console.log(`  健康检查： http://127.0.0.1:${PORT}/health`)
  console.log(`  入库目录： ${OUT}`)
})
