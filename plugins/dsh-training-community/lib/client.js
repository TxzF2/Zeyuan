// dsh-training-community — BROWSER 半：DSH 应用内「社区」面板
//
// 加载方式：package.json 声明 exports["./client"] + dsh.client.inject。
// 不能裸 ESM import；官方依赖走 factory 注入的 require。
// 配色：墨绿 + 星辰金；颜色优先 --dsw-alias-*，字面量兜底。
window.__ModuleLoader__.load({
  id: 'dsh-training-community',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-training-community'
    const zh = {
      nav: '培训班 · 社区',
      loading: '正在读取帖子…',
      error: '无法连接社区服务（插件可能未加载）',
      user: '身份',
      admin: '管理员',
      all: '全部',
      published: '公开',
      mine: '我的',
      hidden: '隐藏',
      empty: '暂无帖子',
      draft: '新建帖子',
      title: '标题',
      body: '正文（Markdown）',
      tags: '标签（逗号分隔，最多 8 个）',
      save: '保存',
      publish: '发布',
      like: '点赞',
      liked: '已赞',
      delete: '删除',
      hide: '隐藏',
      unhide: '恢复',
      close: '收起',
      fromDraft: '来源草稿',
      author: '作者',
      likeCount: '点赞',
      draftBadge: '帖子草稿',
      hint: '工作台草稿发布后会生成「帖子草稿」，确认无误再点发布公开。',
      errs: { 'E-601': '尚未签署协议', 'E-1001': '状态不允许', 'E-1002': '无权限', 'E-1003': '字段不合法', 'E-1005': '需要管理员' },
    }
    const en = {
      nav: 'Training · Community',
      loading: 'Loading posts…',
      error: 'Cannot reach community service (plugin not loaded?)',
      user: 'User',
      admin: 'Admin',
      all: 'All',
      published: 'Public',
      mine: 'Mine',
      hidden: 'Hidden',
      empty: 'No posts',
      draft: 'New post',
      title: 'Title',
      body: 'Body (Markdown)',
      tags: 'Tags (comma separated, max 8)',
      save: 'Save',
      publish: 'Publish',
      like: 'Like',
      liked: 'Liked',
      delete: 'Delete',
      hide: 'Hide',
      unhide: 'Restore',
      close: 'Close',
      fromDraft: 'From draft',
      author: 'Author',
      likeCount: 'Likes',
      draftBadge: 'Post draft',
      hint: 'Publishing a workbench draft creates a post draft — confirm before going public.',
      errs: { 'E-601': 'Protocol not signed', 'E-1001': 'State not allowed', 'E-1002': 'Not permitted', 'E-1003': 'Invalid fields', 'E-1005': 'Admin required' },
    }

    let t = (k) => k
    const setT = (fn) => {
      t = fn
    }

    const INK = 'var(--dsw-alias-bg-layer-1, #0b1512)'
    const INK2 = 'var(--dsw-alias-bg-layer-2, #12211c)'
    const INK3 = 'var(--dsw-alias-bg-layer-3, #16281f)'
    const LINE = 'var(--dsw-alias-border-l1, #2a3d33)'
    const GREEN = 'var(--dsw-alias-state-success-primary, #3fb950)'
    const GOLD = 'var(--dsw-alias-label-warning, #d4af37)'
    const TEXT = 'var(--dsw-alias-label-primary, #e6edf3)'
    const MUTED = 'var(--dsw-alias-label-secondary, #8b949e)'
    const RED = 'var(--dsw-alias-state-error-primary, #f85149)'

    const S = {
      box: { padding: '6px 2px', color: TEXT, fontFamily: 'inherit' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' },
      badge: (ok) => ({
        display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 10px', borderRadius: '999px',
        fontSize: '12px', border: `1px solid ${ok ? GREEN : LINE}`, color: ok ? GREEN : MUTED,
      }),
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '6px 0 10px' },
      chip: (on) => ({
        cursor: 'pointer', fontSize: '12px', padding: '3px 10px', borderRadius: '999px',
        border: `1px solid ${on ? GOLD : LINE}`, background: on ? 'rgba(212,175,55,0.12)' : 'transparent',
        color: on ? GOLD : MUTED,
      }),
      card: (sel) => ({
        border: `1px solid ${sel ? GOLD : LINE}`, borderRadius: '10px', padding: '10px 12px',
        background: sel ? INK3 : INK2, marginBottom: '8px', cursor: 'pointer',
      }),
      cardTitle: { fontSize: '14px', fontWeight: 600, color: TEXT, marginBottom: '4px' },
      meta: { fontSize: '12px', color: MUTED, display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
      pill: (s) => ({
        fontSize: '11.5px', padding: '1px 8px', borderRadius: '6px',
        border: `1px solid ${s === 'published' ? GREEN : s === 'hidden' ? RED : GOLD}`,
        color: s === 'published' ? GREEN : s === 'hidden' ? RED : GOLD,
      }),
      panel: { border: `1px solid ${GOLD}`, borderRadius: '10px', padding: '12px', background: INK3, marginTop: '10px' },
      kv: { fontSize: '12.5px', lineHeight: '1.9', color: MUTED },
      pre: { whiteSpace: 'pre-wrap', fontSize: '13px', color: TEXT, lineHeight: '1.7', margin: '6px 0' },
      input: {
        width: '100%', boxSizing: 'border-box', marginTop: '4px', marginBottom: '8px',
        padding: '6px 8px', borderRadius: '8px', border: `1px solid ${LINE}`, background: INK, color: TEXT, fontSize: '13px',
      },
      btn: (primary) => ({
        cursor: 'pointer', fontSize: '13px', padding: '6px 12px', borderRadius: '8px',
        border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? 'rgba(63,185,80,0.12)' : 'transparent',
        color: primary ? GREEN : TEXT,
      }),
      gold: {
        cursor: 'pointer', fontSize: '13px', padding: '6px 14px', borderRadius: '8px', fontWeight: 600,
        border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.14)', color: GOLD,
      },
      hint: { fontSize: '12px', color: MUTED, marginTop: '8px' },
      err: { color: RED, fontSize: '13px' },
      notice: { fontSize: '12.5px', marginTop: '8px', color: TEXT },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 0' },
    }

    const API = '/dsh-training/community'
    const FILTERS = ['all', 'published', 'mine', 'hidden']

    function Panel() {
      const [state, setState] = useState({ status: 'loading', me: null, posts: [], tags: [], notice: '' })
      const [filter, setFilter] = useState('all')
      const [selected, setSelected] = useState(null)
      const [showDraft, setShowDraft] = useState(false)
      const [form, setForm] = useState({ title: '', body: '', tags: '' })

      const load = useCallback(() => {
        const qs = new URLSearchParams()
        if (filter === 'published') qs.set('status', 'published')
        if (filter === 'hidden') qs.set('status', 'hidden')
        if (filter === 'mine') qs.set('author', state.me?.user ?? '')
        Promise.all([fetch(`${API}/me`).then((r) => r.json()), fetch(`${API}/list?${qs}`).then((r) => r.json())])
          .then(([me, list]) => {
            const user = me.data?.user
            const posts = filter === 'mine' ? (list.data?.posts ?? []).filter((p) => p.author === user) : list.data?.posts ?? []
            setState((s) => ({ ...s, status: 'ok', me: me.data ?? null, posts, tags: list.data?.tags ?? [] }))
          })
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [filter, state.me?.user])

      useEffect(() => { load() }, [load])

      const lv1 = state.me?.level === 'LV1'
      const isAdmin = Boolean(state.me?.isAdmin)
      const detail = selected ? state.posts.find((p) => p.id === selected) : null

      const post = (path, body) =>
        fetch(`${API}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
          .then((r) => r.json())
          .then((res) => {
            const msg = res.ok ? '✅ 操作成功' : `❌ ${res.code} ${(t('errs') || {})[res.code] ?? ''} ${res.message ?? ''}`.trim()
            setState((s) => ({ ...s, notice: msg }))
            load()
          })
          .catch(() => setState((s) => ({ ...s, notice: '❌ 请求失败' })))

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-community' }, t('loading'))
      if (state.status === 'error') {
        return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-community' }, h('div', { style: S.err }, t('error')))
      }

      const labels = { draft: t('draftBadge'), published: '公开', hidden: '隐藏' }

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-community', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('nav')),
          h('span', { style: S.badge(lv1) }, lv1 ? 'LV1' : 'LV0 · 只读'),
          isAdmin ? h('span', { style: S.badge(true) }, t('admin')) : null,
          h('span', { style: { fontSize: '12px', color: MUTED } }, `${t('user')}：${state.me?.user ?? '-'}`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              style: lv1 ? S.gold : { ...S.gold, opacity: 0.5, cursor: 'not-allowed' },
              disabled: !lv1,
              onClick: () => setShowDraft((v) => !v),
            },
            t('draft'),
          ),
        ),

        h(
          'div',
          { style: S.chips },
          FILTERS.map((f) => h('span', { key: f, style: S.chip(filter === f), onClick: () => setFilter(f) }, t(f))),
          state.tags.map((tag) => h('span', { key: `tag:${tag}`, style: S.chip(false), onClick: () => setFilter('published') }, `#${tag}`)),
        ),

        showDraft && lv1
          ? h(
              'div',
              { style: S.panel },
              h('div', { style: S.kv }, t('title')),
              h('input', { style: S.input, value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }) }),
              h('div', { style: S.kv }, t('tags')),
              h('input', { style: S.input, value: form.tags, onChange: (e) => setForm({ ...form, tags: e.target.value }) }),
              h('div', { style: S.kv }, t('body')),
              h('textarea', {
                style: { ...S.input, minHeight: '110px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                value: form.body,
                onChange: (e) => setForm({ ...form, body: e.target.value }),
              }),
              h(
                'div',
                { style: S.row },
                h(
                  'button',
                  {
                    style: S.gold,
                    onClick: () =>
                      post('draft', {
                        title: form.title,
                        body: form.body,
                        tags: form.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                      }).then(() => setShowDraft(false)),
                  },
                  t('save'),
                ),
                h('button', { style: S.btn(false), onClick: () => setShowDraft(false) }, t('close')),
              ),
            )
          : null,

        state.posts.length === 0
          ? h('div', { style: S.hint }, t('empty'))
          : state.posts.map((p) =>
              h(
                'div',
                { key: p.id, style: S.card(selected === p.id), onClick: () => setSelected(p.id) },
                h('div', { style: S.cardTitle }, p.title),
                h(
                  'div',
                  { style: S.meta },
                  h('span', { style: S.pill(p.status) }, labels[p.status] ?? p.status),
                  h('span', null, `${t('author')}：${p.author}`),
                  h('span', null, `❤️ ${p.likes}`),
                  p.tags.map((tag) => h('span', { key: tag }, `#${tag}`)),
                ),
              ),
            ),

        detail
          ? h(
              'div',
              { style: S.panel },
              h('div', { style: { ...S.cardTitle, color: GOLD } }, detail.title),
              h(
                'div',
                { style: S.kv },
                `${t('author')}：${detail.author} ｜ ❤️ ${detail.likes} ｜ ${t('fromDraft')}：${detail.sourceDraftId ?? '—'}`,
              ),
              h('pre', { style: S.pre }, detail.body || '（空）'),
              h(
                'div',
                { style: S.row },
                detail.status !== 'draft'
                  ? h(
                      'button',
                      {
                        style: S.btn(detail.likedBy?.includes(state.me?.user)),
                        onClick: () => post('like', { id: detail.id }),
                      },
                      detail.likedBy?.includes(state.me?.user) ? t('liked') : t('like'),
                    )
                  : null,
                detail.status === 'draft' && detail.author === state.me?.user && lv1
                  ? h('button', { style: S.gold, onClick: () => post('publish', { id: detail.id }) }, t('publish'))
                  : null,
                detail.author === state.me?.user && lv1
                  ? h('button', { style: S.btn(false), onClick: () => post('delete', { id: detail.id }) }, t('delete'))
                  : null,
                isAdmin
                  ? h(
                      'button',
                      { style: S.btn(false), onClick: () => post(detail.status === 'hidden' ? 'unhide' : 'hide', { id: detail.id }) },
                      detail.status === 'hidden' ? t('unhide') : t('hide'),
                    )
                  : null,
                h('button', { style: S.btn(false), onClick: () => setSelected(null) }, t('close')),
              ),
            )
          : null,

        state.notice ? h('div', { style: S.notice }, state.notice) : null,
        h('div', { style: S.hint }, t('hint')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-training-community: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-training-community', order: 75, label: () => bound('nav'), locale: NS },
              Panel,
            ),
          )
        } catch (e) {
          console.error('[dsh-training-community] client apply failed:', e)
        }
      },
    }
  },
})
