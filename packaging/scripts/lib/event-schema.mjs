/** 统一事件信封 schema（总控裁决 2026-10-25）
 *  规范：{ event, id, ts, actor, payload }
 *  - event: 'dsh-training:<board>:<action>'
 *  - id: 非空字符串（建议 ev-<ms>-<rand>）
 *  - ts: ISO 8601 字符串
 *  - actor: 节点 id 或 null（匿名/系统事件）
 *  - payload: 对象（必填，可为 {}）
 */
export const EVENT_ENVELOPE_KEYS = ['event', 'id', 'ts', 'actor', 'payload']
export const EVENT_NAME_RE = /^dsh-training:[a-z0-9-]+:[a-z0-9-]+$/

export function validateEvent(env) {
  const errors = []
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, errors: ['信封必须是对象'] }
  const keys = Object.keys(env).sort()
  const expected = [...EVENT_ENVELOPE_KEYS].sort()
  if (keys.join(',') !== expected.join(',')) {
    const missing = expected.filter((k) => !keys.includes(k))
    const extra = keys.filter((k) => !expected.includes(k))
    errors.push(`字段不匹配${missing.length ? `，缺 ${missing.join('/')}` : ''}${extra.length ? `，多 ${extra.join('/')}` : ''}`)
  }
  if (typeof env.event !== 'string' || !EVENT_NAME_RE.test(env.event)) errors.push(`event 命名不合规：${env.event}`)
  if (typeof env.id !== 'string' || env.id.length < 6) errors.push('id 缺失或过短')
  if (typeof env.ts !== 'string' || Number.isNaN(Date.parse(env.ts))) errors.push('ts 不是合法 ISO 时间')
  if (!(env.actor === null || (typeof env.actor === 'string' && env.actor.length > 0))) errors.push('actor 必须是字符串或 null')
  if (!env.payload || typeof env.payload !== 'object' || Array.isArray(env.payload)) errors.push('payload 必须是对象')
  return { ok: errors.length === 0, errors }
}

export function makeEvent(event, payload = {}, actor = null, now = Date.now()) {
  return {
    event,
    id: `ev-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date(now).toISOString(),
    actor,
    payload,
  }
}
