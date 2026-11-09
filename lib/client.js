/**
 * dsh-hermes-memory —— 记忆面板（浏览器半边）
 *
 * 功能：查看 MEMORY / USER 两个记忆库的全部条目，并可增、删、改。
 * 美学：吸收太极美学的气质 —— 黑白灰、大量留白、细线分割、克制动效；
 *       不照搬太极符号与意象（无阴阳鱼、无文言文案）。
 *
 * 挂载：侧边栏底部「记忆」入口（sidebar.footer.action）+ 浮层面板（shell.overlay）。
 * 数据：同源 fetch host 的 webServer 路由（/hermes-memory/stats、/hermes-memory/ops）。
 *
 * 格式：DSH client-modules 的 __ModuleLoader__ 格式（与官方 dsh-client-ui-* 产物一致）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hermes-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    // ---------------- 色彩与字体 ----------------
    const INK = '#1f1f1f'
    const SUB = '#6b6b6b'
    const FAINT = '#a3a3a3'
    const LINE = '#e6e3dc'
    const PAPER = '#fbfaf8'
    const FIELD = '#f3f1ec'
    const FONT = '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    const MONO = '"JetBrains Mono", "Cascadia Mono", monospace'

    // ---------------- 面板开关（跨 slot 共享） ----------------
    let visible = false
    const listeners = new Set()
    function setVisible(v) {
      visible = v
      for (const fn of listeners) fn(v)
    }
    function useVisible() {
      const [v, setV] = React.useState(visible)
      React.useEffect(() => {
        listeners.add(setV)
        return () => listeners.delete(setV)
      }, [])
      return [v, setV]
    }

    // ---------------- 数据 ----------------
    function errorText(error) {
      return String((error && error.message) || error)
    }
    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      let value
      try { value = await response.json() } catch {
        throw new Error(`服务器返回非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok) {
        throw new Error((value && (value.error || value.message)) || `HTTP ${response.status}`)
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('服务器返回无效响应')
      }
      if (value.success === false || value.ready === false) {
        throw new Error(value.error || value.message || '记忆存储尚未就绪')
      }
      return value
    }
    async function loadAll() {
      const value = await post('/hermes-memory/ops', { action: 'list' })
      if (!['memory', 'user'].every((bank) => Array.isArray(value[bank]) && value[bank].every((text) => typeof text === 'string'))
        || !value.usage || typeof value.usage !== 'object' || Array.isArray(value.usage)
        || !['memory', 'user'].every((bank) => value.usage[bank] === undefined || typeof value.usage[bank] === 'string')) {
        throw new Error('服务器返回无效记忆列表')
      }
      return value
    }

    // ---------------- 按钮样式 ----------------
    function rowActionStyle() {
      return {
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: FAINT,
        cursor: 'pointer',
        fontSize: 12,
        padding: '2px 4px',
        opacity: 0.55, // 常显（浅灰弱化），悬停行时加深
        transition: 'opacity .12s ease, color .12s ease',
      }
    }
    function btnStyle(ghost) {
      return {
        flex: 'none',
        border: `1px solid ${ghost ? LINE : INK}`,
        background: ghost ? 'transparent' : INK,
        color: ghost ? SUB : '#ffffff',
        cursor: 'pointer',
        fontSize: 12,
        padding: '5px 14px',
        letterSpacing: 2,
        transition: 'opacity .12s ease',
      }
    }

    // ---------------- 分区（顶层稳定组件，避免重挂载丢焦点） ----------------
    function Section(props) {
      const { title, bank, list, usage, editing, draft, busy,
        onDraft, onAdd, onEdit, onSave, onCancel, onRemove } = props
      return React.createElement('div', { style: { marginTop: 26 } },
        // 分区头
        React.createElement('div', {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            paddingBottom: 8,
            borderBottom: `1px solid ${INK}`,
          },
        },
          React.createElement('span', { style: { fontSize: 14, letterSpacing: 3, color: INK } }, title),
          React.createElement('span', { style: { fontSize: 11, color: FAINT, fontFamily: MONO } }, usage || ''),
          React.createElement('span', { style: { fontSize: 11, color: FAINT, marginLeft: 'auto' } }, `${list.length} 条`),
        ),
        // 条目
        (list.length === 0
          ? React.createElement('div', { style: { color: FAINT, fontSize: 12, padding: '16px 0' } }, '暂无条目')
          : list.map((text, i) => {
              const isEditing = editing && editing.bank === bank && editing.index === i
              return React.createElement('div', {
                key: i,
                className: 'hm-row',
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 0',
                  borderBottom: `1px solid ${LINE}`,
                },
              },
                isEditing
                  ? React.createElement(React.Fragment, null,
                      React.createElement('textarea', {
                        value: editing.text,
                        disabled: busy,
                        onChange: (e) => onEdit({ ...editing, text: e.target.value }),
                        rows: 2,
                        style: {
                          flex: 1,
                          border: `1px solid ${SUB}`,
                          background: FIELD,
                          outline: 'none',
                          padding: 6,
                          fontSize: 13,
                          lineHeight: 1.6,
                          fontFamily: FONT,
                          color: INK,
                          resize: 'vertical',
                        },
                      }),
                      React.createElement('button', { onClick: onSave, disabled: busy, style: btnStyle(false) }, '保存'),
                      React.createElement('button', { onClick: onCancel, disabled: busy, style: btnStyle(true) }, '取消'),
                    )
                  : React.createElement(React.Fragment, null,
                      React.createElement('span', {
                        style: { flex: 1, fontSize: 13.5, lineHeight: 1.7, color: INK, wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
                      }, String(text)),
                      React.createElement('button', {
                        className: 'hm-action',
                        onClick: () => onEdit({ bank, index: i, text: String(text), original: String(text) }),
                        disabled: busy,
                        style: rowActionStyle(),
                      }, '编辑'),
                      React.createElement('button', {
                        className: 'hm-action',
                        onClick: () => onRemove(bank, String(text)),
                        disabled: busy,
                        style: rowActionStyle(),
                      }, '删除'),
                    ),
              )
            })
        ),
        // 添加
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          React.createElement('input', {
            value: draft,
            disabled: busy,
            onChange: (e) => onDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !busy && !e.isComposing && !e.nativeEvent?.isComposing) onAdd() },
            placeholder: '新条目 ……',
            style: {
              flex: 1,
              border: 'none',
              borderBottom: `1px solid ${SUB}`,
              background: 'transparent',
              outline: 'none',
              padding: '6px 2px',
              fontSize: 13,
              fontFamily: FONT,
              color: INK,
            },
          }),
          React.createElement('button', {
            onClick: onAdd,
            disabled: busy || !draft.trim(),
            style: btnStyle(false),
          }, '添加'),
        ),
      )
    }

    // ---------------- 侧边栏入口 ----------------
    function SidebarEntry() {
      const [v] = useVisible()
      return React.createElement('button', {
        onClick: () => setVisible(!v),
        title: '记忆',
        style: {
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: '4px 2px',
          color: v ? INK : FAINT,
          fontFamily: FONT,
          fontSize: 13,
          letterSpacing: 4,
          transition: 'color .15s ease',
        },
      }, '记忆')
    }

    // ---------------- 面板 ----------------
    function Panel() {
      const [v] = useVisible()
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [drafts, setDrafts] = React.useState({ memory: '', user: '' })
      const [loading, setLoading] = React.useState(false)
      const loadEpoch = React.useRef(0)
      const mounted = React.useRef(true)
      const writeLock = React.useRef(false)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; loadEpoch.current += 1 }
      }, [])

      // 只接收最后一次载入；关闭/卸载会作废尚未完成的请求。
      const refresh = async (savedText = '') => {
        const epoch = ++loadEpoch.current
        setLoading(true)
        if (!savedText) setNotice(null)
        try {
          const next = await loadAll()
          if (!mounted.current || epoch !== loadEpoch.current) return
          setData(next)
          if (!savedText) setNotice(null)
        } catch (error) {
          if (!mounted.current || epoch !== loadEpoch.current) return
          setNotice({ ok: false, text: `${savedText ? savedText + '；重新' : ''}载入失败（${errorText(error)}），请重试载入` })
        } finally {
          if (mounted.current && epoch === loadEpoch.current) setLoading(false)
        }
      }
      React.useEffect(() => {
        if (v) void refresh()
        return () => { loadEpoch.current += 1 }
      }, [v])

      const act = async (fn, okText, onSuccess) => {
        // 键盘 Enter 和同一渲染内的重复点击也必须经过写锁。
        if (writeLock.current || loading || data === null) return
        writeLock.current = true
        loadEpoch.current += 1
        setBusy(true)
        try {
          const out = await fn()
          if (!out || out.success !== true) throw new Error((out && (out.error || out.message)) || '操作失败')
          if (!mounted.current) return
          if (onSuccess) onSuccess()
          setNotice({ ok: true, text: okText })
          if (visible) await refresh(okText)
        } catch (error) {
          if (mounted.current) setNotice({ ok: false, text: errorText(error) })
        } finally {
          writeLock.current = false
          if (mounted.current) setBusy(false)
        }
      }
      if (!v) return null

      const addEntry = (bank) => {
        const draft = drafts[bank]
        const content = draft.trim()
        if (!content) return
        void act(() => post('/hermes-memory/ops', { action: 'add', bank, content }), '已添加', () => {
          setDrafts((d) => d[bank] === draft ? { ...d, [bank]: '' } : d)
        })
      }
      const saveEdit = () => {
        const e = editing
        if (!e) return
        const content = e.text.trim()
        if (!content || !e.original) return
        if (content === e.original) { setEditing(null); return }
        void act(() => post('/hermes-memory/ops', { action: 'replace', bank: e.bank, oldText: e.original, content }), '已保存', () => {
          setEditing((current) => current === e ? null : current)
        })
      }
      const removeEntry = (bank, text) => {
        void act(() => post('/hermes-memory/ops', { action: 'remove', bank, oldText: text }), '已删除')
      }

      // null 表示尚未成功载入，不能把它伪装成两个已确认的空库。
      const memList = data === null ? [] : data.memory
      const userList = data === null ? [] : data.user
      const usage = data === null ? {} : data.usage
      const controlsBusy = busy || loading || data === null

      return React.createElement('div', {
        onClick: (e) => { if (e.target === e.currentTarget) setVisible(false) },
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9000,
          background: 'rgba(15,15,13,.32)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: FONT,
        },
      },
        React.createElement('div', {
          style: {
            width: 720,
            maxWidth: '94vw',
            maxHeight: '86vh',
            overflowY: 'auto',
            background: PAPER,
            border: `1px solid ${INK}`,
            boxShadow: '0 20px 60px rgba(15,15,13,.25)',
            padding: '30px 36px 24px',
          },
        },
          // 头
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline' } },
            React.createElement('span', { style: { fontSize: 18, letterSpacing: 6, color: INK } }, '记忆'),
            React.createElement('span', { style: { marginLeft: 12, fontSize: 11, color: FAINT, fontFamily: MONO } }, 'MEMORY / USER'),
            React.createElement('button', {
              onClick: () => setVisible(false),
              style: { marginLeft: 'auto', border: 'none', background: 'transparent', color: FAINT, cursor: 'pointer', fontSize: 16, padding: '2px 6px' },
            }, '×'),
          ),
          data === null && React.createElement('div', {
            role: 'status', style: { color: SUB, fontSize: 12, paddingTop: 24 },
          }, loading ? '载入中 ……' : '记忆尚未载入，请重试'),
          // 仅成功响应可以显示“暂无条目”；失败时保留上次成功快照。
          data !== null && React.createElement(Section, {
            title: 'MEMORY', bank: 'memory',
            list: memList, usage: usage.memory || '',
            editing, draft: drafts.memory, busy: controlsBusy,
            onDraft: (t) => setDrafts((d) => ({ ...d, memory: t })),
            onAdd: () => addEntry('memory'),
            onEdit: setEditing, onSave: saveEdit, onCancel: () => setEditing(null),
            onRemove: removeEntry,
          }),
          // USER 分区
          data !== null && React.createElement(Section, {
            title: 'USER', bank: 'user',
            list: userList, usage: usage.user || '',
            editing, draft: drafts.user, busy: controlsBusy,
            onDraft: (t) => setDrafts((d) => ({ ...d, user: t })),
            onAdd: () => addEntry('user'),
            onEdit: setEditing, onSave: saveEdit, onCancel: () => setEditing(null),
            onRemove: removeEntry,
          }),
          // 状态行
          React.createElement('div', {
            style: {
              marginTop: 22,
              paddingTop: 10,
              borderTop: `1px solid ${LINE}`,
              minHeight: 16,
              fontSize: 11.5,
              color: notice ? (notice.ok ? SUB : '#b33a2e') : FAINT,
              letterSpacing: 1,
            },
          },
            React.createElement('span', { role: 'status', 'aria-live': 'polite' }, notice ? notice.text : (busy ? '处理中 ……' : loading ? '载入中 ……' : '')),
            React.createElement('button', {
              onClick: () => { void refresh() }, disabled: busy || loading,
              style: { ...btnStyle(true), marginLeft: 12 },
            }, notice && !notice.ok ? '重试载入' : '刷新'),
          ),
        ),
      )
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 条目操作按钮：悬停行时显示
      const cssId = 'dsh-hermes-memory-row-actions'
      ctx.effect(() => {
        // 接管旧版遗留的同名样式，使 targeted reload 后也能正确回收。
        const st = document.getElementById(cssId) || document.createElement('style')
        st.id = cssId
        st.textContent = `
          .hm-row:hover .hm-action { opacity: 1 !important; color: #6b6b6b !important; }
          .hm-row .hm-action:hover { color: #1f1f1f !important; }
        `
        document.head.appendChild(st)
        return () => st.remove()
      }, 'hermes-memory: styles')
      // 挂载门控：slot 由别的插件（sidebar / ui-layout）声明，本插件的 apply
      // 时序早于它们，直接 register 会抛
      //   slot "sidebar.footer.action" is not declared
      // 官方标准写法是 slots.inject(slot, () => slots.register(...))：
      // 声明已存在时同步执行，否则等声明提交后再执行。
      if (typeof slots.inject === 'function') {
        slots.inject('sidebar.footer.action', () =>
          slots.register({ name: 'sidebar.footer.action', id: 'hermes-memory' }, SidebarEntry))
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'hermes-memory-panel' }, Panel))
      } else {
        // 兜底：老运行时没有 inject 门控，退回直接 register
        ctx.effect(() => {
          const offEntry = slots.register({ name: 'sidebar.footer.action', id: 'hermes-memory' }, SidebarEntry)
          const offPanel = slots.register({ name: 'shell.overlay', id: 'hermes-memory-panel' }, Panel)
          return () => { offEntry(); offPanel() }
        }, 'hermes-memory: slots')
      }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
