// dsh-training-protocol — BROWSER 半：DSH 应用内常驻「协议授权」面板
//
// 加载方式：package.json 声明 `exports["./client"]` + `dsh.client.inject`，
// DSH 模块加载器把本文件并入客户端 roster。
// 这里不能用裸 ESM `import`——官方依赖必须通过 factory 注入的 require 取。
//
window.__ModuleLoader__.load({
  id: 'dsh-training-protocol',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-training-protocol'
    const zh = {
      nav: '培训班 · 协议授权',
      loading: '正在读取授权状态…',
      error: '无法连接协议服务（插件可能未加载）',
      level: '当前等级',
      checks: '校验项',
      license: 'License 详情',
      none: '尚未签署',
      subject: '学员',
      scopes: '授权范围',
      issuedAt: '签发时间',
      expiresAt: '到期时间',
      signature: '签名',
      paths: '文件位置',
      sign: '签署协议（30 天）',
      revoke: '吊销并退回 LV0',
      verify: '重新校验',
      signing: '签署中…',
      signed: '已签署',
      revoked: '已吊销',
      checkLabels: {
        exists: '存在性',
        shape: '格式',
        keyPresent: '密钥',
        signature: '签名（HMAC）',
        notExpired: '时效',
        scope: 'scope 覆盖',
      },
      hint: 'LV0 可浏览课程目录；签署并通过校验后进入 LV1，解锁实训场与陪练。',
    }
    const en = {
      nav: 'Training · Protocol',
      loading: 'Loading license state…',
      error: 'Cannot reach protocol service (plugin not loaded?)',
      level: 'Level',
      checks: 'Checks',
      license: 'License',
      none: 'Not signed',
      subject: 'Subject',
      scopes: 'Scopes',
      issuedAt: 'Issued',
      expiresAt: 'Expires',
      signature: 'Signature',
      paths: 'Files',
      sign: 'Sign protocol (30 days)',
      revoke: 'Revoke → LV0',
      verify: 'Re-verify',
      signing: 'Signing…',
      signed: 'Signed',
      revoked: 'Revoked',
      checkLabels: {
        exists: 'Exists',
        shape: 'Shape',
        keyPresent: 'Key',
        signature: 'Signature (HMAC)',
        notExpired: 'Expiry',
        scope: 'Scope',
      },
      hint: 'LV0 browses the catalogue; a valid license unlocks LV1 (playground & coaching).',
    }

    let t = (k) => k
    const setT = (fn) => {
      t = fn
    }

    // 颜色一律走 --dsw-alias-* 令牌（DSH Web 样式契约），字面量仅作兜底
    const S = {
      box: { padding: '6px 2px', color: 'var(--dsw-alias-label-primary, #e6edf3)', fontFamily: 'inherit' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' },
      badge: (ok) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 10px',
        borderRadius: '999px',
        fontSize: '12px',
        border: `1px solid ${ok ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-border-l1, #30363d)'}`,
        color: ok ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-label-secondary, #8b949e)',
      }),
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '10px 0 0' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', margin: '8px 0 0' },
      cell: (ok) => ({
        border: '1px solid var(--dsw-alias-border-l1, #30363d)',
        borderRadius: '8px',
        padding: '8px 10px',
        fontSize: '12.5px',
        background: 'var(--dsw-alias-bg-layer-1, #0d1117)',
        color: ok ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-state-error-primary, #f85149)',
      }),
      kv: { fontSize: '12.5px', lineHeight: '1.9', margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary, #8b949e)' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--dsw-alias-label-primary, #e6edf3)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8b949e)', marginTop: '10px' },
      err: { color: 'var(--dsw-alias-state-error-primary, #f85149)', fontSize: '13px' },
      btn: {
        cursor: 'pointer',
        fontSize: '13px',
        padding: '6px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #30363d)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #e6edf3)',
      },
      primary: {
        cursor: 'pointer',
        fontSize: '13px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-button-primary-fill, #2f81f7)',
        background: 'var(--dsw-alias-button-primary-fill, #2f81f7)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        fontWeight: 600,
      },
    }

    const API = '/dsh-training/protocol'

    function Panel() {
      const [state, setState] = useState({ status: 'loading', data: null, notice: '' })

      const load = useCallback(() => {
        fetch(`${API}/state`)
          .then((r) => r.json())
          .then((data) => setState({ status: 'ok', data, notice: '' }))
          .catch(() => setState({ status: 'error', data: null, notice: '' }))
      }, [])

      useEffect(() => { load() }, [load])

      const call = (path, body) =>
        fetch(`${API}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
          .then((r) => r.json())
          .then((res) => {
            setState((s) => ({ ...s, notice: res.ok ? `✅ ${path}` : `❌ ${res.code} ${res.reason ?? ''}` }))
            load()
          })
          .catch(() => setState((s) => ({ ...s, notice: `❌ ${path} 请求失败` })))

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-protocol' }, t('loading'))
      if (state.status === 'error') {
        return h(
          'div',
          { style: S.box, 'data-dsh-plugin': 'dsh-training-protocol' },
          h('div', { style: S.err }, t('error')),
          h('div', { style: S.hint }, t('hint')),
        )
      }

      const d = state.data
      const ok = d.level === 'LV1'
      const labels = t('checkLabels') || {}
      const checks = d.check?.checks ?? {}

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-protocol', 'data-dsh-surface': 'settings-modal' },
        h(
          'div',
          { style: S.header },
          h('strong', null, t('level')),
          h('span', { style: S.badge(ok) }, ok ? 'LV1 · 已授权' : 'LV0 · 未授权'),
          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8b949e)' } }, `code=${d.check?.code}`),
        ),

        h('div', { style: S.kv }, d.check?.reason ?? ''),

        h('div', { style: { ...S.kv, marginTop: '12px' } }, t('checks')),
        h(
          'div',
          { style: S.grid, 'data-dsh-part': 'checks' },
          Object.keys(checks).map((k) =>
            h('div', { key: k, style: S.cell(Boolean(checks[k])) }, `${checks[k] ? '✅' : '❌'} ${labels[k] ?? k}`),
          ),
        ),

        h('div', { style: { ...S.kv, marginTop: '14px' } }, t('license')),
        d.license
          ? h(
              'div',
              { style: S.kv },
              h('div', null, `${t('subject')}：`, h('span', { style: S.code }, d.license.subject)),
              h('div', null, `${t('scopes')}：`, h('span', { style: S.code }, d.license.scopes.join(', '))),
              h('div', null, `${t('issuedAt')}：`, h('span', { style: S.code }, d.license.issuedAt)),
              h('div', null, `${t('expiresAt')}：`, h('span', { style: S.code }, d.license.expiresAt)),
              h('div', null, `${t('signature')}：`, h('span', { style: S.code }, d.license.signatureShort)),
            )
          : h('div', { style: S.kv }, t('none')),

        h(
          'div',
          { style: S.row },
          h('button', { style: S.primary, onClick: () => call('sign', { confirm: true, days: 30 }) }, t('sign')),
          h('button', { style: S.btn, onClick: () => call('verify', {}) }, t('verify')),
          h('button', { style: S.btn, onClick: () => call('revoke', {}) }, t('revoke')),
        ),

        state.notice ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-label-primary, #e6edf3)' } }, state.notice) : null,

        h(
          'div',
          { style: S.hint },
          `${t('paths')}：`,
          h('span', { style: S.code }, d.paths?.license ?? ''),
          ' ｜ ',
          h('span', { style: S.code }, d.paths?.key ?? ''),
        ),
        h('div', { style: S.hint }, t('hint')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-training-protocol: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-training-protocol',
                order: 72,
                label: () => bound('nav'),
                locale: NS,
              },
              Panel,
            ),
          )
        } catch (e) {
          console.error('[dsh-training-protocol] client apply failed:', e)
        }
      },
    }
  },
})
