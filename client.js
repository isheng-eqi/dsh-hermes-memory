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
    // Follow the DSH interface language (optional locale service). Hosts without it keep English.
    const messages = {
      en: {
        'error.unauthorized': 'Your login has expired. Sign in again, then reload this page.',
        'error.forbidden': 'This account does not have permission. Sign in with an authorized account, then reload this page.',
        'error.storage_reload_required': 'Storage protection has stopped writes. Stop other writers, inspect both storage files, then reload the plugin.',
        'error.runtime_reload_required': 'The last write outcome is unknown. Inspect memory and pending changes, then reload the plugin.',
        'error.storage_unavailable': 'Storage is temporarily unavailable. Retry loading later.',
        'error.auth_service_unavailable': 'The authentication service is temporarily unavailable. Retry loading later.',
        errorWithDetail: '{label} ({detail})',
        invalidStats: 'Invalid memory statistics response',
        storeNotReady: 'Memory store not ready',
        storageUnavailable: 'Storage unavailable · writes paused. Retry loading later.',
        storageBlocked: 'Storage protection triggered · writes paused. Inspect both storage files, then reload the plugin.',
        storageGuardedNative: 'Native storage protection · writer lease and external change checks enabled.',
        storageHostJson: 'Host JSON storage · no cross-process writer lock or external change checks. Use one writer per storage directory.',
        storageUnknown: 'Storage protection status is unavailable from this host. Use one writer per storage directory.',
        title: '🧠 Hermes Memory',
        error: 'Error: {error}',
        loading: 'Loading…',
        bankCount: ({ icon, file, count, usage }) => `${icon} ${file} ${count} ${count === 1 ? 'entry' : 'entries'} · ${usage}`,
        recent: 'Recent:',
        retry: '↻ Retry',
        refresh: '↻ Refresh',
      },
      zh: {
        'error.unauthorized': '登录已过期，请重新登录后刷新页面。',
        'error.forbidden': '当前账号没有操作权限，请使用有权限的账号重新登录后刷新页面。',
        'error.storage_reload_required': '存储保护已停止写入。请停止其他写入并检查两个存储文件，然后重新加载插件。',
        'error.runtime_reload_required': '上次写入结果不明。请核对记忆和待审记录后重新加载插件。',
        'error.storage_unavailable': '存储暂不可用，请稍后重试载入。',
        'error.auth_service_unavailable': '登录验证服务暂不可用，请稍后重试载入。',
        errorWithDetail: '{label}（{detail}）',
        invalidStats: '记忆统计响应无效',
        storeNotReady: '记忆存储尚未就绪',
        storageUnavailable: '存储暂不可用 · 写入已暂停，请稍后重试载入。',
        storageBlocked: '存储保护已触发 · 写入已暂停。请检查两个存储文件，然后重新加载插件。',
        storageGuardedNative: '原生存储保护 · 已启用单写入者租约和外部变更检查。',
        storageHostJson: '宿主 JSON 存储 · 不提供跨进程写锁或外部变更检查。每个存储目录只使用一个写入者。',
        storageUnknown: '当前宿主未提供存储保护状态。每个存储目录只使用一个写入者。',
        title: '🧠 Hermes 记忆',
        error: '错误：{error}',
        loading: '载入中…',
        bankCount: '{icon} {file} {count} 条 · {usage}',
        recent: '最近：',
        retry: '↻ 重试',
        refresh: '↻ 刷新',
      },
    }
    let lang = 'en'
    const langListeners = new Set()
    const setLang = next => {
      if (next === lang) return
      lang = next
      for (const fn of langListeners) fn(next)
    }
    const hasMessage = key => Object.hasOwn(messages.en, key)
    const t = (key, params) => {
      const value = Object.hasOwn(messages[lang], key) ? messages[lang][key] : messages.en[key]
      if (typeof value === 'function') return value(params || {})
      if (!params) return value
      return value.replace(/\{(\w+)\}/g, (match, name) => params[name] === undefined ? match : String(params[name]))
    }
    const panelLang = active => typeof active !== 'string' || !active ? undefined : /^zh(?:[-_]|$)/i.test(active) ? 'zh' : 'en'
    const attachLocale = (locale, effect) => {
      if (!locale || typeof locale.getLocale !== 'function') return
      const sync = () => {
        const next = panelLang(locale.getLocale()?.active)
        if (next) setLang(next)
      }
      sync()
      if (typeof locale.subscribe === 'function') effect(() => locale.subscribe(sync))
    }
    // Optional dependency: not declared in inject, so hosts without a locale service still load the card.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['locale'], sub => attachLocale(sub.get('locale'), fn => sub.effect(fn, 'hermes-memory: locale')))
    } else {
      attachLocale(ctx.get('locale'), fn => ctx.effect(fn, 'hermes-memory: locale'))
    }
    const blockedSafety = safety => !!safety?.state && safety.state !== 'open'
    const terminal = error => ['unauthorized', 'forbidden', 'storage_reload_required', 'runtime_reload_required'].includes(error?.code)
      || (blockedSafety(error?.storageSafety) && error.storageSafety.state !== 'unavailable')
    const failure = value => {
      const error = new Error(typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message || t('storeNotReady'))
      error.status = value?.status
      error.code = error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : value?.code
      error.storageSafety = value?.storageSafety
      error.retryable = value?.retryable
      return error
    }
    const describe = error => typeof error?.code === 'string' && hasMessage(`error.${error.code}`)
      ? t('errorWithDetail', { label: t(`error.${error.code}`), detail: error.message }) : String(error?.message || error)
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => {
        const [, setShownLang] = React.useState(lang)
        React.useEffect(() => {
          langListeners.add(setShownLang)
          return () => langListeners.delete(setShownLang)
        }, [])
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
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('invalidStats'))
            observeSafety(value.storageSafety)
            if (value.ready !== true || value.success === false) throw failure(value)
            const validBank = (bank) => bank && Number.isInteger(bank.entries) && bank.entries >= 0 && typeof bank.usage === 'string'
            if (!validBank(value.memory) || !validBank(value.user)
              || (value.file !== undefined && typeof value.file !== 'string')
              || (value.recent !== undefined && (!Array.isArray(value.recent) || value.recent.some((row) => !row
                || (row.bank !== 'memory' && row.bank !== 'user') || typeof row.text !== 'string')))) {
              throw new Error(t('invalidStats'))
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
          React.createElement('div', { key: 'title', style: { fontWeight: 600 } }, t('title')),
        ]
        const storageText = blockedSafety(safety)
          ? safety.state === 'unavailable' ? t('storageUnavailable') : t('storageBlocked')
          : safety?.mode === 'guarded-native' ? t('storageGuardedNative')
            : safety?.mode === 'host-json' ? t('storageHostJson')
              : t('storageUnknown')
        children.push(React.createElement('div', { key: 'safety', role: 'status', style: { marginTop: 6 } }, storageText,
          safety?.error && React.createElement('div', null, typeof safety.error === 'string' ? safety.error : safety.error.message),
        ))
        if (error) {
          children.push(React.createElement('div', { key: 'err', role: 'alert', style: { color: '#e5484d' } }, t('error', { error: describe(error) })))
        }
        if (loading) {
          children.push(React.createElement('div', { key: 'load', role: 'status', style: { opacity: 0.7 } }, t('loading')))
        }
        if (stats !== null) {
          children.push(React.createElement('div', { key: 'counts', style: row },
            React.createElement('span', { style: chip }, t('bankCount', { icon: '📝', file: 'MEMORY.md', count: stats.memory.entries, usage: stats.memory.usage })),
            React.createElement('span', { style: chip }, t('bankCount', { icon: '👤', file: 'USER.md', count: stats.user.entries, usage: stats.user.usage })),
          ))
          if (stats.recent && stats.recent.length) {
            const recents = stats.recent.map((r) => React.createElement('div', {
              key: `${r.bank}-${r.updatedAt}-${r.text.slice(0, 12)}`,
              style: { wordBreak: 'normal', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
            }, `${r.bank === 'memory' ? '📝' : '👤'} ${r.text}`))
            children.push(React.createElement('div', { key: 'recent', style: { marginTop: 6 } },
              React.createElement('div', { style: { opacity: 0.7 } }, t('recent')),
              ...recents,
            ))
          }
          children.push(React.createElement('div', { key: 'file', style: { ...mono, marginTop: 6 } }, stats.file))
        }
        if (!terminalFailure.current && error?.retryable !== false) children.push(React.createElement('button', {
          key: 'btn', style: btn, onClick: () => { void load() }, disabled: loading,
        }, error ? t('retry') : t('refresh')))
        return React.createElement('div', { style: card }, ...children)
      },
    ))
  },
}
