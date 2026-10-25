// dsh-training-exchange — BROWSER 半：泽元中转站（最小 UI，移动端可用）
window.__ModuleLoader__.load({
  id: 'dsh-training-exchange',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement
    const NS = 'dsh-training-exchange'

    const zh = {
      nav: '泽元 · 泽元中转站',
      loading: '正在读取文件列表…',
      error: '无法连接中转站服务（插件可能未加载）',
      upload: '选择文件上传',
      uploading: '上传中…',
      empty: '暂无文件',
      download: '下载',
      remove: '删除',
      size: '大小',
      uploader: '上传者（节点）',
      expires: '过期',
      hint: '匿名中转：仅记录节点 ID，保留 30 天；单文件 ≤500MB',
      tooBig: '单文件不能超过 500MB',
      errs: { 'E-1501': '超出大小上限', 'E-1502': '无权限', 'E-1503': '参数非法', 'E-1504': '文件不存在' },
    }
    const en = {
      nav: 'Zeyuan · Transfer',
      loading: 'Loading files…',
      error: 'Cannot reach transfer service (plugin not loaded?)',
      upload: 'Choose file',
      uploading: 'Uploading…',
      empty: 'No files',
      download: 'Download',
      remove: 'Delete',
      size: 'Size',
      uploader: 'Uploader (node)',
      expires: 'Expires',
      hint: 'Anonymous transfer: node id only, 30-day retention, ≤500MB per file',
      tooBig: 'File exceeds 500MB',
      errs: { 'E-1501': 'Too large', 'E-1502': 'Not permitted', 'E-1503': 'Invalid', 'E-1504': 'Not found' },
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

    const S = {
      box: { padding: '6px 2px', color: TEXT, fontFamily: 'inherit' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' },
      card: { border: `1px solid ${LINE}`, borderRadius: '10px', padding: '10px 12px', background: INK2, marginBottom: '8px' },
      title: { fontSize: '14px', fontWeight: 600, color: TEXT, wordBreak: 'break-all' },
      meta: { fontSize: '12px', color: MUTED, display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px' },
      btn: { cursor: 'pointer', fontSize: '12.5px', padding: '6px 12px', borderRadius: '8px', border: `1px solid ${LINE}`, background: 'transparent', color: TEXT, marginRight: '6px' },
      gold: { cursor: 'pointer', fontSize: '13px', padding: '8px 14px', borderRadius: '8px', fontWeight: 600, border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.14)', color: GOLD },
      hint: { fontSize: '12px', color: MUTED, marginTop: '8px' },
      err: { color: RED, fontSize: '13px' },
      notice: { fontSize: '12.5px', marginTop: '8px', color: TEXT },
      file: { display: 'block', marginTop: '8px', fontSize: '13px', color: MUTED },
    }

    const API = '/dsh-training/exchange'
    const fmt = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

    function Panel() {
      const [state, setState] = useState({ status: 'loading', files: [], notice: '', uploading: false })

      const load = useCallback(() => {
        fetch(`${API}/list`)
          .then((r) => r.json())
          .then((res) => setState((s) => ({ ...s, status: 'ok', files: res.ok ? res.data : [] })))
          .catch(() => setState((s) => ({ ...s, status: 'error' })))
      }, [])
      useEffect(() => { load() }, [load])

      const upload = (file) => {
        if (!file) return
        if (file.size > 500 * 1024 * 1024) return setState((s) => ({ ...s, notice: `❌ ${t('tooBig')}` }))
        setState((s) => ({ ...s, uploading: true, notice: t('uploading') }))
        fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        })
          .then((r) => r.json())
          .then((res) => {
            setState((s) => ({ ...s, uploading: false, notice: res.ok ? `✅ 已上传：${res.data.name}` : `❌ ${res.code} ${(t('errs') || {})[res.code] ?? ''}` }))
            load()
          })
          .catch(() => setState((s) => ({ ...s, uploading: false, notice: '❌ 上传失败' })))
      }

      const remove = (id) =>
        fetch(`${API}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
          .then((r) => r.json())
          .then((res) => {
            setState((s) => ({ ...s, notice: res.ok ? '✅ 已删除' : `❌ ${res.code} ${(t('errs') || {})[res.code] ?? ''}` }))
            load()
          })

      if (state.status === 'loading') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-exchange' }, t('loading'))
      if (state.status === 'error') return h('div', { style: S.box, 'data-dsh-plugin': 'dsh-training-exchange' }, h('div', { style: S.err }, t('error')))

      return h(
        'div',
        { style: S.box, 'data-dsh-plugin': 'dsh-training-exchange', 'data-dsh-surface': 'settings-modal' },
        h('div', { style: S.header }, h('strong', null, t('nav')), h('span', { style: { fontSize: '12px', color: MUTED } }, t('hint'))),
        h('input', {
          type: 'file',
          style: S.file,
          disabled: state.uploading,
          onChange: (e) => {
            upload(e.target.files?.[0])
            e.target.value = ''
          },
        }),
        state.files.length === 0
          ? h('div', { style: S.hint }, t('empty'))
          : state.files.map((f) =>
              h(
                'div',
                { key: f.id, style: S.card },
                h('div', { style: S.title }, f.name),
                h('div', { style: S.meta }, `${t('size')}：${fmt(f.size)}`, `${t('uploader')}：${f.uploader}`, `${t('expires')}：${String(f.expiresAt).slice(0, 10)}`),
                h(
                  'div',
                  { style: { marginTop: '8px' } },
                  h('a', { style: { ...S.btn, textDecoration: 'none', display: 'inline-block' }, href: `${API}/download?id=${f.id}`, download: f.name }, t('download')),
                  h('button', { style: S.btn, onClick: () => remove(f.id) }, t('remove')),
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
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-training-exchange: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: 'dsh-training-exchange', order: 78, label: () => bound('nav'), locale: NS }, Panel),
          )
        } catch (e) {
          console.error('[dsh-training-exchange] client apply failed:', e)
        }
      },
    }
  },
})
