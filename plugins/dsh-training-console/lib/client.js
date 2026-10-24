// dsh-training-console — BROWSER 半：DSH 应用内「控制面板」
//
// 加载方式：package.json 声明 exports["./client"] + dsh.client.inject。
// 不能裸 ESM import；官方依赖走 factory 注入的 require。
// 配色：墨绿 + 星辰金；颜色优先 --dsw-alias-*，字面量兜底。
window.__ModuleLoader__.load({
  id: 'dsh-training-console',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-training-console'
    const zh = {
      nav: '培训班 · 控制面板',
      loading: '正在读取面板…',
      error: '无法连接控制面板服务（插件可能未加载）',
      user: '身份',
      admin: '管理员',
      notAdmin: '非管理员（只读）',
      bootstrap: '初始化管理员',
      bootstrapHint: '首次使用：点击后当前身份将成为管理员。仅在没有管理员时可用。',
      dashboard: '概况',
      tasks: '任务',
      drafts: '草稿',
      posts: '帖子',
      events: '事件',
      users: '用户',
      boards: '板块',
      health: '健康',
      ok: '正常',
      bad: '异常',
      role: '角色',
      disable: '禁用',
      enable: '启用',
      grant: '设为管理员',
      revoke: '撤销管理员',
      protectedBoard: '受保护，不可停用',
      plugins: '插件挂载',
      license: '授权',
      files: '数据文件',
      audit: '最近管理动作',
      refresh: '刷新',
      errs: { 'E-1105': '需要管理员', 'E-1107': '不能撤销最后一个管理员', 'E-1101': '已存在管理员' },
    }
    const en = {
      nav: 'Training · Console',
      loading: 'Loading console…',
      error: 'Cannot reach console service (plugin not loaded?)',
      user: 'User',
      admin: 'Admin',
      notAdmin: 'Read-only',
      bootstrap: 'Bootstrap admin',
      bootstrapHint: 'First run: the current identity becomes admin. Only when no admin exists.',
      dashboard: 'Overview',
      tasks: 'Tasks',
      drafts: 'Drafts',
      posts: 'Posts',
      events: 'Events',
      users: 'Users',
      boards: 'Boards',
      health: 'Health',
      ok: 'OK',
      bad: 'Bad',
      role: 'Role',
      disable: 'Disable',
      enable: 'Enable',
      grant: 'Make admin',
      revoke: 'Revoke admin',
      protectedBoard: 'Protected',
      plugins: 'Plugins',
      license: 'License',
      files: 'Data files',
      audit: 'Recent admin actions',
      refresh: 'Refresh',
      errs: { 'E-1105': 'Admin required', 'E-1107': 'Cannot revoke the last admin', 'E-1101': 'Admin already exists' },
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
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', margin: '8px 0 12px' },
      card: {
        border: `1px solid ${LINE}`, borderRadius: '10px', padding: '10px 12px', background: INK2,
      },
      cardLabel: { fontSize: '12px', color: MUTED },
      cardValue: { fontSize: '20px', fontWeight: 600, color: TEXT, marginTop: '2px' },
      cardSub: { fontSize: '11.5px', color: MUTED, marginTop: '2px' },
      section: { marginTop: '14px' },
      sectionTitle: { fontSize: '13px', color: GOLD, fontWeight: 600, marginBottom: '6px' },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' },
      kv: { fontSize: '12.5px', lineHeight: '1.9', color: MUTED },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: TEXT },
      btn: (on) => ({
        cursor: 'pointer', fontSize: '12.5px', padding: '4px 10px', borderRadius: '8px',
        border: `1px solid ${on ? LINE : LINE}`, background: 'transparent', color: TEXT,
      }),
      gold: {
        cursor: 'pointer', fontSize: '13px', padding: '6px 14px', borderRadius: '8px', fontWeight: 600,
        border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.14)', color: GOLD,
      },
      hint: { fontSize: '12px', color: MUTED, marginTop: '8px' },
      err: { color: RED, fontSize: '13px' },
      notice: { fontSize: '12.5px', marginTop: '8px', color: TEXT },
      table: { width: '100%', fontSize: '12.5px', borderCollapse: 'collapse' },
      th: { textAlign: 'left', color: MUTED, fontWeight: 500, padding: '4px 6px', borderBottom: `1px solid ${LINE}` },
      td: { padding: '4px 6px', borderBottom: `1px solid ${INK3}`, color: TEXT },
      tag: (on) => ({
        display: 'inline-block', fontSize: '11.5px', padding: '1px 7px', borderRadius: '6px',
        border: `1px solid ${on ? GREEN : LINE}`, color: on ? GREEN : MUTED, marginRight: '4px',
      }),
    }

    const API = '/dsh-training/console'

    function Panel() {
      const [state, setState] = useState({ status: 'loading', me: null, dash: null, health: null, users: null, boards: null, audit: null, notice: '' })

      const load = useCallback(() => {
        Promise.all([
          fetch(`${API}/me`).then((r) => r.json()),
          fetch(`${API}/dashboard`).then((r) => r.json()),
          fetch(`${API}/health`).then((r) => r.json()),
        ])
          .then(([me, dash, health]) => {
            const isAdmin = Boolean(me.data?.isAdmin)
            const extra = isAdmin
              ? Promise.all([
                  fetch(`${API}/users`).then((r) => r.json()),
                  fetch(`${API}/boards`).then((r) => r.json()),
                  fetch(`${API}/audit`).then((r) => r.json()),
                ])
              : Promise.resolve([null, null, null])
            return extra.then(([users, boards, audit]) =>
              setState((s) => ({
                ...s,
                status: 'ok',
                me: me.data ?? null,
                dash: dash.data ?? null,
                health: health.data ?? null,
                users: users?.data ?? null,
                boards: boards?.data ?? null,
                audit: audit?.data ?? null,
              })),
            )
          })
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [])

      useEffect(() => { load() }, [load])

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

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-console' }, t('loading'))
      if (state.status === 'error') {
        return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-console' }, h('div', { style: S.err }, t('error')))
      }

      const me = state.me ?? {}
      const dash = state.dash ?? {}
      const health = state.health ?? {}
      const isAdmin = Boolean(me.isAdmin)
      const card = (label, value, sub) =>
        h('div', { style: S.card }, h('div', { style: S.cardLabel }, label), h('div', { style: S.cardValue }, String(value ?? '-')), sub ? h('div', { style: S.cardSub }, sub) : null)

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-console', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('nav')),
          h('span', { style: S.badge(isAdmin) }, isAdmin ? `${t('admin')} · ${me.user}` : `${t('notAdmin')} · ${me.user}`),
          h('span', { style: S.badge(me.level === 'LV1') }, me.level ?? '-'),
          h('span', { style: { flex: 1 } }),
          !isAdmin && dash?.users?.admins === 0
            ? h('button', { style: S.gold, onClick: () => post('bootstrap', { confirm: true }) }, t('bootstrap'))
            : null,
          h('button', { style: S.btn(true), onClick: load }, t('refresh')),
        ),
        !isAdmin && dash?.users?.admins === 0 ? h('div', { style: S.hint }, t('bootstrapHint')) : null,

        h(
          'div',
          { style: S.grid, 'data-dsh-part': 'metrics' },
          card(t('tasks'), dash?.tasks?.total ?? 0, Object.entries(dash?.tasks?.byStatus ?? {}).map(([k, v]) => `${k}:${v}`).join(' ')),
          card(t('drafts'), dash?.drafts?.total ?? 0, Object.entries(dash?.drafts?.byStatus ?? {}).map(([k, v]) => `${k}:${v}`).join(' ')),
          card(t('posts'), dash?.posts?.total ?? 0, `❤️ ${dash?.posts?.likes ?? 0}`),
          card(t('events'), dash?.events?.total ?? 0),
          card(t('users'), dash?.users?.total ?? 0, `${t('admin')} ${dash?.users?.admins ?? 0}`),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.sectionTitle }, `${t('health')}：${health.ok ? t('ok') : t('bad')}`),
          h(
            'div',
            { style: S.kv },
            (health.plugins ?? []).map((p) =>
              h('div', { key: p.plugin }, `${p.lastEvent === 'mounted' ? '✅' : '❌'} ${p.plugin} · ${p.lastEvent} · ${p.host ?? '-'} · ${String(p.at ?? '').slice(11, 19)}`),
            ),
            h('div', { style: S.kv }, `${t('license')}：${health.license?.level ?? '-'} · ${health.license?.code ?? '-'} · 到期 ${String(health.license?.expiresAt ?? '-').slice(0, 10)}`),
            h('div', { style: S.kv }, `${t('files')}：` + Object.entries(health.files ?? {}).map(([k, v]) => `${v ? '✅' : '—'} ${k}`).join('  ')),
          ),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.sectionTitle }, t('boards')),
          h(
            'table',
            { style: S.table },
            h('thead', null, h('tr', null, h('th', { style: S.th }, 'id'), h('th', { style: S.th }, '状态'), h('th', { style: S.th }, ''))),
            h(
              'tbody',
              null,
              (state.boards ?? []).map((b) =>
                h(
                  'tr',
                  { key: b.id },
                  h('td', { style: S.td }, h('span', { style: S.code }, b.id)),
                  h('td', { style: S.td }, b.enabled ? '启用' : '停用', b.protected ? ` · ${t('protectedBoard')}` : ''),
                  h(
                    'td',
                    { style: S.td },
                    b.protected
                      ? null
                      : h(
                          'button',
                          { style: S.btn(!b.enabled), onClick: () => post('boards/toggle', { id: b.id, enabled: !b.enabled }) },
                          b.enabled ? '停用' : '启用',
                        ),
                  ),
                ),
              ),
            ),
          ),
          !state.boards ? h('div', { style: S.hint }, isAdmin ? '' : t('notAdmin')) : null,
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.sectionTitle }, t('users')),
          state.users
            ? h(
                'table',
                { style: S.table },
                h('thead', null, h('tr', null, h('th', { style: S.th }, 'id'), h('th', { style: S.th }, t('role')), h('th', { style: S.th }, ''))),
                h(
                  'tbody',
                  null,
                  state.users.users.map((u) =>
                    h(
                      'tr',
                      { key: u.id },
                      h('td', { style: S.td }, h('span', { style: S.code }, u.id), u.disabled ? h('span', { style: S.tag(false) }, '禁用') : null),
                      h('td', { style: S.td }, u.roles.map((r) => h('span', { key: r, style: S.tag(r === 'admin') }, r))),
                      h(
                        'td',
                        { style: S.td },
                        h(
                          'button',
                          { style: S.btn(false), onClick: () => post('users/role', { id: u.id, role: 'admin', grant: !u.roles.includes('admin') }) },
                          u.roles.includes('admin') ? t('revoke') : t('grant'),
                        ),
                        ' ',
                        h(
                          'button',
                          { style: S.btn(false), onClick: () => post('users/disable', { id: u.id, disabled: !u.disabled }) },
                          u.disabled ? t('enable') : t('disable'),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : h('div', { style: S.hint }, isAdmin ? '—' : t('notAdmin')),
        ),

        state.audit && state.audit.total > 0
          ? h(
              'div',
              { style: S.section },
              h('div', { style: S.sectionTitle }, t('audit')),
              h(
                'div',
                { style: S.kv },
                state.audit.rows.slice(0, 8).map((a, i) =>
                  h('div', { key: i }, `${String(a.at).slice(11, 19)} · ${a.type.replace('dsh-training:feature-console:', '')} · ${JSON.stringify(a.payload)}`),
                ),
              ),
            )
          : null,

        state.notice ? h('div', { style: S.notice }, state.notice) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-training-console: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-training-console', order: 76, label: () => bound('nav'), locale: NS },
              Panel,
            ),
          )
        } catch (e) {
          console.error('[dsh-training-console] client apply failed:', e)
        }
      },
    }
  },
})
