/**
 * dsh-hermes-memory —— 太极记忆面板（浏览器半边）
 *
 * 美学：太极美学 —— 去 emoji、黑白二色、宣纸留白、细线、宋体书卷气。
 * 意象：MEMORY.md 为「阴」（agent 自性，墨色），USER.md 为「阳」（用户，纸白）；
 *       用量以阴阳双鱼环示之，中心太极定盘。
 *
 * 挂载：侧边栏底部「记忆」入口（sidebar.footer.action）+ 浮层面板（shell.overlay）。
 * 数据：同源 fetch host 的 webServer 路由（/hermes-memory/stats、/hermes-memory/ops）。
 *
 * 格式：DSH client-modules 的 __ModuleLoader__ 格式（与官方 dsh-client-ui-* 产物一致），
 *       纯 CommonJS + React.createElement，无 JSX、无构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hermes-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    // ---------------- 太极美学常量 ----------------
    const INK = '#1a1a1a' // 墨
    const PAPER = '#fafafa' // 宣纸
    const PAPER_DEEP = '#f2f0eb' // 陈纸
    const ASH = '#8a8a8a' // 淡墨
    const HAIR = '#e4e1d9' // 细线（麻纸色）
    const SERIF = '"Songti SC","SimSun","Noto Serif SC",serif'
    const MONO = '"JetBrains Mono","Cascadia Mono",monospace'

    /** 阴阳鱼（黑白双鱼 + 双点），面板与入口共用。 */
    function Taiji({ size, stroke }) {
      return React.createElement('svg', {
        viewBox: '0 0 100 100',
        width: size,
        height: size,
        style: { display: 'block' },
      },
        React.createElement('circle', { cx: 50, cy: 50, r: 48, fill: PAPER, stroke: INK, strokeWidth: stroke || 2 }),
        React.createElement('path', {
          d: 'M50 2 A48 48 0 0 1 50 98 A24 24 0 0 1 50 50 A24 24 0 0 1 50 2 Z',
          fill: INK,
        }),
        React.createElement('circle', { cx: 50, cy: 26, r: 7, fill: PAPER }),
        React.createElement('circle', { cx: 50, cy: 74, r: 7, fill: INK }),
      )
    }

    // ---------------- 面板开关（跨 slot 共享状态） ----------------
    let visible = false
    const visibleListeners = new Set()
    function setVisible(v) {
      visible = v
      for (const fn of visibleListeners) fn(v)
    }
    function useVisible() {
      const [v, setV] = React.useState(visible)
      React.useEffect(() => {
        visibleListeners.add(setV)
        return () => visibleListeners.delete(setV)
      }, [])
      return [v, setV]
    }

    // ---------------- 数据 ----------------
    function fetchStats() {
      return fetch('/hermes-memory/stats', { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    }
    function removeEntry(bank, oldText) {
      return fetch('/hermes-memory/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', bank, oldText }),
      }).then((r) => r.json())
    }

    // ---------------- 环形用量（阴阳双鱼环） ----------------
    function Ring({ memoryPct, userPct }) {
      const total = Math.max(1, memoryPct + userPct)
      const memShare = (memoryPct / total) * 100
      // 墨色（阴）= MEMORY 占比；纸色留白（阳）= USER 占比；环底淡灰
      const bg = `conic-gradient(${INK} 0 ${memShare}%, ${PAPER} ${memShare}% 100%)`
      return React.createElement('div', {
        style: {
          position: 'relative',
          width: 88,
          height: 88,
          borderRadius: '50%',
          background: bg,
          boxShadow: `inset 0 0 0 1px ${HAIR}`,
          flex: 'none',
        },
      },
        React.createElement('div', {
          style: {
            position: 'absolute',
            inset: 12,
            borderRadius: '50%',
            background: PAPER,
            boxShadow: `inset 0 0 0 1px ${HAIR}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
          React.createElement(Taiji, { size: 34, stroke: 1.5 }),
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
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: '4px 2px',
          color: v ? INK : ASH,
          fontFamily: SERIF,
          fontSize: 13,
          letterSpacing: 2,
          transition: 'color .2s ease',
        },
      },
        React.createElement(Taiji, { size: 16, stroke: 1.5 }),
        React.createElement('span', null, '记忆'),
      )
    }

    // ---------------- 浮层面板 ----------------
    function Panel() {
      const [v] = useVisible()
      const [stats, setStats] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const load = () => {
        fetchStats().then(setStats).catch((e) => setError(String((e && e.message) || e)))
      }
      React.useEffect(() => {
        if (v) load()
      }, [v])
      if (!v) return null

      const q = query.trim().toLowerCase()
      // 完整列表走 ops list 异步获取
      const [full, setFull] = React.useState(null)
      React.useEffect(() => {
        if (!v) return
        fetch('/hermes-memory/ops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list' }),
        }).then((r) => r.json()).then(setFull).catch(() => {})
      }, [v, stats && stats.ready])

      const filter = (list) => {
        if (!list) return []
        const arr = Array.isArray(list) ? list : []
        return q ? arr.filter((t) => String(t).toLowerCase().includes(q)) : arr
      }
      const memList = filter(full ? full.memory : null)
      const userList = filter(full ? full.user : null)

      const onRemove = (bank, text) => {
        setBusy(text.slice(0, 12))
        removeEntry(bank, text).then((out) => {
          setBusy(null)
          if (out && out.success) load()
        }).catch(() => setBusy(null))
      }

      const Section = ({ title, note, list, bank }) => React.createElement('div', { style: { marginTop: 22 } },
        React.createElement('div', {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            borderBottom: `1px solid ${HAIR}`,
            paddingBottom: 6,
          },
        },
          React.createElement('span', { style: { color: INK, fontSize: 13, letterSpacing: 3, fontFamily: SERIF } }, title),
          React.createElement('span', { style: { color: ASH, fontSize: 11, fontFamily: SERIF } }, note),
        ),
        list.length === 0
          ? React.createElement('div', { style: { color: ASH, fontSize: 12, fontFamily: SERIF, padding: '14px 0', letterSpacing: 1 } },
              q ? '无所寻 —— 未得' : '虚静 —— 尚无记忆')
          : list.map((t, i) => React.createElement('div', {
              key: i,
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '9px 0',
                borderBottom: `1px solid ${HAIR}`,
              },
            },
              React.createElement('span', {
                style: {
                  color: bank === 'memory' ? INK : ASH,
                  fontSize: 10,
                  fontFamily: SERIF,
                  marginTop: 3,
                  flex: 'none',
                },
              }, bank === 'memory' ? '●' : '○'),
              React.createElement('span', {
                style: {
                  flex: 1,
                  color: INK,
                  fontSize: 13.5,
                  lineHeight: 1.7,
                  fontFamily: SERIF,
                  wordBreak: 'break-all',
                },
              }, String(t)),
              React.createElement('button', {
                onClick: () => onRemove(bank, String(t)),
                disabled: busy !== null,
                title: '删',
                style: {
                  flex: 'none',
                  border: 'none',
                  background: 'transparent',
                  color: ASH,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: SERIF,
                  padding: '2px 4px',
                  opacity: 0.45,
                  transition: 'opacity .15s ease',
                },
              }, '×'),
            )),
      )

      const usagePct = (u) => {
        if (!u) return 0
        const m = u.match(/(\d+)%/)
        return m ? Number(m[1]) : 0
      }
      const memPct = stats ? usagePct(stats.memory && stats.memory.usage) : 0
      const userPct = stats ? usagePct(stats.user && stats.user.usage) : 0

      return React.createElement('div', {
        onClick: (e) => { if (e.target === e.currentTarget) setVisible(false) },
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9000,
          background: 'rgba(20,20,18,.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: SERIF,
        },
      },
        React.createElement('div', {
          style: {
            width: 680,
            maxWidth: '92vw',
            maxHeight: '84vh',
            overflowY: 'auto',
            background: PAPER,
            border: `1px solid ${INK}`,
            boxShadow: '0 24px 64px rgba(20,20,18,.28)',
            padding: '34px 40px 26px',
            position: 'relative',
          },
        },
          // 顶：太极 + 题
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
            React.createElement(Taiji, { size: 30, stroke: 2 }),
            React.createElement('div', null,
              React.createElement('div', { style: { fontSize: 20, letterSpacing: 6, color: INK } }, '记忆'),
              React.createElement('div', { style: { fontSize: 11, color: ASH, letterSpacing: 2, marginTop: 2 } },
                '阴 · 自性 · 阳 · 人相 —— 相济而存'),
            ),
            React.createElement('button', {
              onClick: () => setVisible(false),
              style: {
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                color: ASH,
                cursor: 'pointer',
                fontSize: 16,
                fontFamily: SERIF,
                padding: '2px 6px',
              },
            }, '×'),
          ),
          // 用量环
          React.createElement('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 26,
              marginTop: 26,
              padding: '18px 22px',
              background: PAPER_DEEP,
              border: `1px solid ${HAIR}`,
            },
          },
            React.createElement(Ring, { memoryPct: memPct, userPct: userPct }),
            React.createElement('div', null,
              React.createElement('div', { style: { fontSize: 12.5, color: INK, letterSpacing: 2 } },
                `墨 ${stats && stats.memory ? stats.memory.entries : 0} 条 · ${stats && stats.memory ? stats.memory.usage : '—'}`),
              React.createElement('div', { style: { fontSize: 12.5, color: ASH, letterSpacing: 2, marginTop: 6 } },
                `纸 ${stats && stats.user ? stats.user.entries : 0} 条 · ${stats && stats.user ? stats.user.usage : '—'}`),
              React.createElement('div', {
                style: {
                  fontSize: 10.5,
                  color: ASH,
                  fontFamily: MONO,
                  marginTop: 10,
                  letterSpacing: 0,
                },
              }, stats ? stats.file : '…'),
            ),
          ),
          // 寻（搜索）
          React.createElement('div', { style: { marginTop: 20 } },
            React.createElement('input', {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: '寻 记忆 ……',
              style: {
                width: '100%',
                border: 'none',
                borderBottom: `1px solid ${INK}`,
                background: 'transparent',
                outline: 'none',
                padding: '6px 2px',
                fontFamily: SERIF,
                fontSize: 13.5,
                color: INK,
                letterSpacing: 1,
              },
            }),
          ),
          // 两仪
          React.createElement(Section, {
            title: '自性 · AGENT',
            note: '阴 ／ 墨',
            list: memList,
            bank: 'memory',
          }),
          React.createElement(Section, {
            title: '人相 · USER',
            note: '阳 ／ 纸',
            list: userList,
            bank: 'user',
          }),
          // 脚注
          React.createElement('div', {
            style: {
              marginTop: 24,
              paddingTop: 12,
              borderTop: `1px solid ${HAIR}`,
              display: 'flex',
              justifyContent: 'space-between',
              color: ASH,
              fontSize: 10.5,
              letterSpacing: 1,
            },
          },
            React.createElement('span', null, '有界而存 · 满则自合'),
            React.createElement('span', null, error ? `载入未成：${error}` : busy ? `删 · ${busy} …` : ''),
          ),
        ),
      )
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'hermes-memory' },
        SidebarEntry,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'hermes-memory-panel' },
        Panel,
      ))
    }

    exports.apply = apply
    return module.exports
  },
})
