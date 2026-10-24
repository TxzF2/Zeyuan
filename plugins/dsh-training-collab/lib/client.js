// dsh-training-collab — BROWSER 半：设置面板「培训班 · 协作分组」
window.__ModuleLoader__.load({
  id: 'dsh-training-collab',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement
    const NS = 'dsh-training-collab'

    const zh = {
      nav: '培训班 · 协作分组',
      loading: '正在读取分组…',
      error: '无法连接分组服务（插件可能未加载）',
      me: '身份',
      create: '建组',
      join: '加入',
      leave: '退出',
      transfer: '转让',
      remove: '移除',
      activate: '激活组',
      capacity: '编制',
      leader: '组长',
      duty: '分工',
      status: { forming: '筹建中', active: '已激活', archived: '已解散' },
      pending: '待审批',
      members: '成员',
      tasks: '组内任务',
      publish: '发布任务到组',
      title: '任务标题',
      bounty: '赏金',
      reviews: '组内评审批次',
      requestReview: '发起评审',
      doneReview: '完成评审',
      coin: '金币申请',
      amount: '金额',
      reason: '理由（≥4 字）',
      submit: '提交',
      coinHint: '组长只能申请；实际发币由控制台 P7+ 审批',
      fullHint: '满编 4 人且分工齐备才能激活',
      emptyGroups: '暂无分组',
      errs: { 'E-1301': '状态不允许', 'E-1302': '权限不足', 'E-1303': '参数不合法', 'E-1304': '不存在' },
    }
    const en = {
      nav: 'Training · Groups',
      loading: 'Loading groups…',
      error: 'Cannot reach group service (plugin not loaded?)',
      me: 'User',
      create: 'Create',
      join: 'Join',
      leave: 'Leave',
      transfer: 'Transfer',
      remove: 'Remove',
      activate: 'Activate',
      capacity: 'Capacity',
      leader: 'Leader',
      duty: 'Duty',
      status: { forming: 'Forming', active: 'Active', archived: 'Archived' },
      pending: 'Pending',
      members: 'Members',
      tasks: 'Group tasks',
      publish: 'Publish task',
      title: 'Title',
      bounty: 'Bounty',
      reviews: 'Reviews',
      requestReview: 'Request review',
      doneReview: 'Mark done',
      coin: 'Coin request',
      amount: 'Amount',
      reason: 'Reason (min 4)',
      submit: 'Submit',
      coinHint: 'Leader can only request; P7+ in console approves.',
      fullHint: 'Needs 4 members with duties to activate',
      emptyGroups: 'No groups',
      errs: { 'E-1301': 'State not allowed', 'E-1302': 'Not permitted', 'E-1303': 'Invalid', 'E-1304': 'Not found' },
    }

    let t = (k) => k
    const setT = (fn) => {
      t = fn
    }
    const LINE = 'var(--dsw-alias-border-l1, #2a3d33)'
    const GREEN = 'var(--dsw-alias-state-success-primary, #3fb950)'
    const GOLD = 'var(--dsw-alias-label-warning, #d4af37)'
    const TEXT = 'var(--dsw-alias-label-primary, #e6edf3)'
    const MUTED = 'var(--dsw-alias-label-secondary, #8b949e)'
    const RED = 'var(--dsw-alias-state-error-primary, #f85149)'
    const INK2 = 'var(--dsw-alias-bg-layer-2, #12211c)'
    const INK3 = 'var(--dsw-alias-bg-layer-3, #16281f)'

    const S = {
      box: { padding: '6px 2px', color: TEXT, fontFamily: 'inherit' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' },
      badge: (on) => ({ display: 'inline-flex', gap: '6px', padding: '2px 10px', borderRadius: '999px', fontSize: '12px', border: `1px solid ${on ? GREEN : LINE}`, color: on ? GREEN : MUTED }),
      card: { border: `1px solid ${LINE}`, borderRadius: '10px', padding: '10px 12px', background: INK2, marginBottom: '8px' },
      title: { fontSize: '14px', fontWeight: 600, color: TEXT },
      meta: { fontSize: '12px', color: MUTED, display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px' },
      btn: { cursor: 'pointer', fontSize: '12.5px', padding: '4px 10px', borderRadius: '8px', border: `1px solid ${LINE}`, background: 'transparent', color: TEXT, marginRight: '6px' },
      gold: { cursor: 'pointer', fontSize: '13px', padding: '6px 14px', borderRadius: '8px', fontWeight: 600, border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.14)', color: GOLD, marginRight: '6px' },
      chip: (on) => ({ display: 'inline-block', fontSize: '11.5px', padding: '1px 7px', borderRadius: '6px', border: `1px solid ${on ? GOLD : LINE}`, color: on ? GOLD : MUTED, marginRight: '4px' }),
      input: { width: '100%', boxSizing: 'border-box', marginTop: '4px', marginBottom: '6px', padding: '6px 8px', borderRadius: '8px', border: `1px solid ${LINE}`, background: INK2, color: TEXT, fontSize: '13px' },
      section: { marginTop: '12px' },
      sectionTitle: { fontSize: '13px', color: GOLD, fontWeight: 600, marginBottom: '6px' },
      kv: { fontSize: '12.5px', lineHeight: '1.9', color: MUTED },
      hint: { fontSize: '12px', color: MUTED, marginTop: '6px' },
      err: { color: RED, fontSize: '13px' },
      notice: { fontSize: '12.5px', marginTop: '8px', color: TEXT },
      panel: { border: `1px solid ${GOLD}`, borderRadius: '10px', padding: '10px', background: INK3, marginTop: '8px' },
    }

    const API = '/dsh-training/collab'

    function Panel() {
      const [state, setState] = useState({ status: 'loading', me: null, groups: [], notice: '' })
      const [form, setForm] = useState({ name: '', topic: '', title: '', bounty: '10', amount: '100', reason: '' })

      const load = useCallback(() => {
        Promise.all([fetch(`${API}/me`).then((r) => r.json()), fetch(`${API}/groups`).then((r) => r.json())])
          .then(([me, groups]) => setState((s) => ({ ...s, status: 'ok', me: me.data ?? null, groups: groups.data ?? [] })))
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [])
      useEffect(() => { load() }, [load])

      const post = (path, body) =>
        fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
          .then((r) => r.json())
          .then((res) => {
            const msg = res.ok ? '✅ 操作成功' : `❌ ${res.code} ${(t('errs') || {})[res.code] ?? ''} ${res.message ?? ''}`.trim()
            setState((s) => ({ ...s, notice: msg }))
            load()
          })
          .catch(() => setState((s) => ({ ...s, notice: '❌ 请求失败' })))

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-collab' }, t('loading'))
      if (state.status === 'error') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-collab' }, h('div', { style: S.err }, t('error')))

      const me = state.me ?? {}
      const myGroup = me.group ? state.groups.find((g) => g.id === me.group.id) : null
      const labels = t('status') ?? {}

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-collab', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('nav')),
          h('span', { style: S.badge(me.level === 'LV1') }, me.level ?? '-'),
          h('span', { style: { fontSize: '12px', color: MUTED } }, `${t('me')}：${me.user ?? '-'}`),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.gold, onClick: () => post('group/create', { name: form.name || `${me.user} 的组`, topic: form.topic }) }, t('create')),
        ),

        myGroup
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.title }, `${myGroup.name}　${h('span', { style: S.chip(myGroup.status === 'active') }, labels[myGroup.status] ?? myGroup.status)}`),
              h('div', { style: S.meta }, `${t('leader')}：${myGroup.leader}`, `${t('capacity')}：${myGroup.members.length}/${myGroup.capacity}`, myGroup.topic || ''),
              h(
                'div',
                { style: { marginTop: '6px' } },
                myGroup.members.map((m) =>
                  h('div', { key: m.userId, style: S.kv }, `${m.userId === myGroup.leader ? '👑 ' : '· '}${m.userId}`, h('span', { style: S.chip(true) }, m.duty || '-')),
                ),
              ),
              h(
                'div',
                { style: { marginTop: '8px' } },
                myGroup.status === 'active'
                  ? null
                  : h('button', { style: S.gold, onClick: () => post('group/activate', { id: myGroup.id, members: [] }) }, t('activate')),
                myGroup.leader !== me.user && myGroup.leader === me.user ? null : myGroup.leader === me.user
                  ? h('button', { style: S.btn, onClick: () => post('group/leave', { id: myGroup.id }) }, t('leave'))
                  : h('button', { style: S.btn, onClick: () => post('group/leave', { id: myGroup.id }) }, t('leave')),
              ),
              h('div', { style: S.hint }, t('fullHint')),

              myGroup.status === 'active'
                ? h(
                    'div',
                    { style: S.section },
                    h('div', { style: S.sectionTitle }, t('tasks')),
                    h('div', { style: S.kv }, (myGroup.taskIds ?? []).join(', ') || '（暂无）'),
                    myGroup.leader === me.user
                      ? h(
                          'div',
                          null,
                          h('input', { style: S.input, placeholder: t('title'), value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }) }),
                          h('button', { style: S.gold, onClick: () => post('task/publish', { groupId: myGroup.id, title: form.title, bounty: Number(form.bounty) || 0 }) }, t('publish')),
                        )
                      : null,
                  )
                : null,

              h(
                'div',
                { style: S.section },
                h('div', { style: S.sectionTitle }, t('reviews')),
                h('div', { style: S.kv }, (myGroup.reviewRequests ?? []).map((r) => `${r.draftId} ${r.status}`).join('　') || '（暂无）'),
                h('button', { style: S.btn, onClick: () => post('review/request', { groupId: myGroup.id, draftId: 'd-manual' }) }, t('requestReview')),
              ),

              myGroup.leader === me.user
                ? h(
                    'div',
                    { style: S.section },
                    h('div', { style: S.sectionTitle }, t('coin')),
                    h('input', { style: S.input, placeholder: t('amount'), value: form.amount, onChange: (e) => setForm({ ...form, amount: e.target.value }) }),
                    h('input', { style: S.input, placeholder: t('reason'), value: form.reason, onChange: (e) => setForm({ ...form, reason: e.target.value }) }),
                    h('button', { style: S.gold, onClick: () => post('coin-request', { groupId: myGroup.id, amount: Number(form.amount) || 0, reason: form.reason }) }, t('submit')),
                    h('div', { style: S.hint }, t('coinHint')),
                  )
                : null,
            )
          : h(
              'div',
              { style: S.section },
              h('div', { style: S.sectionTitle }, t('members')),
              state.groups.length === 0
                ? h('div', { style: S.hint }, t('emptyGroups'))
                : state.groups.map((g) =>
                    h(
                      'div',
                      { key: g.id, style: S.card },
                      h('div', { style: S.title }, `${g.name}　${h('span', { style: S.chip(g.status === 'active') }, labels[g.status] ?? g.status)}`),
                      h('div', { style: S.meta }, `${t('leader')}：${g.leader}`, `${t('capacity')}：${g.members.length}/${g.capacity}`),
                      g.status === 'forming'
                        ? h('button', { style: S.gold, onClick: () => post('group/join', { id: g.id, duty: 'build' }) }, t('join'))
                        : null,
                    ),
                  ),
            ),

        state.notice ? h('div', { style: S.notice }, state.notice) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-training-collab: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: 'dsh-training-collab', order: 77, label: () => bound('nav'), locale: NS }, Panel),
          )
        } catch (e) {
          console.error('[dsh-training-collab] client apply failed:', e)
        }
      },
    }
  },
})
