#!/usr/bin/env node
/** test-workbench-model.mjs · 草稿模型与状态 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const m = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-workbench/dist/draft.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const checkTrue = (label, cond, detail = '') => {
  check(label, Boolean(cond), true)
  if (!cond && detail) console.log(`   细节：${detail}`)
}

const NOW = new Date('2026-10-24T12:00:00.000Z')

console.log('=== 1 · 字段校验 ===')
const good = m.validateInput({ title: ' 交付物 ', body: 'hello', tags: ['a', 'a', 'b'] })
check('合法输入通过', good.ok, true)
check('title trim', good.value.title, '交付物')
check('tags 去重', good.value.tags.length, 2)
checkTrue('空 title 被拒', m.validateInput({ title: '  ' }).ok === false)
checkTrue('title 超长被拒', m.validateInput({ title: 'x'.repeat(m.LIMITS.title + 1) }).ok === false)
checkTrue('正文超长被拒', m.validateInput({ title: 't', body: 'y'.repeat(m.LIMITS.body + 1) }).ok === false)
checkTrue('标签超量被拒', m.validateInput({ title: 't', tags: Array.from({ length: m.LIMITS.tags + 1 }, (_, i) => `t${i}`) }).ok === false)
check('允许空正文', m.validateInput({ title: 't', body: '' }).ok, true)

console.log('\n=== 2 · ID ===')
check('id 格式', m.makeId(NOW, 3), 'd-20261024-0003')
check('id 补零', m.makeId(NOW, 42), 'd-20261024-0042')

console.log('\n=== 3 · 状态与权限 ===')
const draft = m.createDraft({ title: 't', body: '', tags: [] }, 'd-1', { owner: 'alice', sourceTaskId: 't-9', now: NOW })
check('初始 draft', draft.status, 'draft')
check('记录来源任务', draft.sourceTaskId, 't-9')
check('publishedAt 为空', draft.publishedAt, null)
check('本人可编辑', m.canEdit(draft, 'alice').ok, true)
check('他人不可编辑（E-902）', m.canEdit(draft, 'bob').code, 'E-902')

const saved = m.applySave(draft, { title: 't2', body: '内容', tags: ['x'] }, NOW)
check('保存更新标题', saved.title, 't2')
check('保存更新正文', saved.body, '内容')
check('保存不改状态', saved.status, 'draft')

const published = m.publishDraft(saved, NOW)
check('发布后 published', published.status, 'published')
check('发布记录时间', published.publishedAt !== null, true)
check('已发布不可编辑（E-901）', m.canEdit(published, 'alice').code, 'E-901')

console.log('\n=== 4 · 从任务事件建草稿 ===')
const env = {
  id: 'ev-1',
  type: 'dsh-training:tasks:task-accepted',
  payload: { taskId: 't-20261024-0001', to: 'alice', coins: 10 },
  subject: { taskId: 't-20261024-0001' },
}
const built = m.draftFromTaskEvent(env, 'd-2', NOW)
check('标题含任务号', built.value.title.includes('t-20261024-0001'), true)
check('owner=领取人', built.owner, 'alice')
check('sourceTaskId', built.sourceTaskId, 't-20261024-0001')
check('sourceEventId', built.sourceEventId, 'ev-1')
check('标签带任务号', built.value.tags[0], 't-20261024-0001')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
