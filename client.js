/**
 * Hermes 式记忆管理 —— DSH 动态 Cordis 插件（Client 半边）
 *
 * 在最新 cordis_run 卡片内渲染记忆仪表盘：
 * MEMORY.md / USER.md 两个记忆库的条目数与字符用量 + 最近条目 + 存储文件位置 + 刷新按钮。
 * 数据通过 Package-private RPC（host.call('mem-stats')）从 Host 获取。
 */
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => {
        const [stats, setStats] = React.useState(null)
        const [error, setError] = React.useState(null)
        const load = () => {
          host.call('mem-stats', {})
            .then((v) => { setStats(v); setError(null) })
            .catch((e) => { setError(String((e && e.message) || e)) })
        }
        React.useEffect(() => { load() }, [])
        const card = {
          border: '1px solid var(--dsh-border, #444)',
          borderRadius: 8,
          padding: '10px 12px',
          margin: '8px 0',
          fontSize: 13,
          lineHeight: 1.5,
          fontFamily: 'inherit',
        }
        const row = { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }
        const chip = {
          background: 'var(--dsh-surface-2, rgba(128,128,128,.15))',
          borderRadius: 6,
          padding: '2px 8px',
        }
        const btn = {
          marginTop: 8,
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
        if (error) {
          children.push(React.createElement('div', { key: 'err', style: { color: '#e5484d' } }, `Error: ${error}`))
        } else if (stats === null) {
          children.push(React.createElement('div', { key: 'load', style: { opacity: 0.7 } }, 'Loading…'))
        } else if (stats.ready) {
          children.push(React.createElement('div', { key: 'counts', style: row },
            React.createElement('span', { style: chip }, `📝 MEMORY.md ${stats.memory.entries} entries · ${stats.memory.usage}`),
            React.createElement('span', { style: chip }, `👤 USER.md ${stats.user.entries} entries · ${stats.user.usage}`),
          ))
          if (stats.recent && stats.recent.length) {
            const recents = stats.recent.map((r) => React.createElement('div', {
              key: `${r.bank}-${r.updatedAt}-${r.text.slice(0, 12)}`,
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, `${r.bank === 'memory' ? '📝' : '👤'} ${r.text}`))
            children.push(React.createElement('div', { key: 'recent', style: { marginTop: 6 } },
              React.createElement('div', { style: { opacity: 0.7 } }, 'Recent:'),
              ...recents,
            ))
          }
          children.push(React.createElement('div', { key: 'file', style: { ...mono, marginTop: 6 } }, stats.file))
        } else {
          children.push(React.createElement('div', { key: 'nrdy', style: { color: '#e5484d' } }, `Not ready: ${stats.error}`))
        }
        children.push(React.createElement('button', { key: 'btn', style: btn, onClick: load }, '↻ Refresh'))
        return React.createElement('div', { style: card }, ...children)
      },
    ))
  },
}
