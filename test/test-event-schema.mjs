// 事件信封 schema 一致性测试（D-008 收口）
// 1) 校验器本身：合法/非法样本
// 2) 所有插件源码：不得再构造旧信封（v/at/source/type/subject）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LIB = pathToFileURL(resolve(ROOT, 'packaging/scripts/lib/event-schema.mjs')).href
const { EVENT_ENVELOPE_KEYS, validateEvent, makeEvent } = await import(LIB)

test('schema: canonical envelope accepted, legacy/partial envelopes rejected', () => {
  const good = makeEvent('dsh-training:exchange:file-uploaded', { id: 'x1' }, 'node-a')
  assert.deepEqual(Object.keys(good).sort(), [...EVENT_ENVELOPE_KEYS].sort())
  assert.equal(validateEvent(good).ok, true, JSON.stringify(validateEvent(good).errors))

  const legacy = { v: 1, id: 'ev-1', at: new Date().toISOString(), source: 'exchange', type: 'dsh-training:exchange:file-uploaded', subject: {}, payload: {} }
  assert.equal(validateEvent(legacy).ok, false, '旧信封（v/at/type）必须被拒')

  const missingActor = { event: 'dsh-training:exchange:file-deleted', id: 'ev-2', ts: new Date().toISOString(), payload: {} }
  assert.equal(validateEvent(missingActor).ok, false, '缺 actor 必须被拒')

  const badName = makeEvent('exchange:file-uploaded')
  assert.equal(validateEvent(badName).ok, false, 'event 命名必须带 dsh-training: 前缀与三段')

  const badTs = { ...good, ts: 'not-a-date' }
  assert.equal(validateEvent(badTs).ok, false, 'ts 必须是 ISO')

  const badPayload = { ...good, payload: null }
  assert.equal(validateEvent(badPayload).ok, false, 'payload 必须是对象')

  const nullActor = makeEvent('dsh-training:exchange:file-expired', {}, null)
  assert.equal(validateEvent(nullActor).ok, true, '系统事件 actor 可为 null')
})

test('schema: every plugin emitter writes canonical envelope (no legacy keys)', () => {
  const pluginsDir = resolve(ROOT, 'plugins')
  const offenders = []
  for (const name of readdirSync(pluginsDir)) {
    const srcDir = join(pluginsDir, name, 'src')
    let files
    try {
      files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
    } catch {
      continue
    }
    for (const file of files) {
      const text = readFileSync(join(srcDir, file), 'utf8')
      // 只看构造信封的语句体
      const m = text.match(/const envelope = \{[\s\S]*?\n\s*\}/)
      if (!m) continue
      const block = m[0]
      for (const legacy of ['v: 1', 'at: new', 'source: ', 'type: ', 'subject:']) {
        if (block.includes(legacy)) offenders.push(`${name}/${file} 仍含 ${legacy}`)
      }
      for (const key of ['event:', 'ts:', 'actor:', 'payload']) {
        if (!block.includes(key)) offenders.push(`${name}/${file} 缺 ${key}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `以下位置未对齐统一信封：\n${offenders.join('\n')}`)
})
