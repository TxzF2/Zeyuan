#!/usr/bin/env node
/**
 * test-tasks-model.mjs · 任务模型与状态机（纯函数）
 */
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = resolve(HERE, '..', '..', 'plugins', 'zeyuan-tasks', 'dist', 'task.js')
const m = await import(pathToFileURL(MOD).href)

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
const later = '2026-11-01T00:00:00.000Z'

console.log('=== 1 · 创建校验 ===')
const good = m.validateCreate({ title: ' 补三个案例 ', description: '给手册补案例', tags: ['文档', '文档', '案例'], bounty: 50, deadline: later }, NOW)
check('合法输入通过', good.ok, true)
check('title 已 trim', good.value?.title, '补三个案例')
check('tags 去重', good.value?.tags.length, 2)
check('deadline 归一化', good.value?.deadline, new Date(later).toISOString())

const bad = [
  ['空标题', { title: '   ' }],
  ['标题超长', { title: 'x'.repeat(m.LIMITS.title + 1) }],
  ['标签超量', { title: 't', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ['标签超长', { title: 't', tags: ['y'.repeat(m.LIMITS.tagLength + 1)] }],
  ['赏金为负', { title: 't', bounty: -1 }],
  ['赏金非整数', { title: 't', bounty: 1.5 }],
  ['赏金超限', { title: 't', bounty: m.LIMITS.bounty + 1 }],
  ['截止时间已过', { title: 't', deadline: '2020-01-01T00:00:00.000Z' }],
  ['截止时间非法', { title: 't', deadline: 'not-a-date' }],
  ['描述超长', { title: 't', description: 'z'.repeat(m.LIMITS.description + 1) }],
]
for (const [name, input] of bad) {
  const r = m.validateCreate(input, NOW)
  checkTrue(`拦住：${name}`, r.ok === false, JSON.stringify(r.errors))
}
check('非法输入返回全部错误', m.validateCreate({ title: '', bounty: -5 }, NOW).errors?.length >= 2, true)

console.log('\n=== 2 · 状态机 ===')
const mk = (over = {}) => ({
  id: 't-1',
  title: 'x',
  description: '',
  tags: [],
  bounty: 10,
  deadline: null,
  creator: 'alice',
  assignee: null,
  status: 'open',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  history: [],
  ...over,
})

check('open 可被他人领取', m.checkAction(mk(), 'claim', 'bob').ok, true)
const own = m.checkAction(mk(), 'claim', 'alice')
check('不能领自己任务（E-802）', own.code, 'E-802')
check('claimed 不能再次 claim（E-801）', m.checkAction(mk({ status: 'claimed', assignee: 'bob' }), 'claim', 'bob').code, 'E-801')
check('submit 需要领取人', m.checkAction(mk({ status: 'claimed', assignee: 'bob' }), 'submit', 'alice').code, 'E-802')
check('领取人可提交', m.checkAction(mk({ status: 'claimed', assignee: 'bob' }), 'submit', 'bob').ok, true)
check('accept 仅发起人', m.checkAction(mk({ status: 'submitted', assignee: 'bob' }), 'accept', 'bob').code, 'E-802')
check('发起人可验收', m.checkAction(mk({ status: 'submitted', assignee: 'bob' }), 'accept', 'alice').ok, true)
check('reject 仅发起人', m.checkAction(mk({ status: 'submitted', assignee: 'bob' }), 'reject', 'carol').code, 'E-802')
check('open 不能直接 accept（E-801）', m.checkAction(mk(), 'accept', 'alice').code, 'E-801')
check('未知动作报 E-801', m.checkAction(mk(), 'nope', 'alice').code, 'E-801')

console.log('\n=== 3 · 迁移结果 ===')
const claimed = m.applyAction(mk(), 'claim', 'bob', NOW)
check('claim → claimed', claimed.status, 'claimed')
check('claim 写入 assignee', claimed.assignee, 'bob')
check('history 记 1 条', claimed.history.length, 1)
check('history 记录 from/to', `${claimed.history[0].from}->${claimed.history[0].to}`, 'open->claimed')

const submitted = m.applyAction(claimed, 'submit', 'bob', NOW)
const accepted = m.applyAction(submitted, 'accept', 'alice', NOW)
check('accept → accepted（终态）', accepted.status, 'accepted')
check('accepted 不能再 reject', m.checkAction(accepted, 'reject', 'alice').ok, false)

const rejected = m.applyAction(submitted, 'reject', 'alice', NOW, '不合格')
check('reject → open', rejected.status, 'open')
check('reject 清空 assignee（可再领取）', rejected.assignee, null)
check('reject 记录原因', rejected.history.at(-1).reason, '不合格')
check('reject 后可再领取', m.checkAction(rejected, 'claim', 'carol').ok, true)

console.log('\n=== 4 · id / 过滤 ===')
check('id 格式', m.makeId(NOW, 7), 't-20261024-0007')
check('id 序号补零', m.makeId(NOW, 1234), 't-20261024-1234')
const tasks = [
  mk({ id: 'a', status: 'open', tags: ['文档'], creator: 'alice' }),
  mk({ id: 'b', status: 'claimed', tags: ['案例'], creator: 'bob', assignee: 'alice' }),
]
check('按状态过滤', m.filterTasks(tasks, { status: 'claimed' }).length, 1)
check('全部状态', m.filterTasks(tasks, { status: 'all' }).length, 2)
check('按标签过滤', m.filterTasks(tasks, { tag: '文档' }).length, 1)
check('mine 含发起与领取', m.filterTasks(tasks, { mine: true, actor: 'alice' }).length, 2)

const created = m.createTask(good.value, 'alice', 't-9', NOW)
check('createTask 初始 open', created.status, 'open')
check('createTask 无领取人', created.assignee, null)
check('createTask 记录 creator', created.creator, 'alice')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
