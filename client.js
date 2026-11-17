/**
 * Hermes 式记忆管理 —— DSH 动态 Cordis 插件（Client 半边）
 *
 * 在最新 cordis_run 卡片内渲染记忆仪表盘：
 * MEMORY.md / USER.md 两个记忆库的条目数与字符用量 + 最近条目 + 存储文件位置 + 刷新按钮。
 * 数据通过 Package-private RPC（host.call('mem-stats')）从 Host 获取。
 */
return {
  inject: ['slots'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const labels = {
      unauthorized: 'Your login has expired. Sign in again, then reload this page.',
      forbidden: 'This account does not have permission. Sign in with an authorized account, then reload this page.',
      storage_reload_required: 'Storage protection has stopped writes. Stop other writers, inspect both storage files, then reload the plugin.',
      runtime_reload_required: 'The last write outcome is unknown. Inspect memory and pending changes, then reload the plugin.',
      storage_unavailable: 'Storage is temporarily unavailable. Retry loading later.',
      auth_service_unavailable: 'The authentication service is temporarily unavailable. Retry loading later.',
    }
    const blockedSafety = safety => !!safety?.state && safety.state !== 'open'
    const terminal = error => ['unauthorized', 'forbidden', 'storage_reload_required', 'runtime_reload_required'].includes(error?.code)
      || (blockedSafety(error?.storageSafety) && error.storageSafety.state !== 'unavailable')
    const failure = value => {
      const error = new Error(typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message || 'Memory store not ready')
      error.status = value?.status
      error.code = error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : value?.code
      error.storageSafety = value?.storageSafety
      error.retryable = value?.retryable
      return error
    }
    const describe = error => labels[error?.code] ? `${labels[error.code]} (${error.message})` : String(error?.message || error)
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => {
        const [stats, setStats] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [safety, setSafety] = React.useState(null)
        const [loading, setLoading] = React.useState(false)
        const epoch = React.useRef(0)
        const mounted = React.useRef(true)
        const terminalFailure = React.useRef(null)
        const observeSafety = next => {
          if (next && typeof next === 'object') setSafety(next)
        }
        const load = async () => {
          if (terminalFailure.current) return
          const request = ++epoch.current
          setLoading(true)
          setError(null)
          try {
            const value = await host.call('mem-stats', {})
            if (!mounted.current || request !== epoch.current) return
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid memory statistics response')
            observeSafety(value.storageSafety)
            if (value.ready !== true || value.success === false) throw failure(value)
            const validBank = (bank) => bank && Number.isInteger(bank.entries) && bank.entries >= 0 && typeof bank.usage === 'string'
            if (!validBank(value.memory) || !validBank(value.user)
              || (value.file !== undefined && typeof value.file !== 'string')
              || (value.recent !== undefined && (!Array.isArray(value.recent) || value.recent.some((row) => !row
                || (row.bank !== 'memory' && row.bank !== 'user') || typeof row.text !== 'string')))) {
              throw new Error('Invalid memory statistics response')
            }
            if (blockedSafety(value.storageSafety) && value.storageSafety.state !== 'unavailable') {
              const blocked = failure({ ...value, code: 'storage_reload_required' })
              terminalFailure.current = blocked
              setError(blocked)
            }
            setStats(value)
          } catch (e) {
            if (mounted.current && request === epoch.current) {
              const next = failure({ ...e, message: String(e?.message || e) })
              observeSafety(next.storageSafety)
              if (terminal(next)) terminalFailure.current = next
              setError(next)
            }
          } finally {
            if (mounted.current && request === epoch.current) setLoading(false)
          }
        }
        React.useEffect(() => {
          mounted.current = true
          void load()
          return () => { mounted.current = false; epoch.current += 1 }
        }, [])
        const card = {
          border: '1px solid var(--dsh-border, #444)',
          borderRadius: 8,
          padding: '10px 12px',
          margin: '8px 0',
          fontSize: 13,
          lineHeight: 1.5,
          fontFamily: 'inherit',
          overflowWrap: 'anywhere',
        }
        const row = { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }
        const chip = {
          background: 'var(--dsh-surface-2, rgba(128,128,128,.15))',
          borderRadius: 6,
          padding: '2px 8px',
        }
        const btn = {
          marginTop: 8,
          minWidth: 24,
          minHeight: 24,
          padding: '3px 10px',
          borderRadius: 6,
          border: '1px solid var(--dsh-border, #444)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        }
        const mono = { fontFamily: 'monospace', fontSize: 12, opacity: 0.75 }
        const children = [
          React.createElement('div', { key: 'title', style: { fontWeight: 600 } }, '🧠 Hermes Memory'),
        ]
        const storageText = blockedSafety(safety)
          ? safety.state === 'unavailable' ? 'Storage unavailable · writes paused. Retry loading later.' : 'Storage protection triggered · writes paused. Inspect both storage files, then reload the plugin.'
          : safety?.mode === 'guarded-native' ? 'Native storage protection · writer lease and external change checks enabled.'
            : safety?.mode === 'host-json' ? 'Host JSON storage · no cross-process writer lock or external change checks. Use one writer per storage directory.'
              : 'Storage protection status is unavailable from this host. Use one writer per storage directory.'
        children.push(React.createElement('div', { key: 'safety', role: 'status', style: { marginTop: 6 } }, storageText,
          safety?.error && React.createElement('div', null, typeof safety.error === 'string' ? safety.error : safety.error.message),
        ))
        if (error) {
          children.push(React.createElement('div', { key: 'err', role: 'alert', style: { color: '#e5484d' } }, `Error: ${describe(error)}`))
        }
        if (loading) {
          children.push(React.createElement('div', { key: 'load', role: 'status', style: { opacity: 0.7 } }, 'Loading…'))
        }
        if (stats !== null) {
          children.push(React.createElement('div', { key: 'counts', style: row },
            React.createElement('span', { style: chip }, `📝 MEMORY.md ${stats.memory.entries} entries · ${stats.memory.usage}`),
            React.createElement('span', { style: chip }, `👤 USER.md ${stats.user.entries} entries · ${stats.user.usage}`),
          ))
          if (stats.recent && stats.recent.length) {
            const recents = stats.recent.map((r) => React.createElement('div', {
              key: `${r.bank}-${r.updatedAt}-${r.text.slice(0, 12)}`,
              style: { wordBreak: 'normal', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
            }, `${r.bank === 'memory' ? '📝' : '👤'} ${r.text}`))
            children.push(React.createElement('div', { key: 'recent', style: { marginTop: 6 } },
              React.createElement('div', { style: { opacity: 0.7 } }, 'Recent:'),
              ...recents,
            ))
          }
          children.push(React.createElement('div', { key: 'file', style: { ...mono, marginTop: 6 } }, stats.file))
        }
        if (!terminalFailure.current && error?.retryable !== false) children.push(React.createElement('button', {
          key: 'btn', style: btn, onClick: () => { void load() }, disabled: loading,
        }, error ? '↻ Retry' : '↻ Refresh'))
        return React.createElement('div', { style: card }, ...children)
      },
    ))
  },
}
