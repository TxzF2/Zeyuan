#!/usr/bin/env node
/** test-collab-model.mjs · 固定编制 1+3 / 满编激活 / 分工 / 转让 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const m = await import(pathToFileURL(resolve(ROOT, 'plugins/zeyuan-collab/dist/model.js')).href)

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  console.log(`${ok ? '✅' : '❌'} ${label}  → 实际 ${actual}${ok ? '' : `，期望 ${expected}`}`)
  ok ? pass++ : fail++
}
const codeOf = (fn) => {
  try {
    fn()
    return 'NO_ERROR'
  } catch (err) {
    return err.code ?? err.message
  }
}
const NOW = new Date('2026-10-24T12:00:00.000Z')

console.log('=== 1 · 创建与容量 ===')
let g = m.createGroup({ name: '第一小组', topic: '结项' }, 'bob', 'g-1', NOW)
check('容量固定 4', g.capacity, 4)
check('初始 1 人（组长）', g.members.length, 1)
check('组长分工默认 build', g.members[0].duty, 'build')
check('初始 forming', g.status, 'forming')
check('未满编不能激活', m.canActivate(g).ok, false)
check('未满编原因含编制', m.canActivate(g).reason.includes('编制未满'), true)

console.log('\n=== 2 · 加入至满编 ===')
g = m.joinGroup(g, 'alice', 'training', NOW)
g = m.joinGroup(g, 'carol', 'ops', NOW)
check('3 人', g.members.length, 3)
check('未满编仍不能激活', m.canActivate(g).ok, false)
g = m.joinGroup(g, 'dave', 'build', NOW)
check('满编 4 人', g.members.length, 4)
check('满编可激活', m.canActivate(g).ok, true)
check('满编后再加入 → E-1301', codeOf(() => m.joinGroup(g, 'eve', 'ops', NOW)), 'E-1301')
check('重复加入 → E-1301', codeOf(() => m.joinGroup(g, 'alice', 'ops', NOW)), 'E-1301')

console.log('\n=== 3 · 激活 ===')
g = m.activateGroup(g, NOW)
check('状态 active', g.status, 'active')
check('记录激活时间', g.activeSince !== null, true)
check('重复激活 → E-1301', codeOf(() => m.activateGroup(g, NOW)), 'E-1301')

console.log('\n=== 4 · 分工 ===')
g = m.setDuty(g, 'alice', '运营自定义', NOW)
check('分工可改', g.members.find((x) => x.userId === 'alice').duty, '运营自定义')
check('分工超长 → E-1303', codeOf(() => m.validateDuty('x'.repeat(m.LIMITS.duty + 1))), 'E-1303')
check('空分工 → E-1303', codeOf(() => m.validateDuty('')), 'E-1303')

console.log('\n=== 5 · 退出与转让 ===')
check('组长不能直接退出 → E-1301', codeOf(() => m.leaveGroup(g, 'bob', NOW)), 'E-1301')
check('非成员退出 → E-1302', codeOf(() => m.leaveGroup(g, 'ghost', NOW)), 'E-1302')
let g2 = m.leaveGroup(g, 'dave', NOW)
check('组员退出后 3 人', g2.members.length, 3)
check('不满编 → 回到 forming', g2.status, 'forming')
check('不能移除组长 → E-1301', codeOf(() => m.removeMember(g2, 'bob', NOW)), 'E-1301')
g2 = m.removeMember(g2, 'carol', NOW)
check('移除组员后 2 人', g2.members.length, 2)
check('转让给非成员 → E-1304', codeOf(() => m.transferLeader(g2, 'ghost', NOW)), 'E-1304')
g2 = m.transferLeader(g2, 'alice', NOW)
check('转让后组长=alice', g2.leader, 'alice')
check('原组长现在可退出', codeOf(() => m.leaveGroup(g2, 'bob', NOW)), 'NO_ERROR')

console.log('\n=== 6 · 任务与评审 ===')
check('未激活不能挂任务（构造 forming）', codeOf(() => m.attachTask({ ...g2, status: 'forming' }, 't-1', NOW)), 'E-1301')
const g3 = m.attachTask({ ...g, status: 'active' }, 't-1', NOW)
check('激活后可挂任务', g3.taskIds[0], 't-1')
check('重复挂载幂等', m.attachTask(g3, 't-1', NOW).taskIds.length, 1)
const g4 = m.requestReview(g3, 'd-1', 'alice', NOW)
check('发起评审', g4.reviewRequests.length, 1)
check('非成员评审 → E-1302', codeOf(() => m.requestReview(g4, 'd-2', 'ghost', NOW)), 'E-1302')
const g5 = m.doneReview(g4, g4.reviewRequests[0].id, 'bob', NOW)
check('评审完成', g5.reviewRequests[0].status, 'done')
check('评审不存在 → E-1304', codeOf(() => m.doneReview(g5, 'rv-x', 'bob', NOW)), 'E-1304')

console.log('\n=== 7 · 校验 ===')
check('空组名 → 错误', m.validateCreate({ name: '  ' }).ok, false)
check('组名超长 → 错误', m.validateCreate({ name: 'x'.repeat(m.LIMITS.name + 1) }).ok, false)
check('正常组名通过', m.validateCreate({ name: '组一' }).ok, true)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
