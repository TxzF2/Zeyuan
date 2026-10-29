/**
 * push.ts · 钉钉群机器人推送（泽元 IM）
 * ---------------------------------------------------------------------------
 * 支持：
 *   - text / markdown 两种消息
 *   - 加签（若配置了 secret）：timestamp + HMAC-SHA256(secret, `${timestamp}\n${secret}`) → base64 → urlencode
 *   - 超时（默认 8s）+ 重试（默认 2 次）
 *
 * 安全：webhook 与 secret 只存本地 data/im.json（不发往任何第三方日志），
 *       对外只暴露脱敏形式（保留后 6 位 access_token）。
 * ---------------------------------------------------------------------------
 */

import { createHmac } from 'node:crypto'

export interface DingTalkConfig {
  webhook: string
  secret?: string
  enabled?: boolean
}

export interface PushResult {
  ok: boolean
  errcode?: number
  errmsg?: string
  status?: number
  attempts: number
  error?: string
}

/** 脱敏：只保留 https://oapi.dingtalk.com/robot/send?access_token=xxxx****xxxx */
export function maskWebhook(webhook: string | undefined | null): string {
  if (!webhook) return ''
  const m = webhook.match(/access_token=([^&]+)/)
  if (!m) return webhook.replace(/(access_token=)[^&]+/, '$1***')
  const token = m[1]
  const masked = token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-6)}` : '***'
  return webhook.replace(token, masked)
}

/** 加签后的完整 URL */
export function signUrl(webhook: string, secret?: string, now: number = Date.now()): string {
  if (!secret) return webhook
  const timestamp = String(now)
  const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  const u = new URL(webhook)
  u.searchParams.set('timestamp', timestamp)
  u.searchParams.set('sign', sign)
  return u.toString()
}

export function textMessage(content: string, atMobiles: string[] = []): Record<string, unknown> {
  return { msgtype: 'text', text: { content }, at: { atMobiles, isAtAll: false } }
}

export function markdownMessage(title: string, text: string): Record<string, unknown> {
  return { msgtype: 'markdown', markdown: { title, text } }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 发送一条到钉钉；失败按指数退避重试 */
export async function sendDingTalk(
  cfg: DingTalkConfig,
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  const { timeoutMs = 8000, retries = 2 } = opts
  const doFetch = opts.fetchImpl ?? fetch
  if (!cfg?.webhook) return { ok: false, attempts: 0, error: '未配置 webhook' }

  let lastError = ''
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(signUrl(cfg.webhook, cfg.secret), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
      clearTimeout(timer)
      if (res.ok && (body.errcode === 0 || body.errcode === undefined)) {
        return { ok: true, status: res.status, errcode: body.errcode, errmsg: body.errmsg, attempts: attempt }
      }
      lastError = `HTTP ${res.status} errcode=${body.errcode ?? '-'} ${body.errmsg ?? ''}`.trim()
    } catch (err) {
      clearTimeout(timer)
      lastError = (err as Error).name === 'AbortError' ? `超时 ${timeoutMs}ms` : (err as Error).message
    }
    if (attempt <= retries) sleep(300 * attempt)
  }
  return { ok: false, attempts: retries + 1, error: lastError }
}

// ---------------------------------------------------------------- 事件文案
export interface TaskEventPayload {
  taskId?: string
  title?: string
  actor?: string
  to?: string
  creator?: string
  bounty?: number
  reason?: string
}

/** 任务事件 → 钉钉 markdown 文案（领取/验收/驳回） */
export function renderTaskEvent(kind: 'claimed' | 'accepted' | 'rejected', p: TaskEventPayload): { title: string; text: string } {
  const titleMap = { claimed: '任务被领取', accepted: '任务验收通过', rejected: '任务被驳回' } as const
  const emoji = { claimed: '📥', accepted: '✅', rejected: '↩️' } as const
  const title = `${emoji[kind]} 泽元 · ${titleMap[kind]}`
  const lines = [
    `### ${title}`,
    '',
    `- 任务：${p.title ?? p.taskId ?? '(未知)'}`,
    `- 任务ID：\`${p.taskId ?? '-'}\``,
  ]
  if (kind === 'claimed') lines.push(`- 领取人：${p.to ?? p.actor ?? '-'}`)
  if (kind === 'accepted') {
    lines.push(`- 领取人：${p.to ?? '-'}`)
    if (typeof p.bounty === 'number') lines.push(`- 赏金：${p.bounty} 金币`)
  }
  if (kind === 'rejected') {
    lines.push(`- 驳回人：${p.actor ?? '-'}`)
    if (p.reason) lines.push(`- 原因：${p.reason}`)
  }
  lines.push('', `> 时间：${new Date().toLocaleString('zh-CN')}`)
  return { title, text: lines.join('\n') }
}
