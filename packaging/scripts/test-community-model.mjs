#!/usr/bin/env node
/** test-community-model.mjs · 帖子模型 / 三态 / 可见性 / 点赞 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const m = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-training-community/dist/post.js')).href)

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
const mk = (over = {}) => ({
  id: 'p-1',
  title: 't',
  body: 'b',
  tags: [],
  author: 'alice',
  sourceDraftId: null,
  sourceEventId: null,
  status: 'draft',
  likes: 0,
  likedBy: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  publishedAt: null,
  hiddenAt: null,
  hiddenBy: null,
  ...over,
})

console.log('=== 1 · 字段校验 ===')
const good = m.validateInput({ title: ' 帖子 ', body: 'x', tags: ['a', 'a'] })
check('合法输入', good.ok, true)
check('title trim', good.value.title, '帖子')
check('tags 去重', good.value.tags.length, 1)
checkTrue('空标题被拒', m.validateInput({ title: '' }).ok === false)
checkTrue('超长标题被拒', m.validateInput({ title: 'x'.repeat(m.LIMITS.title + 1) }).ok === false)

console.log('\n=== 2 · 可见性矩阵（canSee）===')
const draft = mk({ status: 'draft' })
const published = mk({ status: 'published' })
const hidden = mk({ status: 'hidden' })
check('草稿：作者可见', m.canSee(draft, 'alice', false), true)
check('草稿：他人不可见', m.canSee(draft, 'bob', false), false)
check('草稿：管理员可见', m.canSee(draft, 'root', true), true)
check('公开：所有人可见', m.canSee(published, 'bob', false), true)
check('隐藏：作者可见', m.canSee(hidden, 'alice', false), true)
check('隐藏：他人不可见', m.canSee(hidden, 'bob', false), false)
check('隐藏：管理员可见', m.canSee(hidden, 'root', true), true)

console.log('\n=== 3 · 状态迁移与权限 ===')
check('本人可编辑草稿', m.canEdit(draft, 'alice').ok, true)
check('他人不可编辑（E-1002）', m.canEdit(draft, 'bob').code, 'E-1002')
const pub = m.publishPost(draft, NOW)
check('发布 → published', pub.status, 'published')
check('发布记录时间', pub.publishedAt !== null, true)
check('已发布不可编辑（E-1001）', m.canEdit(pub, 'alice').code, 'E-1001')
const hid = m.hidePost(pub, 'root', NOW)
check('隐藏 → hidden', hid.status, 'hidden')
check('记录隐藏人', hid.hiddenBy, 'root')
check('恢复 → published', m.unhidePost(hid, NOW).status, 'published')
check('非管理员不能隐藏', m.canHide(false).ok, false)
check('管理员可隐藏', m.canHide(true).ok, true)
check('仅作者可删', m.canDelete(draft, 'bob').code, 'E-1002')

console.log('\n=== 4 · 点赞 toggle ===')
let r = m.toggleLike(mk({ status: 'published', likes: 0 }), 'bob', NOW)
check('首次点赞 liked=true', r.liked, true)
check('点赞数 +1', r.post.likes, 1)
check('likedBy 记录', r.post.likedBy[0], 'bob')
r = m.toggleLike(r.post, 'bob', NOW)
check('再次点赞取消', r.liked, false)
check('点赞数归零', r.post.likes, 0)
check('不同人各自计一次', m.toggleLike(m.toggleLike(mk({ status: 'published' }), 'bob', NOW).post, 'carol', NOW).post.likes, 2)

console.log('\n=== 5 · 从草稿发布事件建帖子草稿 ===')
const built = m.postFromDraftEvent({ id: 'ev-1', payload: { draftId: 'd-9', owner: 'bob' } })
check('作者取自事件', built.author, 'bob')
check('sourceDraftId', built.sourceDraftId, 'd-9')
check('sourceEventId', built.sourceEventId, 'ev-1')
const created = m.createPost({ title: 'x', body: '', tags: [] }, 'p-9', { author: 'bob', now: NOW })
check('自动建稿初始为 draft（不直接公开）', created.status, 'draft')
checkTrue('无 likedBy 初始', Array.isArray(created.likedBy) && created.likedBy.length === 0)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
