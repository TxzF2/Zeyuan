// dsh-training-console — BROWSER 半：DSH 应用内「控制台」
//
// 加载方式：package.json 声明 exports["./client"] + dsh.client.inject。
// 不能裸 ESM import；官方依赖走 factory 注入的 require。
// 权限：业务等级 LV0/LV1 + 管理档位 P0/P6/P7/P8；高危操作必须二次确认 + 原因。
window.__ModuleLoader__.load({
  id: 'dsh-training-console',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-training-console'
    const zh = {
      nav: '泽元 · 控制台',
      loading: '正在读取控制台…',
      error: '无法连接控制台服务（插件可能未加载）',
      bootstrap: '初始化总师（P8）',
      bootstrapHint: '首次使用：当前身份将成为 P8 总师。仅在没有管理档位时可用。',
      dashboard: '概况',
      online: '在线用户',
      tasksToday: '今日任务',
      coinsToday: '今日金币',
      boardHealth: '板块',
      health: '健康',
      reconcile: '账目对账',
      users: '用户与档位',
      roles: '档位',
      scopes: 'Scope 下发',
      wallet: '钱包',
      audit: '审计日志',
      refresh: '刷新',
      confirmTitle: '高危操作确认',
      confirmReason: '原因（≥4 字，写入审计）',
      confirmOk: '确认执行',
      cancel: '取消',
      restartHint: '已写入 profile，重启 DSH 后生效',
      grant: '授予',
      revoke: '撤销',
      disable: '禁用',
      enable: '启用',
      grantCoins: '发币',
      balance: '余额',
      ledger: '流水',
      tier: 'P',
      protectedBoard: '受保护，不可停用',
      errs: { 'E-1105': '档位不足', 'E-1106': '受保护板块', 'E-1202': '档位不足', 'E-1203': '参数不合法', 'E-1215': '不能撤销最后一名 P8' },
    }
    const en = {
      nav: 'Zeyuan · Console',
      loading: 'Loading console…',
      error: 'Cannot reach console service (plugin not loaded?)',
      bootstrap: 'Bootstrap P8',
      bootstrapHint: 'The current identity becomes P8. Only when no admin tier exists.',
      dashboard: 'Overview',
      online: 'Online users',
      tasksToday: 'Tasks today',
      coinsToday: 'Coins today',
      boardHealth: 'Boards',
      health: 'Health',
      reconcile: 'Reconcile',
      users: 'Users & tiers',
      roles: 'Tiers',
      scopes: 'Scopes',
      wallet: 'Wallet',
      audit: 'Audit',
      refresh: 'Refresh',
      confirmTitle: 'Confirm high-risk action',
      confirmReason: 'Reason (min 4 chars, written to audit)',
      confirmOk: 'Confirm',
      cancel: 'Cancel',
      restartHint: 'Written to profile; restart DSH to apply',
      grant: 'Grant',
      revoke: 'Revoke',
      disable: 'Disable',
      enable: 'Enable',
      grantCoins: 'Grant coins',
      balance: 'Balance',
      ledger: 'Ledger',
      tier: 'P',
      protectedBoard: 'Protected',
      errs: { 'E-1105': 'Tier too low', 'E-1106': 'Protected board', 'E-1202': 'Tier too low', 'E-1203': 'Invalid', 'E-1215': 'Cannot revoke last P8' },
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
      badge: (on) => ({
        display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 10px', borderRadius: '999px',
        fontSize: '12px', border: `1px solid ${on ? GREEN : LINE}`, color: on ? GREEN : MUTED,
      }),
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', margin: '8px 0 12px' },
      card: { border: `1px solid ${LINE}`, borderRadius: '10px', padding: '10px 12px', background: INK2 },
      cardLabel: { fontSize: '12px', color: MUTED },
      cardValue: { fontSize: '20px', fontWeight: 600, color: TEXT, marginTop: '2px' },
      cardSub: { fontSize: '11.5px', color: MUTED, marginTop: '2px' },
      section: { marginTop: '14px' },
      title: { fontSize: '13px', color: GOLD, fontWeight: 600, marginBottom: '6px' },
      kv: { fontSize: '12.5px', lineHeight: '1.9', color: MUTED },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: TEXT },
      btn: { cursor: 'pointer', fontSize: '12.5px', padding: '4px 10px', borderRadius: '8px', border: `1px solid ${LINE}`, background: 'transparent', color: TEXT },
      gold: { cursor: 'pointer', fontSize: '13px', padding: '6px 14px', borderRadius: '8px', fontWeight: 600, border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.14)', color: GOLD },
      table: { width: '100%', fontSize: '12.5px', borderCollapse: 'collapse' },
      th: { textAlign: 'left', color: MUTED, fontWeight: 500, padding: '4px 6px', borderBottom: `1px solid ${LINE}` },
      td: { padding: '4px 6px', borderBottom: `1px solid ${INK3}`, color: TEXT },
      tag: (on) => ({ display: 'inline-block', fontSize: '11.5px', padding: '1px 7px', borderRadius: '6px', border: `1px solid ${on ? GOLD : LINE}`, color: on ? GOLD : MUTED, marginRight: '4px' }),
      hint: { fontSize: '12px', color: MUTED, marginTop: '8px' },
      err: { color: RED, fontSize: '13px' },
      notice: { fontSize: '12.5px', marginTop: '8px', color: TEXT },
      input: { width: '100%', boxSizing: 'border-box', marginTop: '4px', padding: '6px 8px', borderRadius: '8px', border: `1px solid ${LINE}`, background: INK2, color: TEXT, fontSize: '13px' },
      modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
      modalBox: { width: '360px', border: `1px solid ${GOLD}`, borderRadius: '12px', background: INK3, padding: '16px', color: TEXT },
    }

    const API = '/dsh-training/console'
    const TARGETS = { users: 'users', createUser: 'users/create', disableUser: 'users/disable', grantTier: 'admins/grant', revokeTier: 'admins/revoke', grantScope: 'scopes/grant', revokeScope: 'scopes/revoke', toggleBoard: 'boards/toggle', grantCoins: 'wallet/grant' }

    function Panel() {
      const [state, setState] = useState({ status: 'loading', me: null, dash: null, health: null, users: null, admins: null, scopes: null, boards: null, audit: null, wallet: null, notice: '' })
      const [pending, setPending] = useState(null) // { action, payload, label }
      const [reason, setReason] = useState('')

      const load = useCallback(() => {
        fetch(`${API}/me`)
          .then((r) => r.json())
          .then((me) => {
            const tier = me.data?.adminTier ?? 0
            const can = tier >= 6
            return Promise.all([
              fetch(`${API}/health`).then((r) => r.json()),
              can ? fetch(`${API}/dashboard`).then((r) => r.json()) : Promise.resolve({ data: null }),
              can ? fetch(`${API}/users`).then((r) => r.json()) : Promise.resolve({ data: null }),
              can ? fetch(`${API}/admins`).then((r) => r.json()) : Promise.resolve({ data: null }),
              can ? fetch(`${API}/scopes`).then((r) => r.json()) : Promise.resolve({ data: null }),
              can ? fetch(`${API}/boards`).then((r) => r.json()) : Promise.resolve({ data: null }),
              can ? fetch(`${API}/audit?limit=20`).then((r) => r.json()) : Promise.resolve({ data: null }),
              can ? fetch(`${API}/wallet/ledger?limit=20`).then((r) => r.json()) : Promise.resolve({ data: null }),
            ]).then(([health, dash, users, admins, scopes, boards, audit, wallet]) =>
              setState((s) => ({
                ...s,
                status: 'ok',
                me: me.data,
                health: health.data,
                dash: dash.data,
                users: users.data,
                admins: admins.data,
                scopes: scopes.data,
                boards: boards.data,
                audit: audit.data,
                wallet: wallet.data,
              })),
            )
          })
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [])

      useEffect(() => { load() }, [load])

      const doAction = (action, payload, label) => {
        const highRisk = ['disableUser', 'grantTier', 'revokeTier', 'grantScope', 'revokeScope', 'toggleBoard', 'grantCoins'].includes(action)
        if (highRisk) return setPending({ action, payload, label })
        send(action, payload, null)
      }

      const send = (action, payload, why) => {
        fetch(`${API}/${TARGETS[action]}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, ...(why ? { confirm: true, reason: why } : {}) }),
        })
          .then((r) => r.json())
          .then((res) => {
            const msg = res.ok ? '✅ 操作成功' : `❌ ${res.code} ${(t('errs') || {})[res.code] ?? ''} ${res.message ?? ''}`.trim()
            setNotice(msg)
            load()
          })
          .catch(() => setNotice('❌ 请求失败'))
      }

      const setNotice = (msg) => setState((s) => ({ ...s, notice: msg }))

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-console' }, t('loading'))
      if (state.status === 'error') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-console' }, h('div', { style: S.err }, t('error')))

      const me = state.me ?? {}
      const tier = me.adminTier ?? 0
      const dash = state.dash ?? {}
      const health = state.health ?? {}
      const can6 = tier >= 6
      const can7 = tier >= 7
      const can8 = tier === 8
      const card = (label, value, sub) =>
        h('div', { style: S.card }, h('div', { style: S.cardLabel }, label), h('div', { style: S.cardValue }, String(value ?? '-')), sub ? h('div', { style: S.cardSub }, sub) : null)

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-console', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('nav')),
          h('span', { style: S.badge(tier >= 6) }, `P${tier} · ${me.user ?? '-'}`),
          h('span', { style: S.badge(me.businessLevel === 'LV1') }, me.businessLevel ?? '-'),
          h('span', { style: { flex: 1 } }),
          state.admins && state.admins.admins.length === 0
            ? h('button', { style: S.gold, onClick: () => setPending({ action: 'bootstrap', payload: {}, label: t('bootstrap') }) }, t('bootstrap'))
            : null,
          h('button', { style: S.btn, onClick: load }, t('refresh')),
        ),
        state.admins && state.admins.admins.length === 0 ? h('div', { style: S.hint }, t('bootstrapHint')) : null,

        h(
          'div',
          { style: S.grid },
          card(t('online'), `${dash.online?.current ?? 0}/${dash.online?.total ?? 0}`),
          card(t('tasksToday'), `${dash.tasks?.createdToday ?? 0}/${dash.tasks?.acceptedToday ?? 0}`, `总 ${dash.tasks?.total ?? 0}`),
          card(t('coinsToday'), dash.coins?.today ?? 0, `发币 ${dash.coins?.grantedToday ?? 0}`),
          card(t('boardHealth'), (dash.boards ?? []).filter((b) => b.enabled).length, `共 ${(dash.boards ?? []).length}`),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.title }, `${t('health')}：${health.ok ? '✅' : '❌'} ｜ ${t('reconcile')}：${health.reconcile?.ok ? '✅' : '❌'}`),
          h('div', { style: S.kv }, (health.plugins ?? []).map((p) => `${p.lastEvent === 'mounted' ? '✅' : '❌'} ${p.plugin} ${p.host ?? '-'}`).join('　')),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.title }, t('boardHealth')),
          h(
            'table',
            { style: S.table },
            h('thead', null, h('tr', null, h('th', { style: S.th }, '板块'), h('th', { style: S.th }, '插件'), h('th', { style: S.th }, '状态'), h('th', { style: S.th }, ''))),
            h(
              'tbody',
              null,
              (state.boards ?? []).map((b) =>
                h(
                  'tr',
                  { key: b.board },
                  h('td', { style: S.td }, h('span', { style: S.code }, b.board)),
                  h('td', { style: S.td }, b.pkg ?? '—'),
                  h('td', { style: S.td }, b.protected ? t('protectedBoard') : b.enabled ? '启用' : '停用'),
                  h(
                    'td',
                    { style: S.td },
                    !b.protected && can6
                      ? h('button', { style: S.btn, onClick: () => doAction('toggleBoard', { board: b.board, enabled: !b.enabled }, `${b.enabled ? '停用' : '启用'} ${b.board}`) }, b.enabled ? '停用' : '启用')
                      : null,
                  ),
                ),
              ),
            ),
          ),
          h('div', { style: S.hint }, t('restartHint')),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.title }, t('users')),
          h(
            'table',
            { style: S.table },
            h('thead', null, h('tr', null, h('th', { style: S.th }, '用户'), h('th', { style: S.th }, t('roles')), h('th', { style: S.th }, ''))),
            h(
              'tbody',
              null,
              (state.users?.users ?? []).map((u) => {
                const admin = (state.admins?.admins ?? []).find((a) => a.userId === u.id)
                return h(
                  'tr',
                  { key: u.id },
                  h('td', { style: S.td }, h('span', { style: S.code }, u.id), u.disabled ? h('span', { style: S.tag(false) }, '禁用') : null),
                  h('td', { style: S.td }, admin ? h('span', { style: S.tag(true) }, `P${admin.tier}`) : 'P0'),
                  h(
                    'td',
                    { style: S.td },
                    can7
                      ? h('button', { style: S.btn, onClick: () => doAction(admin ? 'revokeTier' : 'grantTier', { id: u.id, ...(admin ? {} : { tier: 6 }) }, `${admin ? '撤销' : '授予'} ${u.id}`) }, admin ? t('revoke') : `${t('grant')} P6`)
                      : null,
                    ' ',
                    can7
                      ? h('button', { style: S.btn, onClick: () => doAction('disableUser', { id: u.id, disabled: !u.disabled }, `${u.disabled ? '启用' : '禁用'} ${u.id}`) }, u.disabled ? t('enable') : t('disable'))
                      : null,
                  ),
                )
              }),
            ),
          ),
          h('div', { style: S.hint }, `P6 可开关板块 / P7 可管用户与 review scope / P8 可发币与管理员 scope`),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.title }, t('scopes')),
          h('div', { style: S.kv }, (state.scopes ?? []).map((s) => `${s.userId}: ${s.scopes.join(', ')}`).join('　') || '（暂无）'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' } },
            can7
              ? h('button', { style: S.btn, onClick: () => doAction('grantScope', { id: me.user, scope: 'training:review' }, '授予自己 review') }, `${t('grant')} review（自己）`)
              : null,
            can8
              ? h('button', { style: S.btn, onClick: () => doAction('grantScope', { id: me.user, scope: 'training:admin' }, '授予自己 admin') }, `${t('grant')} admin（自己）`)
              : null,
          ),
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.title }, t('wallet')),
          h('div', { style: S.kv }, `余额：${dash.coins?.today ?? 0} 今日 / 发币 ${dash.coins?.grantedToday ?? 0}`),
          h(
            'div',
            { style: S.kv },
            (state.wallet ?? []).slice(0, 8).map((r) => `${String(r.at).slice(11, 19)} ${r.userId} ${r.delta > 0 ? '+' : ''}${r.delta} ${r.reason}`).join('　') || '（暂无流水）',
          ),
          can8
            ? h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                h('button', { style: S.gold, onClick: () => doAction('grantCoins', { id: me.user, amount: 10 }, '给自己发 10 金币') }, `${t('grantCoins')} 10`),
              )
            : null,
        ),

        h(
          'div',
          { style: S.section },
          h('div', { style: S.title }, t('audit')),
          h(
            'div',
            { style: S.kv },
            (state.audit?.rows ?? []).slice(0, 8).map((a) => `${String(a.at).slice(11, 19)} ${a.action} ${a.target ?? ''} ${a.result}${a.reason ? `（${a.reason}）` : ''}`).join('　') || '（暂无）',
          ),
        ),

        state.notice ? h('div', { style: S.notice }, state.notice) : null,

        pending
          ? h(
              'div',
              { style: S.modal, onClick: () => setPending(null) },
              h(
                'div',
                { style: S.modalBox, onClick: (e) => e.stopPropagation() },
                h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, t('confirmTitle')),
                h('div', { style: S.kv }, pending.label),
                h('div', { style: { ...S.kv, marginTop: '8px' } }, t('confirmReason')),
                h('input', { style: S.input, value: reason, onChange: (e) => setReason(e.target.value) }),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', marginTop: '10px', justifyContent: 'flex-end' } },
                  h('button', { style: S.btn, onClick: () => setPending(null) }, t('cancel')),
                  h(
                    'button',
                    {
                      style: S.gold,
                      onClick: () => {
                        if (pending.action === 'bootstrap') send('bootstrap', {}, reason)
                        else send(pending.action, pending.payload, reason)
                        setPending(null)
                        setReason('')
                      },
                    },
                    t('confirmOk'),
                  ),
                ),
              ),
            )
          : null,
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
