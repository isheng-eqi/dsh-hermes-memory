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
      return String((error && error.message) || error || '未知错误')
    }
    const errorLabels = {
      unauthorized: '登录已过期，请重新登录后刷新页面',
      forbidden: '当前账号没有操作权限，请使用有权限的账号重新登录后刷新页面',
      storage_reload_required: '存储保护已触发，写入已暂停。请停止其他写入并检查存储文件，处理后重新加载插件',
      runtime_reload_required: '上次写入结果不明，写入已暂停。请核对记忆和待审记录后重新加载插件',
      storage_unavailable: '存储暂不可用，请稍后重试载入',
      auth_service_unavailable: '登录验证服务暂不可用，请稍后重试载入',
      row_conflict: '条目已变化、被重建或版本已过期，请核对最新列表后重新开始编辑',
      validation_failed: '内容未通过校验，请修改内容后再提交',
    }
    function requestError(value, status, fallback) {
      const error = new Error(typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message || fallback || `HTTP ${status}`)
      error.status = status ?? value?.status
      error.code = error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden'
        : value?.code || (value?.conflict || error.status === 409 ? 'row_conflict' : undefined)
      error.storageSafety = value?.storageSafety
      error.retryable = value?.retryable
      return error
    }
    function describeError(error) {
      const label = errorLabels[error?.code]
      const detail = errorText(error)
      return label ? `${label}（${detail}）` : detail
    }
    function safetyBlocked(safety) {
      return !!safety?.state && safety.state !== 'open'
    }
    function terminalError(error) {
      return ['unauthorized', 'forbidden', 'storage_reload_required', 'runtime_reload_required'].includes(error?.code)
        || (safetyBlocked(error?.storageSafety) && error.storageSafety.state !== 'unavailable')
    }
    function retryAllowed(error) {
      return !terminalError(error) && error?.retryable !== false
    }
    function storageMessage(safety) {
      if (safetyBlocked(safety)) return safety.state === 'unavailable'
        ? '存储暂不可用 · 写入已暂停，可稍后重新载入。草稿与上次成功列表已保留。'
        : '存储保护已触发 · 写入已暂停。请停止其他写入并检查存储文件，核对结果后重新加载插件。草稿与上次成功列表已保留。'
      if (safety?.mode === 'guarded-native') return '存储保护 · 原生保护已启用（单写入者租约、外部变更检查）。'
      if (safety?.mode === 'host-json') return '存储保护 · 宿主 JSON 模式，不提供跨进程写锁或外部变更检查。请勿让多个进程共用此存储目录。'
      return '存储保护 · 当前宿主未提供保护状态，请确认只有一个进程使用此存储目录。'
    }
    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // Authentication failures remain actionable even when an upstream proxy
      // returns HTML or an empty body rather than the plugin's JSON envelope.
      const authCode = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : undefined
      let value
      try { value = await response.json() } catch {
        throw requestError({ code: authCode }, response.status, authCode ? `HTTP ${response.status}` : `服务器返回非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || authCode) throw requestError(value, response.status)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw requestError({}, response.status, '服务器返回无效响应')
      }
      if (value.success === false || value.ready === false) {
        throw requestError(value, response.status, '记忆存储尚未就绪')
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
      if (value.entryVersions !== undefined && (!value.entryVersions || typeof value.entryVersions !== 'object'
        || !['memory', 'user'].every(bank => Array.isArray(value.entryVersions[bank])
          && value.entryVersions[bank].length === value[bank].length
          && value.entryVersions[bank].every(version => typeof version === 'string' && version.length > 0 && version.length <= 128)))) {
        throw new Error('服务器返回无效记忆版本')
      }
      if (value.pending !== undefined && (!Array.isArray(value.pending) || value.pending.some((item) => !item
        || typeof item.id !== 'string' || !['memory', 'user'].includes(item.target) || !Array.isArray(item.operations)))) {
        throw new Error('服务器返回无效待审记忆')
      }
      return value
    }

    // ---------------- 按钮样式 ----------------
    function rowActionStyle() {
      return {
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: SUB,
        cursor: 'pointer',
        fontSize: 12,
        minWidth: 24,
        minHeight: 24,
        padding: '2px 4px',
        opacity: 1,
        transition: 'color .12s ease',
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

    function entryExcerpt(text) {
      const points = Array.from(String(text).replace(/\s+/g, ' ').trim())
      return points.slice(0, 32).join('') + (points.length > 32 ? '…' : '')
    }
    function editForm(editing, busy, writesBlocked, error, onEdit, onSave, onCancel, onCopy, copyNotice, stale) {
      const conflicted = stale || editing.conflicted || error?.code === 'row_conflict'
      return React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' } },
          React.createElement('textarea', {
            value: editing.text,
            disabled: busy,
            'aria-label': '编辑记忆草稿',
            'aria-invalid': !!error || !!conflicted,
            onChange: (e) => onEdit({ ...editing, text: e.target.value }),
            rows: 2,
            style: {
              flex: 1, minWidth: 0, border: `1px solid ${SUB}`, background: FIELD,
              padding: 6, fontSize: 13, lineHeight: 1.6, wordBreak: 'normal', overflowWrap: 'anywhere',
              fontFamily: FONT, color: INK, resize: 'vertical',
            },
          }),
          React.createElement('button', { onClick: onSave, disabled: busy || writesBlocked || !!conflicted || !editing.text.trim(), style: btnStyle(false) }, '保存'),
          React.createElement('button', { onClick: onCancel, disabled: busy, style: btnStyle(true) }, '取消'),
        ),
        error && React.createElement('div', { role: 'alert', style: { color: '#b33a2e', fontSize: 12, paddingTop: 6, overflowWrap: 'anywhere' } }, `保存失败：${describeError(error)}。草稿已保留。`),
        conflicted && React.createElement('div', { role: 'status', style: { color: SUB, fontSize: 12, lineHeight: 1.7, paddingTop: 6 } },
          '此草稿的原条目已过期，保存已停用。请复制草稿后取消编辑，刷新列表，再选择当前条目重新编辑并核对内容。',
          React.createElement('button', { onClick: onCopy, disabled: busy, style: { ...btnStyle(true), marginLeft: 8 } }, '复制草稿'),
          copyNotice && React.createElement('div', null, copyNotice),
        ),
      )
    }

    // ---------------- 分区（顶层稳定组件，避免重挂载丢焦点） ----------------
    function Section(props) {
      const { title, bank, list, versions, usage, editing, editError, deleting, deleteError, draft, busy, writesBlocked,
        onDraft, onAdd, onEdit, onSave, onCancel, onCopy, copyNotice, onRemove, onConfirmRemove, onCancelRemove } = props
      const ownEdit = editing && editing.bank === bank
      const editingIndex = ownEdit ? list.findIndex((text, index) => text === editing.original
        && (editing.expectedVersion === undefined || versions?.[index] === editing.expectedVersion)) : -1
      const ownDelete = deleting && deleting.bank === bank
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
              const isEditing = ownEdit && editingIndex === i
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
                  ? editForm(editing, busy, writesBlocked, editError, onEdit, onSave, onCancel, onCopy, copyNotice, editingIndex === -1)
                  : React.createElement(React.Fragment, null,
                      React.createElement('span', {
                        style: { flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 1.7, color: INK, wordBreak: 'normal', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
                      }, String(text)),
                      React.createElement('button', {
                        className: 'hm-action',
                        'aria-label': `编辑 ${title} 第 ${i + 1} 条：${entryExcerpt(text)}`,
                        onClick: () => onEdit({ bank, index: i, text: String(text), original: String(text) }),
                        disabled: busy || writesBlocked || !!editing || !!deleting,
                        style: rowActionStyle(),
                      }, '编辑'),
                      React.createElement('button', {
                        className: 'hm-action',
                        'aria-label': `删除 ${title} 第 ${i + 1} 条：${entryExcerpt(text)}`,
                        onClick: () => onRemove(bank, String(text), i),
                        disabled: busy || writesBlocked || !!editing || !!deleting,
                        style: rowActionStyle(),
                      }, '删除'),
                    ),
              )
            })
        ),
        ownEdit && editingIndex === -1 && React.createElement('div', { style: { padding: '12px 0' } },
          React.createElement('div', { role: 'status', style: { color: SUB, fontSize: 12, paddingBottom: 8 } }, '原条目已变化或被删除，草稿已保留。请核对后取消或复制草稿。'),
          editForm(editing, busy, writesBlocked, editError, onEdit, onSave, onCancel, onCopy, copyNotice, editingIndex === -1),
        ),
        ownDelete && React.createElement('div', { style: { border: `1px solid ${LINE}`, padding: 12, marginTop: 10 } },
          React.createElement('div', { style: { color: INK, fontSize: 12 } }, '确认删除以下记忆？'),
          React.createElement('div', { style: { color: SUB, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '8px 0' } }, deleting.text),
          deleteError && React.createElement('div', { role: 'alert', style: { color: '#b33a2e', fontSize: 12, marginBottom: 8 } }, `删除失败：${describeError(deleteError)}`),
          (deleting.conflicted || deleteError?.code === 'row_conflict') && React.createElement('div', { role: 'status', style: { color: SUB, fontSize: 12, marginBottom: 8 } }, '此删除目标已过期，重复删除已停用。请取消删除并刷新列表，再选择当前条目。'),
          React.createElement('button', { onClick: onConfirmRemove, disabled: busy || writesBlocked || !!deleting.conflicted || deleteError?.code === 'row_conflict', style: btnStyle(false) }, '确认删除'),
          React.createElement('button', { onClick: onCancelRemove, disabled: busy, style: { ...btnStyle(true), marginLeft: 8 } }, '取消删除'),
        ),
        // 添加
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          React.createElement('input', {
            value: draft,
            disabled: busy,
            'aria-label': `添加 ${title} 记忆条目`,
            onChange: (e) => onDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !busy && !writesBlocked && !e.isComposing && !e.nativeEvent?.isComposing) onAdd() },
            placeholder: '新条目 ……',
            style: {
              flex: 1,
              border: 'none',
              borderBottom: `1px solid ${SUB}`,
              background: 'transparent',
              minWidth: 0,
              padding: '6px 2px',
              fontSize: 13,
              fontFamily: FONT,
              color: INK,
            },
          }),
          React.createElement('button', {
            onClick: onAdd,
            disabled: busy || writesBlocked || !draft.trim(),
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
        className: 'hm-entry',
        'aria-label': '打开记忆面板',
        'aria-haspopup': 'dialog',
        'aria-expanded': v,
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
      const [editError, setEditError] = React.useState(null)
      const [deleting, setDeleting] = React.useState(null)
      const [deleteError, setDeleteError] = React.useState(null)
      const [compactConfirm, setCompactConfirm] = React.useState(false)
      const [drafts, setDrafts] = React.useState({ memory: '', user: '' })
      const [loading, setLoading] = React.useState(false)
      const [safety, setSafety] = React.useState(null)
      const [blocked, setBlocked] = React.useState(null)
      const [copyNotice, setCopyNotice] = React.useState(null)
      const loadEpoch = React.useRef(0)
      const mounted = React.useRef(true)
      const writeLock = React.useRef(false)
      const activeEdit = React.useRef(null)
      const activeDelete = React.useRef(null)
      const blockedRef = React.useRef(null)
      const safetyRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const closeRef = React.useRef(null)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; loadEpoch.current += 1 }
      }, [])

      React.useEffect(() => {
        if (!v) return
        const opener = document.activeElement
        closeRef.current?.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setVisible(false)
          } else if (event.key === 'Tab') {
            const dialog = dialogRef.current
            const targets = Array.from(dialog?.querySelectorAll('button, input, textarea, select, a[href], [tabindex]') || [])
              .filter(node => !node.disabled && node.tabIndex >= 0 && !node.hidden && node.getAttribute('aria-hidden') !== 'true')
            const first = targets[0], last = targets[targets.length - 1]
            if (!first) { event.preventDefault(); dialog?.focus(); return }
            if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
              event.preventDefault()
              ;(event.shiftKey ? last : first).focus()
            }
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          if (opener?.isConnected !== false) opener?.focus?.()
        }
      }, [v])

      const observeSafety = (next) => {
        if (!next || typeof next !== 'object') return
        // A quarantined instance stays blocked until it is reloaded; a later
        // unrelated response must not make an uncertain write look safe.
        if (safetyRef.current && safetyBlocked(safetyRef.current) && safetyRef.current.state !== 'unavailable') return
        safetyRef.current = next
        setSafety(next)
      }
      const observeError = (error) => {
        observeSafety(error?.storageSafety)
        if (terminalError(error) || ['storage_unavailable', 'auth_service_unavailable'].includes(error?.code)) {
          if (!terminalError(blockedRef.current)) {
            blockedRef.current = error
            setBlocked(error)
          }
        }
      }
      const writesAreBlocked = () => !!blockedRef.current || safetyBlocked(safetyRef.current)
      const rowIsCurrent = (entry, snapshot, text) => !!snapshot?.[entry.bank]?.some((row, index) => row === text
        && (entry.expectedVersion === undefined || snapshot.entryVersions?.[entry.bank]?.[index] === entry.expectedVersion))
      const markStaleDrafts = (next) => {
        if (activeEdit.current && !rowIsCurrent(activeEdit.current, next, activeEdit.current.original)) {
          activeEdit.current = { ...activeEdit.current, conflicted: true }
          setEditing(activeEdit.current)
        }
        if (activeDelete.current && !rowIsCurrent(activeDelete.current, next, activeDelete.current.text)) {
          activeDelete.current = { ...activeDelete.current, conflicted: true }
          setDeleting(activeDelete.current)
        }
      }

      // 只接收最后一次载入；关闭/卸载会作废尚未完成的请求。
      const refresh = async (savedText = '') => {
        if (terminalError(blockedRef.current)) return
        const epoch = ++loadEpoch.current
        setLoading(true)
        if (!savedText) setNotice(null)
        try {
          const next = await loadAll()
          if (!mounted.current || epoch !== loadEpoch.current) return
          observeSafety(next.storageSafety)
          markStaleDrafts(next)
          setData(next)
          if (blockedRef.current && !terminalError(blockedRef.current) && !safetyBlocked(next.storageSafety)) {
            blockedRef.current = null
            setBlocked(null)
          }
          if (!savedText) setNotice(null)
        } catch (error) {
          if (!mounted.current || epoch !== loadEpoch.current) return
          observeError(error)
          setNotice({ ok: false, loadError: true, error, text: `${savedText ? savedText + '；重新' : ''}载入失败（${describeError(error)}）${retryAllowed(error) ? '，可重试载入' : ''}` })
        } finally {
          if (mounted.current && epoch === loadEpoch.current) setLoading(false)
        }
      }
      React.useEffect(() => {
        if (v) void refresh()
        return () => { loadEpoch.current += 1 }
      }, [v])

      const act = async (fn, okText, onSuccess, onError) => {
        // 键盘 Enter 和同一渲染内的重复点击也必须经过写锁。
        if (writeLock.current || loading || data === null || writesAreBlocked()) return
        writeLock.current = true
        loadEpoch.current += 1
        setBusy(true)
        try {
          const out = await fn()
          if (!out || out.success !== true) throw requestError(out, undefined, '操作失败')
          if (!mounted.current) return
          observeSafety(out.storageSafety)
          if (onSuccess) onSuccess()
          setNotice({ ok: true, text: okText })
          if (visible) await refresh(okText)
        } catch (error) {
          if (mounted.current) {
            observeError(error)
            if (onError) onError(error)
            else setNotice({ ok: false, error, text: describeError(error) })
          }
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
      const cancelEdit = () => {
        if (writeLock.current || loading) return
        activeEdit.current = null
        setEditing(null)
        setEditError(null)
        setCopyNotice(null)
      }
      const copyDraft = async () => {
        const entry = activeEdit.current
        if (!entry || writeLock.current) return
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
          await navigator.clipboard.writeText(entry.text)
          if (mounted.current && activeEdit.current === entry) setCopyNotice('草稿已复制。请点击取消，刷新列表，再选择当前条目重新编辑。')
        } catch {
          if (mounted.current && activeEdit.current === entry) setCopyNotice('自动复制不可用，请在上方文本框中全选并复制草稿，再取消编辑。')
        }
      }
      const editEntry = (next) => {
        if (writeLock.current || loading || activeDelete.current) return
        if (!activeEdit.current && writesAreBlocked()) return
        const current = activeEdit.current
        if (current && (current.bank !== next.bank || current.original !== next.original || current.index !== next.index)) return
        // Capture once. Refreshing while a draft is open must not bless that
        // old draft with the replacement row's fresh version.
        next = { ...next, conflicted: current?.conflicted || false,
          expectedVersion: current ? current.expectedVersion : data?.entryVersions?.[next.bank]?.[next.index] }
        activeEdit.current = next
        setEditing(next)
        setEditError(null)
      }
      const saveEdit = () => {
        const e = activeEdit.current
        if (!e || writeLock.current || loading || writesAreBlocked() || e.conflicted) return
        if (!rowIsCurrent(e, data, e.original)) {
          activeEdit.current = { ...e, conflicted: true }
          setEditing(activeEdit.current)
          return
        }
        const content = e.text.trim()
        if (!content || !e.original) return
        if (content === e.original) { cancelEdit(); return }
        setEditError(null)
        void act(() => post('/hermes-memory/ops', { action: 'replace', bank: e.bank, oldText: e.original, content, expectedVersion: e.expectedVersion }), '已保存', () => {
          activeEdit.current = null
          setEditing(null)
          setEditError(null)
        }, (error) => {
          if (error.code === 'row_conflict' && activeEdit.current) {
            activeEdit.current = { ...activeEdit.current, conflicted: true }
            setEditing(activeEdit.current)
          }
          setEditError(error)
        })
      }
      const removeEntry = (bank, text, index = data?.[bank]?.indexOf(text)) => {
        if (writeLock.current || loading || writesAreBlocked() || activeEdit.current || activeDelete.current) return
        const next = { bank, text, expectedVersion: data?.entryVersions?.[bank]?.[index] }
        activeDelete.current = next
        setDeleting(next)
        setDeleteError(null)
      }
      const cancelRemove = () => {
        if (writeLock.current || loading) return
        activeDelete.current = null
        setDeleting(null)
        setDeleteError(null)
      }
      const confirmRemove = () => {
        const entry = activeDelete.current
        if (!entry || writeLock.current || loading || writesAreBlocked() || entry.conflicted) return
        if (!rowIsCurrent(entry, data, entry.text)) {
          activeDelete.current = { ...entry, conflicted: true }
          setDeleting(activeDelete.current)
          return
        }
        setDeleteError(null)
        void act(() => post('/hermes-memory/ops', { action: 'remove', bank: entry.bank, oldText: entry.text, expectedVersion: entry.expectedVersion }), '已删除', () => {
          activeDelete.current = null
          setDeleting(null)
          setDeleteError(null)
        }, (error) => {
          if (error.code === 'row_conflict' && activeDelete.current) {
            activeDelete.current = { ...activeDelete.current, conflicted: true }
            setDeleting(activeDelete.current)
          }
          setDeleteError(error)
        })
      }

      // null 表示尚未成功载入，不能把它伪装成两个已确认的空库。
      const memList = data === null ? [] : data.memory
      const userList = data === null ? [] : data.user
      const usage = data === null ? {} : data.usage
      const pending = data && Array.isArray(data.pending) ? data.pending : []
      const review = data && data.backgroundReview
      const reviewLabels = { idle: '等待下一次复盘', running: '复盘中', completed: '最近复盘已完成', disabled: '已关闭', unavailable: '暂不可用', interrupted: '最近复盘已中断', failed: '最近复盘失败', error: '最近复盘失败', 'max-iterations': '最近复盘已达轮次上限' }
      const controlsBusy = busy || loading || data === null
      const writesBlocked = !!blocked || safetyBlocked(safety)
      const terminal = terminalError(blocked) || (safetyBlocked(safety) && safety.state !== 'unavailable')
      const canReload = !terminal && (!notice?.loadError || retryAllowed(notice.error))

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
          ref: dialogRef,
          className: 'hm-dialog',
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': 'hermes-memory-dialog-title',
          tabIndex: -1,
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
            React.createElement('span', { id: 'hermes-memory-dialog-title', style: { fontSize: 18, letterSpacing: 6, color: INK } }, '记忆'),
            React.createElement('span', { style: { marginLeft: 12, fontSize: 11, color: FAINT, fontFamily: MONO } }, 'MEMORY / USER'),
            React.createElement('button', {
              ref: closeRef,
              'aria-label': '关闭记忆面板',
              onClick: () => setVisible(false),
              style: { marginLeft: 'auto', border: 'none', background: 'transparent', color: SUB, cursor: 'pointer', fontSize: 16, minWidth: 24, minHeight: 24, padding: '2px 6px' },
            }, '×'),
          ),
          React.createElement('div', {
            role: 'status', 'aria-live': 'polite', 'data-storage-state': safety?.state || 'unknown',
            style: { color: writesBlocked ? '#b33a2e' : SUB, fontSize: 12, lineHeight: 1.7, marginTop: 20, padding: 10, border: `1px solid ${LINE}`, overflowWrap: 'anywhere' },
          },
            storageMessage(safety),
            safety?.error && React.createElement('div', null, `存储详情：${errorText(safety.error)}`),
            blocked && React.createElement('div', null, describeError(blocked)),
          ),
          data === null && React.createElement('div', {
            role: 'status', style: { color: SUB, fontSize: 12, paddingTop: 24 },
          }, loading ? '载入中 ……' : terminal ? '记忆尚未载入，请按上方提示恢复访问' : '记忆尚未载入，可重新载入'),
          // 仅成功响应可以显示“暂无条目”；失败时保留上次成功快照。
          data !== null && React.createElement(Section, {
            title: 'MEMORY', bank: 'memory',
            list: memList, versions: data.entryVersions?.memory, usage: usage.memory || '',
            editing, editError, deleting, deleteError, draft: drafts.memory, busy: controlsBusy, writesBlocked, copyNotice, onCopy: copyDraft,
            onDraft: (t) => setDrafts((d) => ({ ...d, memory: t })),
            onAdd: () => addEntry('memory'),
            onEdit: editEntry, onSave: saveEdit, onCancel: cancelEdit,
            onRemove: removeEntry, onConfirmRemove: confirmRemove, onCancelRemove: cancelRemove,
          }),
          // USER 分区
          data !== null && React.createElement(Section, {
            title: 'USER', bank: 'user',
            list: userList, versions: data.entryVersions?.user, usage: usage.user || '',
            editing, editError, deleting, deleteError, draft: drafts.user, busy: controlsBusy, writesBlocked, copyNotice, onCopy: copyDraft,
            onDraft: (t) => setDrafts((d) => ({ ...d, user: t })),
            onAdd: () => addEntry('user'),
            onEdit: editEntry, onSave: saveEdit, onCancel: cancelEdit,
            onRemove: removeEntry, onConfirmRemove: confirmRemove, onCancelRemove: cancelRemove,
          }),
          data !== null && review && React.createElement('div', {
            style: { color: SUB, fontSize: 12, paddingTop: 20, lineHeight: 1.7 },
          },
            React.createElement('div', null, review.enabled
              ? `后台复盘 · 每 ${review.interval} 轮用户对话 · ${reviewLabels[review.status] || review.status}`
              : '后台复盘 · 已关闭'),
            review.error && React.createElement('div', { role: 'status', style: { color: '#b33a2e', overflowWrap: 'anywhere' } },
              typeof review.error === 'string' ? review.error : review.error.message || '复盘暂不可用'),
          ),
          pending.length > 0 && React.createElement('div', {
            style: { marginTop: 20, borderTop: `1px solid ${LINE}`, paddingTop: 16 },
          },
            React.createElement('div', { style: { fontSize: 13, color: INK, marginBottom: 10 } }, `待审修改 · ${pending.length}`),
            React.createElement('div', { style: { fontSize: 12, color: SUB, marginBottom: 12 } }, '后台对旧记忆的修改会等待审核；批准前会再次确认原条目未变化。'),
            pending.map((item) => React.createElement('div', { key: item.id, style: { border: `1px solid ${LINE}`, padding: 12, marginBottom: 10, fontSize: 12 } },
              React.createElement('div', { style: { fontFamily: MONO, color: SUB, marginBottom: 8 } }, item.target.toUpperCase()),
              item.operations.map((op, index) => React.createElement('div', { key: index, style: { marginBottom: 8, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                React.createElement('strong', null, ({ add: '新增', patch: '修改', replace: '修改', remove: '删除' })[op.action] || op.action),
                (op.oldText || op.old_text) && React.createElement('div', { style: { color: SUB } }, `原文：${op.oldText || op.old_text}`),
                op.content !== undefined && React.createElement('div', { style: { color: INK } }, `新文：${op.content}`),
              )),
              React.createElement('button', {
                style: btnStyle(false), disabled: controlsBusy || writesBlocked,
                onClick: () => { void act(() => post('/hermes-memory/pending', { action: 'approve', id: item.id }), '已批准并保存') },
              }, '批准'),
              React.createElement('button', {
                style: { ...btnStyle(true), marginLeft: 8 }, disabled: controlsBusy || writesBlocked,
                onClick: () => { void act(() => post('/hermes-memory/pending', { action: 'discard', id: item.id }), '已丢弃待审修改') },
              }, '丢弃'),
            )),
          ),
          data !== null && React.createElement('div', {
            style: { marginTop: 20, paddingTop: 12, borderTop: `1px solid ${LINE}`, fontSize: 12, color: SUB },
          },
            React.createElement('a', {
              href: '/hermes-memory/export', download: 'hermes-memory-export.json',
              style: { color: INK, marginRight: 12 },
            }, '导出备份'),
            React.createElement('button', {
              disabled: controlsBusy || writesBlocked || !!editing || !!deleting,
              style: btnStyle(true), onClick: () => setCompactConfirm(true),
            }, '压缩历史详情'),
            compactConfirm && React.createElement('div', { role: 'group', 'aria-label': '确认压缩历史详情', style: { paddingTop: 10, lineHeight: 1.8 } },
              React.createElement('div', null, '建议先导出备份。仅压缩 30 天前已结束的历史详情，各保留最近 100 条；保留重放标记和待审、结果不明的完整记录。压缩后无法还原旧详情。'),
              React.createElement('button', {
                disabled: controlsBusy || writesBlocked, style: btnStyle(false),
                onClick: () => { void act(() => post('/hermes-memory/compact', { before: new Date(Date.now() - 30 * 86400000).toISOString(), maxDetailed: 100 }),
                  '历史详情已压缩，重放保护和未决记录已保留', () => setCompactConfirm(false)) },
              }, '确认压缩'),
              React.createElement('button', { disabled: controlsBusy, style: { ...btnStyle(true), marginLeft: 8 }, onClick: () => setCompactConfirm(false) }, '取消'),
            ),
          ),
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
            canReload && React.createElement('button', {
              onClick: () => { void refresh() }, disabled: busy || loading,
              style: { ...btnStyle(true), marginLeft: 12 },
            }, notice && notice.loadError ? '重试载入' : '刷新'),
          ),
        ),
      )
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 保持操作按钮可见，并为键盘焦点提供清晰轮廓。
      const cssId = 'dsh-hermes-memory-row-actions'
      ctx.effect(() => {
        // 接管旧版遗留的同名样式，使 targeted reload 后也能正确回收。
        const st = document.getElementById(cssId) || document.createElement('style')
        st.id = cssId
        st.textContent = `
          .hm-row .hm-action:hover { color: #1f1f1f !important; }
          .hm-dialog :focus-visible, .hm-dialog:focus-visible, .hm-entry:focus-visible { outline: 2px solid #1f1f1f; outline-offset: 3px; }
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
