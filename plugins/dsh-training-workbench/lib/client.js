// dsh-training-workbench — BROWSER 半：DSH 应用内「工作台」面板
//
// 加载方式：package.json 声明 `exports["./client"]` + `dsh.client.inject`。
// 不能裸 ESM import，官方依赖走 factory 注入的 require。
// 配色：墨绿 + 星辰金；颜色优先 --dsw-alias-*，字面量兜底。
window.__ModuleLoader__.load({
  id: 'dsh-training-workbench',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-training-workbench'
    const zh = {
      nav: '培训班 · 工作台',
      loading: '正在读取草稿…',
      error: '无法连接工作台服务（插件可能未加载）',
      level: '当前等级',
      user: '身份',
      needLv1: 'LV1 才能编辑/发布草稿，请先在「培训班 · 协议授权」签署协议。',
      all: '全部',
      draft: '草稿',
      published: '已发布',
      empty: '暂无草稿（任务验收通过后会自动出现在这里）',
      create: '新建草稿',
      title: '标题',
      body: '正文（Markdown）',
      tags: '标签（逗号分隔，最多 8 个）',
      save: '保存',
      publish: '发布',
      close: '收起',
      fromTask: '来源任务',
      updatedAt: '更新于',
      publishedAt: '发布于',
      hint: '验收通过的任务会自动生成一份草稿，草稿内容由你填写。',
      errs: { 'E-601': '尚未签署协议', 'E-902': '只能改自己的草稿', 'E-901': '已发布不可修改', 'E-903': '字段不合法' },
    }
    const en = {
      nav: 'Training · Workbench',
      loading: 'Loading drafts…',
      error: 'Cannot reach workbench service (plugin not loaded?)',
      level: 'Level',
      user: 'User',
      needLv1: 'A valid LV1 license is required to edit/publish drafts.',
      all: 'All',
      draft: 'Draft',
      published: 'Published',
      empty: 'No drafts yet (accepted tasks create one automatically)',
      create: 'New draft',
      title: 'Title',
      body: 'Body (Markdown)',
      tags: 'Tags (comma separated, max 8)',
      save: 'Save',
      publish: 'Publish',
      close: 'Close',
      fromTask: 'From task',
      updatedAt: 'Updated',
      publishedAt: 'Published',
      hint: 'Accepted tasks create a draft automatically; you fill in the content.',
      errs: { 'E-601': 'Protocol not signed', 'E-902': 'Not your draft', 'E-901': 'Published drafts are read-only', 'E-903': 'Invalid fields' },
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
        border: `1px solid ${s === 'published' ? GOLD : GREEN}`, color: s === 'published' ? GOLD : GREEN,
      }),
      panel: { border: `1px solid ${GOLD}`, borderRadius: '10px', padding: '12px', background: INK3, marginTop: '10px' },
      kv: { fontSize: '12.5px', lineHeight: '1.9', color: MUTED },
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

    const API = '/dsh-training/workbench'
    const FILTERS = ['all', 'draft', 'published']

    function Panel() {
      const [state, setState] = useState({ status: 'loading', me: null, drafts: [], notice: '' })
      const [filter, setFilter] = useState('all')
      const [selected, setSelected] = useState(null)
      const [editing, setEditing] = useState(null)

      const load = useCallback(() => {
        const qs = new URLSearchParams()
        if (filter !== 'all') qs.set('status', filter)
        Promise.all([fetch(`${API}/me`).then((r) => r.json()), fetch(`${API}/list?${qs}`).then((r) => r.json())])
          .then(([me, list]) => setState({ status: 'ok', me: me.data ?? null, drafts: list.data?.drafts ?? [], notice: state.notice }))
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [filter])

      useEffect(() => { load() }, [load])

      const lv1 = state.me?.level === 'LV1'
      const detail = selected ? state.drafts.find((d) => d.id === selected) : null

      useEffect(() => {
        if (detail) setEditing({ title: detail.title, body: detail.body, tags: detail.tags.join(', ') })
      }, [selected])

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

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-workbench' }, t('loading'))
      if (state.status === 'error') {
        return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-workbench' }, h('div', { style: S.err }, t('error')))
      }

      const editable = detail && detail.status === 'draft' && detail.owner === state.me?.user && lv1

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-workbench', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('nav')),
          h('span', { style: S.badge(lv1) }, lv1 ? 'LV1 · 可编辑' : 'LV0 · 只读'),
          h('span', { style: { fontSize: '12px', color: MUTED } }, `${t('user')}：${state.me?.user ?? '-'}`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              style: lv1 ? S.gold : { ...S.gold, opacity: 0.5, cursor: 'not-allowed' },
              disabled: !lv1,
              onClick: () => post('create', { title: '新草稿', body: '', tags: [] }),
            },
            t('create'),
          ),
        ),
        lv1 ? null : h('div', { style: S.hint }, t('needLv1')),

        h(
          'div',
          { style: S.chips },
          FILTERS.map((f) => h('span', { key: f, style: S.chip(filter === f), onClick: () => setFilter(f) }, t(f))),
        ),

        state.drafts.length === 0
          ? h('div', { style: S.hint }, t('empty'))
          : state.drafts.map((d) =>
              h(
                'div',
                { key: d.id, style: S.card(selected === d.id), onClick: () => setSelected(d.id) },
                h('div', { style: S.cardTitle }, d.title),
                h(
                  'div',
                  { style: S.meta },
                  h('span', { style: S.pill(d.status) }, d.status === 'published' ? t('published') : t('draft')),
                  d.sourceTaskId ? h('span', null, `${t('fromTask')}：${d.sourceTaskId}`) : null,
                  h('span', null, `${t('updatedAt')} ${d.updatedAt.slice(0, 16).replace('T', ' ')}`),
                ),
              ),
            ),

        detail
          ? h(
              'div',
              { style: S.panel },
              h('div', { style: { ...S.cardTitle, color: GOLD } }, `${t('title')}：${detail.title}`),
              h(
                'div',
                { style: S.kv },
                `${t('fromTask')}：${detail.sourceTaskId ?? '—'} ｜ ${t('updatedAt')} ${detail.updatedAt.slice(0, 19).replace('T', ' ')}`,
              ),
              h('div', { style: S.kv }, t('title')),
              h('input', {
                style: S.input,
                value: editing?.title ?? '',
                disabled: !editable,
                onChange: (e) => setEditing({ ...editing, title: e.target.value }),
              }),
              h('div', { style: S.kv }, t('tags')),
              h('input', {
                style: S.input,
                value: editing?.tags ?? '',
                disabled: !editable,
                onChange: (e) => setEditing({ ...editing, tags: e.target.value }),
              }),
              h('div', { style: S.kv }, t('body')),
              h('textarea', {
                style: { ...S.input, minHeight: '140px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                value: editing?.body ?? '',
                disabled: !editable,
                onChange: (e) => setEditing({ ...editing, body: e.target.value }),
              }),
              h(
                'div',
                { style: S.row },
                editable
                  ? h(
                      'button',
                      {
                        style: S.btn(true),
                        onClick: () =>
                          post('save', {
                            id: detail.id,
                            title: editing.title,
                            body: editing.body,
                            tags: editing.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                          }),
                      },
                      t('save'),
                    )
                  : null,
                editable
                  ? h('button', { style: S.gold, onClick: () => post('publish', { id: detail.id }) }, t('publish'))
                  : null,
                h('button', { style: S.btn(false), onClick: () => setSelected(null) }, t('close')),
              ),
              detail.status === 'published'
                ? h('div', { style: S.hint }, `${t('publishedAt')} ${detail.publishedAt?.slice(0, 19).replace('T', ' ') ?? ''}`)
                : null,
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
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-training-workbench: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-training-workbench', order: 74, label: () => bound('nav'), locale: NS },
              Panel,
            ),
          )
        } catch (e) {
          console.error('[dsh-training-workbench] client apply failed:', e)
        }
      },
    }
  },
})
