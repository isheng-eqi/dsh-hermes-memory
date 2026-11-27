/**
 * dsh-hermes-memory —— 记忆面板（浏览器半边）
 *
 * 功能：查看 MEMORY / USER 两个记忆库的全部条目，并可增、删、改。
 * 美学：吸收太极美学的气质 —— 黑白灰、大量留白、细线分割、克制动效；
 *       不照搬太极符号与意象（无阴阳鱼、无文言文案）。
 *
 * 挂载：侧边栏全局面板入口（sidebar.panellist）+ 主面板（main）。
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
    const INK = 'var(--dsw-alias-label-primary)'
    const SUB = 'var(--dsw-alias-label-secondary)'
    const FAINT = 'var(--dsw-alias-state-idle-primary)'
    const LINE = 'var(--dsw-alias-border-l1)'
    const PAPER = 'var(--dsw-alias-bg-base)'
    const FIELD = 'var(--dsw-alias-bg-layer-1)'
    const FONT = '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    const MONO = '"JetBrains Mono", "Cascadia Mono", monospace'
    // Drafts survive leaving and returning to the global page; the page component
    // itself is unmounted when another main panel is selected.
    const panelDrafts = { memory: '', user: '' }

    // ---------------- 界面文案（zh / en） ----------------
    // 跟随 DSH 设置中的界面语言（可选的 locale 服务）；没有该服务的宿主保持简体中文。
    // 两份词典的键集合一致；万一缺键，退回中文原文而不是显示键名。
    const MESSAGES = {
      zh: {
        unknownError: '未知错误',
        errorWithDetail: '{label}（{detail}）',
        'error.unauthorized': '登录已过期，请重新登录后刷新页面',
        'error.forbidden': '当前账号没有操作权限，请使用有权限的账号重新登录后刷新页面',
        'error.storage_reload_required': '存储保护已触发，写入已暂停。请停止其他写入并检查存储文件，处理后重新加载插件',
        'error.runtime_reload_required': '上次写入结果不明，写入已暂停。请核对记忆和待审记录后重新加载插件',
        'error.storage_unavailable': '存储暂不可用，请稍后重试载入',
        'error.auth_service_unavailable': '登录验证服务暂不可用，请稍后重试载入',
        'error.row_conflict': '条目已变化、被重建或版本已过期，请核对最新列表后重新开始编辑',
        'error.validation_failed': '内容未通过校验，请修改内容后再提交',
        'storage.unavailable': '存储暂不可用 · 写入已暂停，可稍后重新载入。草稿与上次成功列表已保留。',
        'storage.blocked': '存储保护已触发 · 写入已暂停。请停止其他写入并检查存储文件，核对结果后重新加载插件。草稿与上次成功列表已保留。',
        'storage.guardedNative': '存储保护 · 原生保护已启用（单写入者租约、外部变更检查）。',
        'storage.hostJson': '存储保护 · 宿主 JSON 模式，不提供跨进程写锁或外部变更检查。请勿让多个进程共用此存储目录。',
        'storage.unknown': '存储保护 · 当前宿主未提供保护状态，请确认只有一个进程使用此存储目录。',
        'storage.detail': '存储详情：{detail}',
        nonJsonResponse: '服务器返回非 JSON 响应（HTTP {status}）',
        invalidResponse: '服务器返回无效响应',
        storeNotReady: '记忆存储尚未就绪',
        invalidList: '服务器返回无效记忆列表',
        invalidVersions: '服务器返回无效记忆版本',
        invalidPending: '服务器返回无效待审记忆',
        operationFailed: '操作失败',
        editDraftLabel: '编辑记忆草稿',
        save: '保存',
        cancel: '取消',
        saveFailed: '保存失败：{error}。草稿已保留。',
        staleDraft: '此草稿的原条目已过期，保存已停用。请复制草稿后取消编辑，刷新列表，再选择当前条目重新编辑并核对内容。',
        copyDraft: '复制草稿',
        draftCopied: '草稿已复制。请点击取消，刷新列表，再选择当前条目重新编辑。',
        copyUnavailable: '自动复制不可用，请在上方文本框中全选并复制草稿，再取消编辑。',
        entryCount: '{count} 条',
        noEntries: '暂无条目',
        edit: '编辑',
        remove: '删除',
        editRowLabel: '编辑 {bank} 第 {index} 条：{excerpt}',
        removeRowLabel: '删除 {bank} 第 {index} 条：{excerpt}',
        missingOriginal: '原条目已变化或被删除，草稿已保留。请核对后取消或复制草稿。',
        confirmRemoveQuestion: '确认删除以下记忆？',
        removeFailed: '删除失败：{error}',
        staleRemove: '此删除目标已过期，重复删除已停用。请取消删除并刷新列表，再选择当前条目。',
        confirmRemove: '确认删除',
        cancelRemove: '取消删除',
        addEntryLabel: '添加 {bank} 记忆条目',
        newEntryPlaceholder: '新条目 ……',
        add: '添加',
        memory: '记忆',
        openPanel: '打开记忆面板',
        closePanel: '关闭记忆面板',
        loadFailed: '载入失败（{error}）',
        reloadFailedAfter: '{done}；重新载入失败（{error}）',
        retryLoadHint: '，可重试载入',
        added: '已添加',
        saved: '已保存',
        removed: '已删除',
        approved: '已批准并保存',
        discarded: '已丢弃待审修改',
        compacted: '历史详情已压缩，重放保护和未决记录已保留',
        'review.idle': '等待下一次复盘',
        'review.running': '复盘中',
        'review.completed': '最近复盘已完成',
        'review.disabled': '已关闭',
        'review.unavailable': '暂不可用',
        'review.interrupted': '最近复盘已中断',
        'review.failed': '最近复盘失败',
        'review.error': '最近复盘失败',
        'review.max-iterations': '最近复盘已达轮次上限',
        reviewEnabled: '后台复盘 · 每 {interval} 轮用户对话 · {status}',
        reviewOff: '后台复盘 · 已关闭',
        reviewUnavailable: '复盘暂不可用',
        loading: '载入中 ……',
        notLoadedTerminal: '记忆尚未载入，请按上方提示恢复访问',
        notLoaded: '记忆尚未载入，可重新载入',
        pendingTitle: '待审修改 · {count}',
        pendingHint: '后台对旧记忆的修改会等待审核；批准前会再次确认原条目未变化。',
        'op.add': '新增',
        'op.patch': '修改',
        'op.replace': '修改',
        'op.remove': '删除',
        originalText: '原文：{text}',
        newText: '新文：{text}',
        approve: '批准',
        discard: '丢弃',
        exportBackup: '导出备份',
        compactHistory: '压缩历史详情',
        confirmCompactLabel: '确认压缩历史详情',
        compactExplanation: '建议先导出备份。仅压缩 30 天前已结束的历史详情，各保留最近 100 条；保留重放标记和待审、结果不明的完整记录。压缩后无法还原旧详情。',
        confirmCompact: '确认压缩',
        working: '处理中 ……',
        retryLoad: '重试载入',
        refresh: '刷新',
      },
      en: {
        unknownError: 'Unknown error',
        errorWithDetail: '{label} ({detail})',
        'error.unauthorized': 'Your login has expired. Sign in again, then reload this page',
        'error.forbidden': 'This account does not have permission. Sign in with an authorized account, then reload this page',
        'error.storage_reload_required': 'Storage protection has stopped writes. Stop other writers and inspect the storage files, then reload the plugin',
        'error.runtime_reload_required': 'The outcome of the last write is unknown, so writes are paused. Check memory and pending changes, then reload the plugin',
        'error.storage_unavailable': 'Storage is temporarily unavailable. Retry loading later',
        'error.auth_service_unavailable': 'The login verification service is temporarily unavailable. Retry loading later',
        'error.row_conflict': 'The entry changed, was recreated, or its version is out of date. Check the latest list, then start editing again',
        'error.validation_failed': 'The content did not pass validation. Change it, then submit again',
        'storage.unavailable': 'Storage unavailable · writes paused. You can reload later. Drafts and the last successful list are kept.',
        'storage.blocked': 'Storage protection triggered · writes paused. Stop other writers and inspect the storage files, check the result, then reload the plugin. Drafts and the last successful list are kept.',
        'storage.guardedNative': 'Storage protection · native protection enabled (single-writer lease, external change checks).',
        'storage.hostJson': 'Storage protection · host JSON mode, with no cross-process write lock or external change checks. Do not let several processes share this storage directory.',
        'storage.unknown': 'Storage protection · this host does not report a protection status. Make sure only one process uses this storage directory.',
        'storage.detail': 'Storage details: {detail}',
        nonJsonResponse: 'The server returned a non-JSON response (HTTP {status})',
        invalidResponse: 'The server returned an invalid response',
        storeNotReady: 'The memory store is not ready yet',
        invalidList: 'The server returned an invalid memory list',
        invalidVersions: 'The server returned invalid memory versions',
        invalidPending: 'The server returned invalid pending changes',
        operationFailed: 'Operation failed',
        editDraftLabel: 'Edit memory draft',
        save: 'Save',
        cancel: 'Cancel',
        saveFailed: 'Save failed: {error}. Your draft is kept.',
        staleDraft: 'The original entry for this draft is out of date, so Save is disabled. Copy the draft, cancel the edit, refresh the list, then select the current entry to edit it again and check its content.',
        copyDraft: 'Copy draft',
        draftCopied: 'Draft copied. Click Cancel, refresh the list, then select the current entry to edit it again.',
        copyUnavailable: 'Automatic copy is unavailable. Select all the text in the box above, copy it, then cancel the edit.',
        entryCount: ({ count }) => `${count} ${count === 1 ? 'entry' : 'entries'}`,
        noEntries: 'No entries yet',
        edit: 'Edit',
        remove: 'Delete',
        editRowLabel: 'Edit {bank} entry {index}: {excerpt}',
        removeRowLabel: 'Delete {bank} entry {index}: {excerpt}',
        missingOriginal: 'The original entry changed or was deleted. Your draft is kept. Check it, then cancel or copy the draft.',
        confirmRemoveQuestion: 'Delete this memory entry?',
        removeFailed: 'Delete failed: {error}',
        staleRemove: 'This delete target is out of date, so deleting again is disabled. Cancel the deletion, refresh the list, then select the current entry.',
        confirmRemove: 'Confirm delete',
        cancelRemove: 'Cancel delete',
        addEntryLabel: 'Add a {bank} memory entry',
        newEntryPlaceholder: 'New entry…',
        add: 'Add',
        memory: 'Memory',
        openPanel: 'Open memory panel',
        closePanel: 'Close memory panel',
        loadFailed: 'Loading failed ({error})',
        reloadFailedAfter: '{done}; reloading failed ({error})',
        retryLoadHint: '. You can retry loading',
        added: 'Added',
        saved: 'Saved',
        removed: 'Deleted',
        approved: 'Approved and saved',
        discarded: 'Pending change discarded',
        compacted: 'History details compacted; replay protection and unresolved records were kept',
        'review.idle': 'waiting for the next review',
        'review.running': 'reviewing',
        'review.completed': 'last review completed',
        'review.disabled': 'off',
        'review.unavailable': 'unavailable',
        'review.interrupted': 'last review interrupted',
        'review.failed': 'last review failed',
        'review.error': 'last review failed',
        'review.max-iterations': 'last review reached the iteration limit',
        reviewEnabled: 'Background review · every {interval} user turns · {status}',
        reviewOff: 'Background review · off',
        reviewUnavailable: 'Review unavailable',
        loading: 'Loading…',
        notLoadedTerminal: 'Memory is not loaded. Follow the message above to restore access',
        notLoaded: 'Memory is not loaded. You can load it again',
        pendingTitle: 'Pending changes · {count}',
        pendingHint: 'Background changes to existing memories wait for review; approving checks again that the original entry has not changed.',
        'op.add': 'Add',
        'op.patch': 'Edit',
        'op.replace': 'Edit',
        'op.remove': 'Delete',
        originalText: 'Original: {text}',
        newText: 'New: {text}',
        approve: 'Approve',
        discard: 'Discard',
        exportBackup: 'Export backup',
        compactHistory: 'Compact history details',
        confirmCompactLabel: 'Confirm history detail compaction',
        compactExplanation: 'Export a backup first. Only finished history details older than 30 days are compacted, keeping the latest 100 of each kind; replay markers and complete pending or unresolved records are kept. Compacted details cannot be restored.',
        confirmCompact: 'Confirm compaction',
        working: 'Working…',
        retryLoad: 'Retry loading',
        refresh: 'Refresh',
      },
    }
    let lang = 'zh'
    const langListeners = new Set()
    function setLang(next) {
      if (next === lang) return
      lang = next
      for (const fn of langListeners) fn(next)
    }
    function useLang() {
      const [current, setCurrent] = React.useState(lang)
      React.useEffect(() => {
        langListeners.add(setCurrent)
        return () => langListeners.delete(setCurrent)
      }, [])
      return current
    }
    function hasMessage(key) {
      return Object.hasOwn(MESSAGES.zh, key)
    }
    // 占位符只在模板中替换一次，条目文本里的 {xxx} 不会被再次展开。
    function t(key, params) {
      const value = Object.hasOwn(MESSAGES[lang], key) ? MESSAGES[lang][key] : MESSAGES.zh[key]
      if (typeof value === 'function') return value(params || {})
      if (!params) return value
      return value.replace(/\{(\w+)\}/g, (match, name) => params[name] === undefined ? match : String(params[name]))
    }
    // zh、zh-CN、zh-TW 等使用中文；其他语言与 DSH 的回退规则一致，使用英文。
    function panelLang(active) {
      if (typeof active !== 'string' || !active) return undefined
      return /^zh(?:[-_]|$)/i.test(active) ? 'zh' : 'en'
    }
    function followLocale(ctx) {
      const attach = (locale, effect) => {
        if (!locale || typeof locale.getLocale !== 'function') return
        const sync = () => {
          const next = panelLang(locale.getLocale()?.active)
          if (next) setLang(next)
        }
        sync()
        if (typeof locale.subscribe === 'function') effect(() => locale.subscribe(sync))
      }
      // locale 是可选依赖：不写入 inject，避免旧宿主因缺少该服务而不加载面板。
      // ctx.inject 在服务出现时接入（包括晚于本插件提供的情况），服务卸载时自动退订。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['locale'], (sub) => attach(sub.get('locale'), (fn) => sub.effect(fn, 'hermes-memory: locale')))
      } else {
        attach(ctx.get('locale'), (fn) => ctx.effect(fn, 'hermes-memory: locale'))
      }
    }

    // ---------------- 数据 ----------------
    function errorText(error) {
      return String((error && error.message) || error || t('unknownError'))
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
      const label = typeof error?.code === 'string' && hasMessage(`error.${error.code}`) ? t(`error.${error.code}`) : undefined
      const detail = errorText(error)
      return label ? t('errorWithDetail', { label, detail }) : detail
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
        ? t('storage.unavailable')
        : t('storage.blocked')
      if (safety?.mode === 'guarded-native') return t('storage.guardedNative')
      if (safety?.mode === 'host-json') return t('storage.hostJson')
      return t('storage.unknown')
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
        throw requestError({ code: authCode }, response.status, authCode ? `HTTP ${response.status}` : t('nonJsonResponse', { status: response.status }))
      }
      if (!response.ok || authCode) throw requestError(value, response.status)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw requestError({}, response.status, t('invalidResponse'))
      }
      if (value.success === false || value.ready === false) {
        throw requestError(value, response.status, t('storeNotReady'))
      }
      return value
    }
    async function loadAll() {
      const value = await post('/hermes-memory/ops', { action: 'list' })
      if (!['memory', 'user'].every((bank) => Array.isArray(value[bank]) && value[bank].every((text) => typeof text === 'string'))
        || !value.usage || typeof value.usage !== 'object' || Array.isArray(value.usage)
        || !['memory', 'user'].every((bank) => value.usage[bank] === undefined || typeof value.usage[bank] === 'string')) {
        throw new Error(t('invalidList'))
      }
      if (value.entryVersions !== undefined && (!value.entryVersions || typeof value.entryVersions !== 'object'
        || !['memory', 'user'].every(bank => Array.isArray(value.entryVersions[bank])
          && value.entryVersions[bank].length === value[bank].length
          && value.entryVersions[bank].every(version => typeof version === 'string' && version.length > 0 && version.length <= 128)))) {
        throw new Error(t('invalidVersions'))
      }
      if (value.pending !== undefined && (!Array.isArray(value.pending) || value.pending.some((item) => !item
        || typeof item.id !== 'string' || !['memory', 'user'].includes(item.target) || !Array.isArray(item.operations)))) {
        throw new Error(t('invalidPending'))
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
        color: ghost ? SUB : PAPER,
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
            'aria-label': t('editDraftLabel'),
            'aria-invalid': !!error || !!conflicted,
            onChange: (e) => onEdit({ ...editing, text: e.target.value }),
            rows: 2,
            style: {
              flex: 1, minWidth: 0, border: `1px solid ${SUB}`, background: FIELD,
              padding: 6, fontSize: 13, lineHeight: 1.6, wordBreak: 'normal', overflowWrap: 'anywhere',
              fontFamily: FONT, color: INK, resize: 'vertical',
            },
          }),
          React.createElement('button', { onClick: onSave, disabled: busy || writesBlocked || !!conflicted || !editing.text.trim(), style: btnStyle(false) }, t('save')),
          React.createElement('button', { onClick: onCancel, disabled: busy, style: btnStyle(true) }, t('cancel')),
        ),
        error && React.createElement('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, paddingTop: 6, overflowWrap: 'anywhere' } }, t('saveFailed', { error: describeError(error) })),
        conflicted && React.createElement('div', { role: 'status', style: { color: SUB, fontSize: 12, lineHeight: 1.7, paddingTop: 6 } },
          t('staleDraft'),
          React.createElement('button', { onClick: onCopy, disabled: busy, style: { ...btnStyle(true), marginLeft: 8 } }, t('copyDraft')),
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
          React.createElement('span', { style: { fontSize: 11, color: FAINT, marginLeft: 'auto' } }, t('entryCount', { count: list.length })),
        ),
        // 条目
        (list.length === 0
          ? React.createElement('div', { style: { color: FAINT, fontSize: 12, padding: '16px 0' } }, t('noEntries'))
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
                        'aria-label': t('editRowLabel', { bank: title, index: i + 1, excerpt: entryExcerpt(text) }),
                        onClick: () => onEdit({ bank, index: i, text: String(text), original: String(text) }),
                        disabled: busy || writesBlocked || !!editing || !!deleting,
                        style: rowActionStyle(),
                      }, t('edit')),
                      React.createElement('button', {
                        className: 'hm-action',
                        'aria-label': t('removeRowLabel', { bank: title, index: i + 1, excerpt: entryExcerpt(text) }),
                        onClick: () => onRemove(bank, String(text), i),
                        disabled: busy || writesBlocked || !!editing || !!deleting,
                        style: rowActionStyle(),
                      }, t('remove')),
                    ),
              )
            })
        ),
        ownEdit && editingIndex === -1 && React.createElement('div', { style: { padding: '12px 0' } },
          React.createElement('div', { role: 'status', style: { color: SUB, fontSize: 12, paddingBottom: 8 } }, t('missingOriginal')),
          editForm(editing, busy, writesBlocked, editError, onEdit, onSave, onCancel, onCopy, copyNotice, editingIndex === -1),
        ),
        ownDelete && React.createElement('div', { style: { border: `1px solid ${LINE}`, padding: 12, marginTop: 10 } },
          React.createElement('div', { style: { color: INK, fontSize: 12 } }, t('confirmRemoveQuestion')),
          React.createElement('div', { style: { color: SUB, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '8px 0' } }, deleting.text),
          deleteError && React.createElement('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginBottom: 8 } }, t('removeFailed', { error: describeError(deleteError) })),
          (deleting.conflicted || deleteError?.code === 'row_conflict') && React.createElement('div', { role: 'status', style: { color: SUB, fontSize: 12, marginBottom: 8 } }, t('staleRemove')),
          React.createElement('button', { onClick: onConfirmRemove, disabled: busy || writesBlocked || !!deleting.conflicted || deleteError?.code === 'row_conflict', style: btnStyle(false) }, t('confirmRemove')),
          React.createElement('button', { onClick: onCancelRemove, disabled: busy, style: { ...btnStyle(true), marginLeft: 8 } }, t('cancelRemove')),
        ),
        // 添加
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          React.createElement('input', {
            value: draft,
            disabled: busy,
            'aria-label': t('addEntryLabel', { bank: title }),
            onChange: (e) => onDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !busy && !writesBlocked && !e.isComposing && !e.nativeEvent?.isComposing) onAdd() },
            placeholder: t('newEntryPlaceholder'),
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
          }, t('add')),
        ),
      )
    }

    // ---------------- 全局面板入口 ----------------
    // sidebar.panellist 的 owner 负责按钮、选中态、无障碍名称和折叠行为；
    // 这里只提供图标，label 由注册元数据提供。
    function MemoryIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 18
      return React.createElement('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          fontSize: Math.max(12, size - 2),
          lineHeight: 1,
          color: props?.active ? INK : FAINT,
        },
      }, '🧠')
    }

    // ---------------- 全局面板页 ----------------
    function Panel() {
      useLang()
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [editError, setEditError] = React.useState(null)
      const [deleting, setDeleting] = React.useState(null)
      const [deleteError, setDeleteError] = React.useState(null)
      const [compactConfirm, setCompactConfirm] = React.useState(false)
      const [drafts, setDrafts] = React.useState(() => ({ ...panelDrafts }))
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
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; loadEpoch.current += 1 }
      }, [])

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
          setNotice({ ok: false, loadError: true, error, text: (savedText ? t('reloadFailedAfter', { done: savedText, error: describeError(error) }) : t('loadFailed', { error: describeError(error) }))
            + (retryAllowed(error) ? t('retryLoadHint') : '') })
        } finally {
          if (mounted.current && epoch === loadEpoch.current) setLoading(false)
        }
      }
      React.useEffect(() => {
        void refresh()
        return () => { loadEpoch.current += 1 }
      }, [])

      const act = async (fn, okText, onSuccess, onError) => {
        // 键盘 Enter 和同一渲染内的重复点击也必须经过写锁。
        if (writeLock.current || loading || data === null || writesAreBlocked()) return
        writeLock.current = true
        loadEpoch.current += 1
        setBusy(true)
        try {
          const out = await fn()
          if (!out || out.success !== true) throw requestError(out, undefined, t('operationFailed'))
          if (!mounted.current) return
          observeSafety(out.storageSafety)
          if (onSuccess) onSuccess()
          setNotice({ ok: true, text: okText })
          await refresh(okText)
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

      const setDraft = (bank, text) => {
        panelDrafts[bank] = text
        setDrafts((d) => ({ ...d, [bank]: text }))
      }
      const addEntry = (bank) => {
        const draft = drafts[bank]
        const content = draft.trim()
        if (!content) return
        void act(() => post('/hermes-memory/ops', { action: 'add', bank, content }), t('added'), () => {
          if (drafts[bank] !== draft) return
          panelDrafts[bank] = ''
          setDrafts((d) => ({ ...d, [bank]: '' }))
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
          if (mounted.current && activeEdit.current === entry) setCopyNotice(t('draftCopied'))
        } catch {
          if (mounted.current && activeEdit.current === entry) setCopyNotice(t('copyUnavailable'))
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
        void act(() => post('/hermes-memory/ops', { action: 'replace', bank: e.bank, oldText: e.original, content, expectedVersion: e.expectedVersion }), t('saved'), () => {
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
        void act(() => post('/hermes-memory/ops', { action: 'remove', bank: entry.bank, oldText: entry.text, expectedVersion: entry.expectedVersion }), t('removed'), () => {
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
      const reviewLabel = (status) => typeof status === 'string' && hasMessage(`review.${status}`) ? t(`review.${status}`) : status
      const controlsBusy = busy || loading || data === null
      const writesBlocked = !!blocked || safetyBlocked(safety)
      const terminal = terminalError(blocked) || (safetyBlocked(safety) && safety.state !== 'unavailable')
      const canReload = !terminal && (!notice?.loadError || retryAllowed(notice.error))

      return React.createElement('div', {
        className: 'hm-page',
        style: {
          minHeight: '100%',
          background: PAPER,
          color: INK,
          fontFamily: FONT,
          padding: '28px 28px 48px',
          overflowY: 'auto',
        },
      },
        React.createElement('div', {
          style: { width: '100%', maxWidth: 960, margin: '0 auto' },
        },
          // 头
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 } },
            React.createElement('span', { style: { fontSize: 18, letterSpacing: 6, color: INK } }, t('memory')),
            React.createElement('span', { style: { fontSize: 11, color: FAINT, fontFamily: MONO } }, 'MEMORY / USER'),
          ),
          React.createElement('div', {
            role: 'status', 'aria-live': 'polite', 'data-storage-state': safety?.state || 'unknown',
            style: { color: writesBlocked ? 'var(--dsw-alias-state-error-primary)' : SUB, fontSize: 12, lineHeight: 1.7, marginTop: 20, padding: 10, border: `1px solid ${LINE}`, overflowWrap: 'anywhere' },
          },
            storageMessage(safety),
            safety?.error && React.createElement('div', null, t('storage.detail', { detail: errorText(safety.error) })),
            blocked && React.createElement('div', null, describeError(blocked)),
          ),
          data === null && React.createElement('div', {
            role: 'status', style: { color: SUB, fontSize: 12, paddingTop: 24 },
          }, loading ? t('loading') : terminal ? t('notLoadedTerminal') : t('notLoaded')),
          // 仅成功响应可以显示“暂无条目”；失败时保留上次成功快照。
          data !== null && React.createElement(Section, {
            title: 'MEMORY', bank: 'memory',
            list: memList, versions: data.entryVersions?.memory, usage: usage.memory || '',
            editing, editError, deleting, deleteError, draft: drafts.memory, busy: controlsBusy, writesBlocked, copyNotice, onCopy: copyDraft,
            onDraft: (t) => setDraft('memory', t),
            onAdd: () => addEntry('memory'),
            onEdit: editEntry, onSave: saveEdit, onCancel: cancelEdit,
            onRemove: removeEntry, onConfirmRemove: confirmRemove, onCancelRemove: cancelRemove,
          }),
          // USER 分区
          data !== null && React.createElement(Section, {
            title: 'USER', bank: 'user',
            list: userList, versions: data.entryVersions?.user, usage: usage.user || '',
            editing, editError, deleting, deleteError, draft: drafts.user, busy: controlsBusy, writesBlocked, copyNotice, onCopy: copyDraft,
            onDraft: (t) => setDraft('user', t),
            onAdd: () => addEntry('user'),
            onEdit: editEntry, onSave: saveEdit, onCancel: cancelEdit,
            onRemove: removeEntry, onConfirmRemove: confirmRemove, onCancelRemove: cancelRemove,
          }),
          data !== null && review && React.createElement('div', {
            style: { color: SUB, fontSize: 12, paddingTop: 20, lineHeight: 1.7 },
          },
            React.createElement('div', null, review.enabled
              ? t('reviewEnabled', { interval: review.interval, status: reviewLabel(review.status) })
              : t('reviewOff')),
            review.error && React.createElement('div', { role: 'status', style: { color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } },
              typeof review.error === 'string' ? review.error : review.error.message || t('reviewUnavailable')),
          ),
          pending.length > 0 && React.createElement('div', {
            style: { marginTop: 20, borderTop: `1px solid ${LINE}`, paddingTop: 16 },
          },
            React.createElement('div', { style: { fontSize: 13, color: INK, marginBottom: 10 } }, t('pendingTitle', { count: pending.length })),
            React.createElement('div', { style: { fontSize: 12, color: SUB, marginBottom: 12 } }, t('pendingHint')),
            pending.map((item) => React.createElement('div', { key: item.id, style: { border: `1px solid ${LINE}`, padding: 12, marginBottom: 10, fontSize: 12 } },
              React.createElement('div', { style: { fontFamily: MONO, color: SUB, marginBottom: 8 } }, item.target.toUpperCase()),
              item.operations.map((op, index) => React.createElement('div', { key: index, style: { marginBottom: 8, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                React.createElement('strong', null, typeof op.action === 'string' && hasMessage(`op.${op.action}`) ? t(`op.${op.action}`) : op.action),
                (op.oldText || op.old_text) && React.createElement('div', { style: { color: SUB } }, t('originalText', { text: op.oldText || op.old_text })),
                op.content !== undefined && React.createElement('div', { style: { color: INK } }, t('newText', { text: op.content })),
              )),
              React.createElement('button', {
                style: btnStyle(false), disabled: controlsBusy || writesBlocked,
                onClick: () => { void act(() => post('/hermes-memory/pending', { action: 'approve', id: item.id }), t('approved')) },
              }, t('approve')),
              React.createElement('button', {
                style: { ...btnStyle(true), marginLeft: 8 }, disabled: controlsBusy || writesBlocked,
                onClick: () => { void act(() => post('/hermes-memory/pending', { action: 'discard', id: item.id }), t('discarded')) },
              }, t('discard')),
            )),
          ),
          data !== null && React.createElement('div', {
            style: { marginTop: 20, paddingTop: 12, borderTop: `1px solid ${LINE}`, fontSize: 12, color: SUB },
          },
            React.createElement('a', {
              href: '/hermes-memory/export', download: 'hermes-memory-export.json',
              style: { color: INK, marginRight: 12 },
            }, t('exportBackup')),
            React.createElement('button', {
              disabled: controlsBusy || writesBlocked || !!editing || !!deleting,
              style: btnStyle(true), onClick: () => setCompactConfirm(true),
            }, t('compactHistory')),
            compactConfirm && React.createElement('div', { role: 'group', 'aria-label': t('confirmCompactLabel'), style: { paddingTop: 10, lineHeight: 1.8 } },
              React.createElement('div', null, t('compactExplanation')),
              React.createElement('button', {
                disabled: controlsBusy || writesBlocked, style: btnStyle(false),
                onClick: () => { void act(() => post('/hermes-memory/compact', { before: new Date(Date.now() - 30 * 86400000).toISOString(), maxDetailed: 100 }),
                  t('compacted'), () => setCompactConfirm(false)) },
              }, t('confirmCompact')),
              React.createElement('button', { disabled: controlsBusy, style: { ...btnStyle(true), marginLeft: 8 }, onClick: () => setCompactConfirm(false) }, t('cancel')),
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
              color: notice ? (notice.ok ? SUB : 'var(--dsw-alias-state-error-primary)') : FAINT,
              letterSpacing: 1,
            },
          },
            React.createElement('span', { role: 'status', 'aria-live': 'polite' }, notice ? notice.text : (busy ? t('working') : loading ? t('loading') : '')),
            canReload && React.createElement('button', {
              onClick: () => { void refresh() }, disabled: busy || loading,
              style: { ...btnStyle(true), marginLeft: 12 },
            }, notice && notice.loadError ? t('retryLoad') : t('refresh')),
          ),
        ),
      )
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      followLocale(ctx)
      // 保持操作按钮可见，并为键盘焦点提供清晰轮廓。
      const cssId = 'dsh-hermes-memory-row-actions'
      ctx.effect(() => {
        // 接管旧版遗留的同名样式，使 targeted reload 后也能正确回收。
        const st = document.getElementById(cssId) || document.createElement('style')
        st.id = cssId
        st.textContent = `
          .hm-row .hm-action:hover { color: var(--dsw-alias-label-primary) !important; }
          .hm-page :focus-visible, .hm-page:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
        `
        document.head.appendChild(st)
        return () => st.remove()
      }, 'hermes-memory: styles')
      // 挂载门控：global panel 由 ui-layout / ui-sidebar 声明，本插件的 apply
      // 时序早于它们，直接 register 会抛。官方标准写法是
      // slots.inject(slot, () => slots.register(...))：声明已存在时同步执行，
      // 否则等声明提交后再执行。
      if (typeof slots.inject === 'function') {
        slots.inject('main', () =>
          slots.register({ name: 'main', key: 'hermes-memory' }, Panel))
        slots.inject('sidebar.panellist', () =>
          slots.register({
            name: 'sidebar.panellist', id: 'hermes-memory', order: 30,
            label: () => t('memory'),
          }, MemoryIcon))
      } else {
        // 兜底：老运行时没有 inject 门控，退回直接 register
        ctx.effect(() => {
          const offPanel = slots.register({ name: 'main', key: 'hermes-memory' }, Panel)
          const offEntry = slots.register({
            name: 'sidebar.panellist', id: 'hermes-memory', order: 30,
            label: () => t('memory'),
          }, MemoryIcon)
          return () => { offPanel(); offEntry() }
        }, 'hermes-memory: slots')
      }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
