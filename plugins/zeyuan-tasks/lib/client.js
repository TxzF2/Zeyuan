// zeyuan-tasks — BROWSER 半：DSH 应用内「任务接发」面板
//
// 加载方式：package.json 声明 `exports["./client"]` + `dsh.client.inject`，
// DSH 模块加载器把本文件并入客户端 roster。
// 这里不能用裸 ESM `import`——官方依赖必须通过 factory 注入的 require 取。
//
// 配色：墨绿主色 + 星辰金点缀；颜色优先用 --dsw-alias-* 令牌，字面量仅兜底。
window.__ModuleLoader__.load({
  id: 'zeyuan-tasks',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'zeyuan-tasks'
    const zh = {
      nav: '泽元 · 任务接发',
      loading: '正在读取任务…',
      error: '无法连接任务服务（插件可能未加载）',
      level: '当前等级',
      user: '身份',
      needLv1: 'LV1 才能发布/领取/提交任务，请先在「泽元 · 协议授权」签署协议。',
      filterAll: '全部',
      filterTag: '标签',
      empty: '暂无任务',
      create: '发布任务',
      title: '标题',
      desc: '描述',
      tags: '标签',
      bounty: '赏金（金币）',
      deadline: '截止时间（可选）',
      submitBtn: '发布',
      cancel: '取消',
      detail: '任务详情',
      creator: '发起人',
      assignee: '领取人',
      timeline: '状态时间线',
      claim: '领取',
      submit: '提交',
      accept: '通过验收',
      reject: '驳回',
      rewardHint: '验收将对货币系统发起赏金结算（本页不记账）',
      close: '收起',
      status: { open: '待领取', claimed: '进行中', submitted: '待验收', accepted: '已完成' },
      errs: { 'E-601': '尚未签署协议', 'E-603': '协议已过期', 'E-802': '无权限执行该操作', 'E-801': '状态已变化，请刷新' },
    }
    const en = {
      nav: 'Zeyuan · Tasks',
      loading: 'Loading tasks…',
      error: 'Cannot reach task service (plugin not loaded?)',
      level: 'Level',
      user: 'User',
      needLv1: 'A valid LV1 license is required to publish/claim/submit.',
      filterAll: 'All',
      filterTag: 'Tag',
      empty: 'No tasks',
      create: 'New task',
      title: 'Title',
      desc: 'Description',
      tags: 'Tags',
      bounty: 'Bounty (coins)',
      deadline: 'Deadline (optional)',
      submitBtn: 'Publish',
      cancel: 'Cancel',
      detail: 'Details',
      creator: 'Creator',
      assignee: 'Assignee',
      timeline: 'Timeline',
      claim: 'Claim',
      submit: 'Submit',
      accept: 'Accept',
      reject: 'Reject',
      rewardHint: 'Accepting requests a settlement from the wallet system',
      close: 'Close',
      status: { open: 'Open', claimed: 'Claimed', submitted: 'Submitted', accepted: 'Accepted' },
      errs: { 'E-601': 'Protocol not signed', 'E-603': 'License expired', 'E-802': 'Not permitted', 'E-801': 'State changed, refresh' },
    }

    let t = (k) => k
    const setT = (fn) => {
      t = fn
    }

    // 墨绿 + 星辰
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
      status: (s) => ({
        display: 'inline-block', padding: '1px 8px', borderRadius: '6px', fontSize: '11.5px',
        border: `1px solid ${s === 'accepted' ? GOLD : s === 'open' ? GREEN : LINE}`,
        color: s === 'accepted' ? GOLD : s === 'open' ? GREEN : MUTED,
      }),
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 0' },
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
      bounty: { color: GOLD, fontWeight: 600 },
      panel: { border: `1px solid ${GOLD}`, borderRadius: '10px', padding: '12px', background: INK3, marginTop: '10px' },
      kv: { fontSize: '12.5px', lineHeight: '1.9', color: MUTED },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: TEXT },
      btn: (primary) => ({
        cursor: 'pointer', fontSize: '13px', padding: '6px 12px', borderRadius: '8px',
        border: `1px solid ${primary ? GREEN : LINE}`,
        background: primary ? 'rgba(63,185,80,0.12)' : 'transparent',
        color: primary ? GREEN : TEXT,
      }),
      gold: {
        cursor: 'pointer', fontSize: '13px', padding: '6px 14px', borderRadius: '8px', fontWeight: 600,
        border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.14)', color: GOLD,
      },
      input: {
        width: '100%', boxSizing: 'border-box', marginTop: '4px', marginBottom: '8px',
        padding: '6px 8px', borderRadius: '8px', border: `1px solid ${LINE}`,
        background: INK, color: TEXT, fontSize: '13px',
      },
      hint: { fontSize: '12px', color: MUTED, marginTop: '8px' },
      err: { color: RED, fontSize: '13px' },
      notice: { fontSize: '12.5px', marginTop: '8px', color: TEXT },
    }

    const API = '/zeyuan/tasks'
    const STATUS_ORDER = ['all', 'open', 'claimed', 'submitted', 'accepted']

    function Panel() {
      const [state, setState] = useState({ status: 'loading', me: null, tasks: [], tags: [], notice: '' })
      const [filter, setFilter] = useState({ status: 'all', tag: '' })
      const [selected, setSelected] = useState(null)
      const [showCreate, setShowCreate] = useState(false)
      const [form, setForm] = useState({ title: '', description: '', tags: '', bounty: '10', deadline: '' })

      const load = useCallback(() => {
        const qs = new URLSearchParams()
        if (filter.status !== 'all') qs.set('status', filter.status)
        if (filter.tag) qs.set('tag', filter.tag)
        Promise.all([
          fetch(`${API}/me`).then((r) => r.json()),
          fetch(`${API}/list?${qs.toString()}`).then((r) => r.json()),
        ])
          .then(([me, list]) => {
            setState({
              status: 'ok',
              me: me.data ?? null,
              tasks: list.data?.tasks ?? [],
              tags: list.data?.tags ?? [],
              notice: '',
            })
          })
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [filter])

      useEffect(() => { load() }, [load])

      const lv1 = state.me?.level === 'LV1'

      const post = (path, body) =>
        fetch(`${API}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
          .then((r) => r.json())
          .then((res) => {
            const msg = res.ok
              ? '✅ 操作成功'
              : `❌ ${res.code} ${t('errs')[res.code] ?? ''} ${res.message ?? ''}`.trim()
            setState((s) => ({ ...s, notice: msg }))
            load()
          })
          .catch(() => setState((s) => ({ ...s, notice: '❌ 请求失败' })))

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'zeyuan-tasks' }, t('loading'))
      if (state.status === 'error') {
        return h('div', { style: S.box, 'data-dsh-plugin': 'zeyuan-tasks' }, h('div', { style: S.err }, t('error')))
      }

      const labels = t('status') ?? {}
      const detail = selected ? state.tasks.find((x) => x.id === selected) : null
      const canCreate = lv1 && showCreate

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'zeyuan-tasks', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('nav')),
          h('span', { style: S.badge(lv1) }, lv1 ? 'LV1 · 可操作' : 'LV0 · 只读'),
          h('span', { style: { fontSize: '12px', color: MUTED } }, `${t('user')}：${state.me?.user ?? '-'}`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              style: lv1 ? S.gold : { ...S.gold, opacity: 0.5, cursor: 'not-allowed' },
              disabled: !lv1,
              onClick: () => setShowCreate((v) => !v),
            },
            t('create'),
          ),
        ),
        lv1 ? null : h('div', { style: S.hint }, t('needLv1')),

        h(
          'div',
          { style: S.chips },
          STATUS_ORDER.map((s) =>
            h(
              'span',
              {
                key: s,
                style: S.chip(filter.status === s),
                onClick: () => setFilter((f) => ({ ...f, status: s })),
              },
              s === 'all' ? t('filterAll') : labels[s] ?? s,
            ),
          ),
          state.tags.map((tag) =>
            h(
              'span',
              {
                key: `tag:${tag}`,
                style: S.chip(filter.tag === tag),
                onClick: () => setFilter((f) => ({ ...f, tag: f.tag === tag ? '' : tag })),
              },
              `#${tag}`,
            ),
          ),
        ),

        canCreate
          ? h(
              'div',
              { style: S.panel },
              h('div', { style: S.kv }, t('title')),
              h('input', {
                style: S.input,
                value: form.title,
                onChange: (e) => setForm({ ...form, title: e.target.value }),
                placeholder: '例如：给培训手册补 3 个实操案例',
              }),
              h('div', { style: S.kv }, t('desc')),
              h('textarea', {
                style: { ...S.input, minHeight: '60px' },
                value: form.description,
                onChange: (e) => setForm({ ...form, description: e.target.value }),
              }),
              h('div', { style: S.kv }, `${t('tags')}（逗号分隔，最多 5 个）`),
              h('input', {
                style: S.input,
                value: form.tags,
                onChange: (e) => setForm({ ...form, tags: e.target.value }),
              }),
              h(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                h(
                  'div',
                  { style: { flex: 1 } },
                  h('div', { style: S.kv }, t('bounty')),
                  h('input', {
                    style: S.input,
                    type: 'number',
                    value: form.bounty,
                    onChange: (e) => setForm({ ...form, bounty: e.target.value }),
                  }),
                ),
                h(
                  'div',
                  { style: { flex: 1 } },
                  h('div', { style: S.kv }, t('deadline')),
                  h('input', {
                    style: S.input,
                    type: 'datetime-local',
                    value: form.deadline,
                    onChange: (e) => setForm({ ...form, deadline: e.target.value }),
                  }),
                ),
              ),
              h(
                'div',
                { style: S.row },
                h(
                  'button',
                  {
                    style: S.gold,
                    onClick: () =>
                      post('create', {
                        title: form.title,
                        description: form.description,
                        tags: form.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                        bounty: Number(form.bounty) || 0,
                        ...(form.deadline ? { deadline: new Date(form.deadline).toISOString() } : {}),
                      }).then(() => setShowCreate(false)),
                  },
                  t('submitBtn'),
                ),
                h('button', { style: S.btn(false), onClick: () => setShowCreate(false) }, t('cancel')),
              ),
            )
          : null,

        state.tasks.length === 0
          ? h('div', { style: S.hint }, t('empty'))
          : state.tasks.map((task) =>
              h(
                'div',
                { key: task.id, style: S.card(selected === task.id), onClick: () => setSelected(task.id) },
                h('div', { style: S.cardTitle }, task.title),
                h(
                  'div',
                  { style: S.meta },
                  h('span', { style: S.status(task.status) }, labels[task.status] ?? task.status),
                  h('span', { style: S.bounty }, `💰 ${task.bounty}`),
                  task.tags.map((tag) => h('span', { key: tag }, `#${tag}`)),
                  task.deadline ? h('span', null, `⏰ ${task.deadline.slice(0, 10)}`) : null,
                ),
              ),
            ),

        detail
          ? h(
              'div',
              { style: S.panel },
              h('div', { style: { ...S.cardTitle, color: GOLD } }, `${t('detail')} · ${detail.title}`),
              h('div', { style: S.kv }, detail.description || '（无描述）'),
              h(
                'div',
                { style: S.kv },
                `${t('creator')}：${detail.creator} ｜ ${t('assignee')}：${detail.assignee ?? '—'} ｜ 💰 ${detail.bounty}`,
              ),
              h(
                'div',
                { style: S.kv },
                `${t('timeline')}：`,
                detail.history.length === 0
                  ? '创建'
                  : detail.history
                      .map((x) => `${x.at.slice(11, 19)} ${x.action}${x.reason ? `(${x.reason})` : ''}`)
                      .join(' → '),
              ),
              h(
                'div',
                { style: S.row },
                detail.status === 'open' && lv1 && detail.creator !== state.me?.user
                  ? h('button', { style: S.gold, onClick: () => post('claim', { id: detail.id }) }, t('claim'))
                  : null,
                detail.status === 'claimed' && lv1 && detail.assignee === state.me?.user
                  ? h('button', { style: S.gold, onClick: () => post('submit', { id: detail.id }) }, t('submit'))
                  : null,
                detail.status === 'submitted' && lv1 && detail.creator === state.me?.user
                  ? h('button', { style: S.btn(true), onClick: () => post('accept', { id: detail.id }) }, t('accept'))
                  : null,
                detail.status === 'submitted' && lv1 && detail.creator === state.me?.user
                  ? h('button', { style: S.btn(false), onClick: () => post('reject', { id: detail.id }) }, t('reject'))
                  : null,
                h('button', { style: S.btn(false), onClick: () => setSelected(null) }, t('close')),
              ),
              detail.status === 'submitted' && detail.creator === state.me?.user ? h('div', { style: S.hint }, t('rewardHint')) : null,
            )
          : null,

        state.notice ? h('div', { style: S.notice }, state.notice) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'zeyuan-tasks: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'zeyuan-tasks',
                order: 73,
                label: () => bound('nav'),
                locale: NS,
              },
              Panel,
            ),
          )
        } catch (e) {
          console.error('[zeyuan-tasks] client apply failed:', e)
        }
      },
    }
  },
})
