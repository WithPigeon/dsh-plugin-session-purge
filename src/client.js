// dsh-plugin-session-purge — CLIENT half.
//
// Four slot occupants implement a two-step delete:
//
//   sidebar.footer.action                id 'session-purge-trash', order 10
//       The recycle-bin entry at the sidebar foot, beside Settings. It carries
//       the bin's item count and opens the bin panel. Owner prop `wide` tells it
//       whether the column is expanded or the 56px rail, so the label appears
//       only when there is room for it.
//
//   sidebar.workspaces.session.menu.item  id 'session-purge', order 500
//       A "Move to recycle bin" row in the Session row's "..." menu, beside the
//       shipped pin/rename/fork/archive rows. It receives the row's `sessionId`
//       + `displayTitle` owner props and the menu's `useMenuOpenState` hook.
//
//   conversation.session.header.actions   id 'session-purge', order 30
//       The same action as a button beside the open Session's title.
//
//   shell.overlay (two occupants)
//       id 'session-purge-dialog', order 100  — the confirm for moving a Session
//         into the bin. Reversible, so it asks once and needs no acknowledgement.
//       id 'session-purge-trash-panel', order 110 — the bin itself: titles,
//         deletion dates, per-row restore and permanent delete, and empty-all.
//
// Host protocol (registered by the package's Host half):
//   GET  /__session-purge/trash     -> { ok, entries: [{ sessionId, title, deletedAt }] }
//   POST /__session-purge/trash     { sessionId, title? } -> { ok, entry }
//   POST /__session-purge/restore   { sessionId }         -> { ok }
//   POST /__session-purge/purge     { sessionId }         -> { ok, ...report }
//   POST /__session-purge/empty                           -> { ok, purged, failed }
//
// Deliberate constraints, per the Cordis plugin guide:
//   * plain React only — no Harness Client package (no ui-primitives) is
//     imported, so the bundle cannot break on a Client package version bump;
//     every glyph is an inline SVG and every surface is plain markup.
//   * theme tokens only (--dsw-*) for every colour, so light/dark both work.
//   * all visible text goes through the Client locale service (ns
//     'session-purge'), with a browser-language fallback dictionary.
//   * the factory is side-effect free: everything is registered in apply()
//     with ctx.effect / slot registration disposers.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-purge',
  factory(require) {
    const React = require('react')

    const NS = 'session-purge'

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const HEADER_SLOT = 'conversation.session.header.actions'
    const FOOTER_SLOT = 'sidebar.footer.action'
    const OVERLAY_SLOT = 'shell.overlay'

    const ID_MENU = 'session-purge'
    const ID_HEADER = 'session-purge'
    const ID_FOOTER = 'session-purge-trash'
    const ID_DIALOG = 'session-purge-dialog'
    const ID_PANEL = 'session-purge-trash-panel'

    const BASE = '/__session-purge'

    // How long a row's "delete permanently" button stays armed.
    const CONFIRM_WINDOW_MS = 5000

    // --- dictionaries ---------------------------------------------------------

    const zh = {
      'menu.delete': '移到回收站',
      'button.title': '移到回收站',
      'button.titleRunning': '移到回收站（运行中，会先停止任务）',

      'footer.label': '回收站',
      'footer.title': '回收站',
      'footer.countTitle': '回收站：',

      'dialog.title': '移到回收站',
      'dialog.nameLabel': '会话',
      'dialog.idLabel': '会话 ID',
      'dialog.untitled': '未命名会话',
      'dialog.desc': '会话会从列表移到回收站。之后可以随时从回收站恢复，或者在那里彻底删除。',
      'dialog.running': '该会话正在运行，移到回收站会先停止它的任务，进行中的工作将中断。',
      'dialog.confirm': '移到回收站',
      'dialog.busy': '正在移动…',
      'dialog.cancel': '取消',
      'dialog.failed': '移动失败',

      'panel.title': '回收站',
      'panel.subtitle': '删除的会话先放在这里，可以恢复，也可以彻底删除。',
      'panel.empty': '回收站是空的',
      'panel.emptyHint': '在会话列表中删除的会话会先进入这里。',
      'panel.deletedAt': '删除于',
      'panel.untitled': '未命名会话',
      'panel.restore': '恢复',
      'panel.restoring': '正在恢复…',
      'panel.cancel': '取消',
      'panel.purge': '彻底删除',
      'panel.purgeConfirm': '确认彻底删除？',
      'panel.purging': '正在彻底删除…',
      'panel.emptyBin': '清空回收站',
      'panel.confirmEmpty': '清空会永久删除回收站里的全部会话，不可恢复。',
      'panel.confirmEmptyYes': '确认清空',
      'panel.emptying': '正在清空…',
      'panel.close': '关闭',
      'panel.busy': '处理中…',
      'panel.failed': '操作失败',
      'panel.partialFailed': '有会话没能删除，仍留在回收站里。',
      'panel.count': '共',
      'panel.countUnit': '个会话',
    }

    const en = {
      'menu.delete': 'Move to recycle bin',
      'button.title': 'Move to recycle bin',
      'button.titleRunning': 'Move to recycle bin (running \u2014 its task is stopped first)',

      'footer.label': 'Recycle bin',
      'footer.title': 'Recycle bin',
      'footer.countTitle': 'Recycle bin:',

      'dialog.title': 'Move to recycle bin',
      'dialog.nameLabel': 'Session',
      'dialog.idLabel': 'Session ID',
      'dialog.untitled': 'Untitled session',
      'dialog.desc': 'The session moves out of the list and into the recycle bin. You can restore it from there at any time, or delete it permanently.',
      'dialog.running': 'This session is running. Moving it to the recycle bin stops its task first; work in progress is interrupted.',
      'dialog.confirm': 'Move to recycle bin',
      'dialog.busy': 'Moving\u2026',
      'dialog.cancel': 'Cancel',
      'dialog.failed': 'Move failed',

      'panel.title': 'Recycle bin',
      'panel.subtitle': 'Deleted sessions wait here. Restore one, or delete it permanently.',
      'panel.empty': 'The recycle bin is empty',
      'panel.emptyHint': 'A session you delete from the list lands here first.',
      'panel.deletedAt': 'Deleted',
      'panel.untitled': 'Untitled session',
      'panel.restore': 'Restore',
      'panel.restoring': 'Restoring\u2026',
      'panel.cancel': 'Cancel',
      'panel.purge': 'Delete permanently',
      'panel.purgeConfirm': 'Delete permanently?',
      'panel.purging': 'Deleting\u2026',
      'panel.emptyBin': 'Empty recycle bin',
      'panel.confirmEmpty': 'Emptying permanently deletes every session in the recycle bin. This cannot be undone.',
      'panel.confirmEmptyYes': 'Empty it',
      'panel.emptying': 'Emptying\u2026',
      'panel.close': 'Close',
      'panel.busy': 'Working\u2026',
      'panel.failed': 'Action failed',
      'panel.partialFailed': 'Some sessions could not be deleted and stay in the recycle bin.',
      'panel.count': '',
      'panel.countUnit': 'in the bin',
    }

    // --- locale ---------------------------------------------------------------

    // The `locale` service is adopted when present; the slot registrations
    // carry `locale: NS`, which is what gives each component its `t` seat.
    // When the service is missing (a minimal composition) the browser
    // language picks the fallback dictionary instead.
    let localeService = null

    function fallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      const tags = [].concat(navigator.languages || [], [navigator.language])
      for (const tag of tags) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function fallbackT(key) {
      return (fallbackLang() === 'en' ? en : zh)[key] || key
    }

    // `t` seat first, module fallback second.
    function tOf(props) {
      const t = props && props.t
      if (typeof t === 'function') {
        return (key) => {
          const text = t(key)
          return typeof text === 'string' && text !== key ? text : fallbackT(key)
        }
      }
      return fallbackT
    }

    // --- module store ---------------------------------------------------------
    //
    // One module-level cell shared by the three triggers, the two overlays and
    // the footer count. The triggers only publish; the overlays render from it.
    // This keeps each surface in exactly one place without inventing cross-slot
    // plumbing, and lets the footer badge track edits made inside the panel.

    let pending = null // the Session a move-to-bin confirm is about
    let binOpen = false
    let binEntries = []
    let binStatus = 'idle' // idle | loading | ready
    let binError = null

    const listeners = new Set()

    function notify() {
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* a broken listener must not break the others */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    // Re-render on any store change. The selector runs on every render, so the
    // component always reads the current values rather than a stale snapshot.
    function useStore(select) {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((value) => value + 1)), [])
      return select()
    }

    function publish(next) {
      pending = next
      notify()
    }

    // --- shared styles (theme tokens only) ------------------------------------

    const iconButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      flex: 'none',
    }

    const menuRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '6px 12px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-state-error-primary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
    }

    const backdropStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 60,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,.38)',
      // The overlay layer is click-through; occupants opt back in.
      pointerEvents: 'auto',
    }

    const cardStyle = {
      width: 'min(460px, calc(100vw - 48px))',
      maxHeight: 'calc(100vh - 96px)',
      overflowY: 'auto',
      padding: 20,
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 12px 40px rgba(0,0,0,.28)',
    }

    const binCardStyle = {
      ...cardStyle,
      width: 'min(560px, calc(100vw - 48px))',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      padding: 0,
    }

    const binHeaderStyle = {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      padding: '18px 20px 0',
    }

    const titleStyle = {
      margin: '0 0 12px',
      fontSize: 15,
      fontWeight: 600,
      lineHeight: '22px',
      color: 'var(--dsw-alias-label-primary)',
    }

    const metaStyle = {
      margin: '0 0 12px',
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
      overflowWrap: 'anywhere',
    }

    const bodyStyle = {
      margin: '0 0 12px',
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const warnStyle = {
      margin: '0 0 12px',
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-state-warn-primary)',
    }

    const footerStyle = {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 18,
    }

    const baseButtonStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    }

    const cancelButtonStyle = {
      ...baseButtonStyle,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
    }

    const dangerButtonStyle = {
      ...baseButtonStyle,
      border: '1px solid var(--dsw-alias-state-error-primary)',
      background: 'var(--dsw-alias-state-error-primary)',
      color: '#fff',
    }

    const subtleButtonStyle = {
      ...baseButtonStyle,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      padding: '4px 10px',
      fontSize: 12,
    }

    const rowDangerButtonStyle = {
      ...subtleButtonStyle,
      border: '1px solid var(--dsw-alias-state-error-primary)',
      color: 'var(--dsw-alias-state-error-primary)',
    }

    const statusStyle = {
      marginTop: 8,
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const errorStyle = {
      marginTop: 8,
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-state-error-primary)',
      overflowWrap: 'anywhere',
    }

    const countPillStyle = {
      fontSize: 12,
      lineHeight: '18px',
      padding: '0 8px',
      borderRadius: 999,
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      flex: 'none',
    }

    const listStyle = {
      overflowY: 'auto',
      maxHeight: 'min(48vh, 420px)',
      padding: '4px 20px 8px',
      margin: 0,
      listStyle: 'none',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    }

    const rowMainStyle = {
      flex: 1,
      minWidth: 0,
    }

    const rowTitleStyle = {
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const rowMetaStyle = {
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const warnBarStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      margin: '0 20px 4px',
      padding: '8px 12px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-warn-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-state-warn-primary)',
      fontSize: 12,
      lineHeight: '18px',
    }

    function disabled(style, isDisabled) {
      return isDisabled ? { ...style, opacity: 0.5, cursor: 'default' } : style
    }

    // --- glyphs ---------------------------------------------------------------

    const TRASH_PATH =
      'M14.478 4.841l-.264 5.274c-.104 2.072-.147 2.896-.827 3.846a4.16 4.16 0 0 1-1.045 1.011c-.518.334-1.1.478-1.783.547-.671.067-1.509.066-2.558.066s-1.887-.001-2.559-.066c-.683-.069-1.265-.213-1.784-.547a4.16 4.16 0 0 1-1.044-1.011c-.68-.95-.724-1.774-.827-3.846L1.522 4.841l1.368-.068.263 5.273c.11 2.176.172 2.556.574 3.117.182.254.41.471.673.64.262.17.603.277 1.179.335.587.058 1.344.059 2.421.059s1.835-.001 2.422-.059c.576-.058.916-.165 1.179-.334.262-.169.491-.387.673-.64.402-.561.464-.941.573-3.117l.264-5.273 1.368.068zM5.43 6.228h1.37v5.163H5.43V6.228zm3.771 0h1.37v5.163h-1.37V6.228zM8.536.434c.644 0 1.116-.007 1.56.137.14.045.276.102.406.168.416.212.744.552 1.2 1.007l.796.795h2.876v1.37H.626v-1.37h2.876l.796-.795C4.754 1.291 5.082.951 5.498.739c.13-.066.266-.123.405-.168C6.348.427 6.82.434 7.464.434h1.072zm-1.072 1.37c-.732 0-.948.007-1.138.069a1.9 1.9 0 0 0-.206.085c-.156.08-.297.204-.679.582h5.117c-.382-.378-.522-.502-.678-.582a1.9 1.9 0 0 0-.206-.085c-.19-.062-.406-.069-1.138-.069H7.464z'

    function TrashIcon({ size = 16 }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { flex: 'none', display: 'block' },
        },
        React.createElement('path', { d: TRASH_PATH, fill: 'currentColor' }),
      )
    }

    // --- formatting -----------------------------------------------------------

    function formatDeletedAt(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      } catch {
        return date.toLocaleString()
      }
    }

    function messageOf(reason) {
      return reason && reason.message ? reason.message : String(reason)
    }

    // --- host calls -----------------------------------------------------------

    // One request shape for every route: the Host always answers JSON, and a
    // non-2xx answer always carries `error`, so the message survives to the UI.
    async function request(method, path, body) {
      const init = { method, headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(BASE + path, init)
      } catch (reason) {
        throw new Error(messageOf(reason))
      }
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        /* keep {} so the status decides */
      }
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      }
      return payload
    }

    async function loadBin() {
      binStatus = 'loading'
      notify()
      try {
        const payload = await request('GET', '/trash')
        binEntries = Array.isArray(payload.entries) ? payload.entries : []
        binError = null
      } catch (reason) {
        binError = messageOf(reason)
      }
      binStatus = 'ready'
      notify()
    }

    function openBin() {
      binOpen = true
      notify()
      // Always re-read: the bin can be changed from another window, or by the
      // Harness's own archived view.
      loadBin()
    }

    function closeBin() {
      binOpen = false
      notify()
    }

    // --- the two triggers -----------------------------------------------------

    function BinMenuItem(props) {
      const t = tOf(props)
      const { sessionId, displayTitle } = props
      // Supplied by the slot owner (ui-workspace) for this menu.
      const menu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
      const [hover, setHover] = React.useState(false)

      const onSelect = React.useCallback(() => {
        if (menu && typeof menu[1] === 'function') menu[1](false)
        publish({ sessionId, title: displayTitle || '', running: undefined })
      }, [menu, sessionId, displayTitle])

      if (!sessionId) return null

      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          'data-session-purge': 'menu',
          style: hover ? { ...menuRowStyle, background: 'var(--dsw-alias-bg-layer-2)' } : menuRowStyle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: onSelect,
        },
        React.createElement(TrashIcon, { size: 14 }),
        React.createElement('span', null, t('menu.delete')),
      )
    }

    function BinHeaderButton(props) {
      const t = tOf(props)
      const { sessionId } = props

      // The Session list snapshot carries the display title and run state.
      let summary
      if (typeof props.useSessions === 'function') {
        summary = props.useSessions((snapshot) => (snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined))
      } else if (sessionsService && sessionsService.list) {
        const snapshot = sessionsService.list.getSnapshot()
        summary = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined
      }
      const running = summary ? summary.running === true : undefined
      const title = summary ? summary.displayTitle || summary.title || '' : ''

      const onClick = React.useCallback(() => {
        publish({ sessionId, title, running })
      }, [sessionId, title, running])

      if (!sessionId) return null

      return React.createElement(
        'button',
        {
          type: 'button',
          title: running ? t('button.titleRunning') : t('button.title'),
          'aria-label': t('button.title'),
          'data-session-purge': 'header',
          style: { ...iconButtonStyle, color: 'var(--dsw-alias-state-error-primary)' },
          onClick,
        },
        React.createElement(TrashIcon, { size: 16 }),
      )
    }

    // --- the footer entry -----------------------------------------------------

    function BinFooterButton(props) {
      const t = tOf(props)
      const state = useStore(() => ({ count: binEntries.length, status: binStatus }))
      const wide = props && props.wide === true
      const asked = React.useRef(false)

      React.useEffect(() => {
        if (asked.current) return
        asked.current = true
        // The badge is part of the first paint, so the count is requested as
        // soon as the footer exists rather than on the first open.
        if (binStatus === 'idle') loadBin()
      }, [])

      const [hover, setHover] = React.useState(false)

      const icon = React.createElement(
        'span',
        { style: { position: 'relative', display: 'inline-flex', flex: 'none' } },
        React.createElement(TrashIcon, { size: 16 }),
        state.count > 0
          ? React.createElement('span', {
              'aria-hidden': true,
              style: {
                position: 'absolute',
                top: -3,
                right: -4,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--dsw-alias-state-error-primary)',
              },
            })
          : null,
      )

      const label =
        state.count > 0
          ? `${t('footer.label')} ${state.count}`
          : t('footer.label')

      const baseStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: 8,
        height: 32,
        padding: wide ? '0 8px' : 0,
        width: wide ? 'auto' : 32,
        maxWidth: '100%',
        border: 'none',
        borderRadius: 8,
        background: hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        cursor: 'pointer',
        flex: 'none',
      }

      return React.createElement(
        'button',
        {
          type: 'button',
          'data-session-purge': 'footer',
          title: `${t('footer.countTitle')} ${state.count}`,
          'aria-label': `${t('footer.label')} (${state.count})`,
          style: baseStyle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: openBin,
        },
        icon,
        wide
          ? React.createElement(
              'span',
              {
                style: {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              label,
            )
          : null,
      )
    }

    // --- the move-to-bin confirm ----------------------------------------------

    function BinDialog(props) {
      const t = tOf(props)
      const current = useStore(() => pending)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const open = current !== null

      // A fresh request always starts clean.
      React.useEffect(() => {
        if (open) {
          setError(null)
          setBusy(false)
        }
      }, [open, current && current.sessionId])

      const close = React.useCallback(() => {
        setBusy((wasBusy) => {
          if (!wasBusy) publish(null)
          return wasBusy
        })
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, close])

      const confirm = React.useCallback(async () => {
        if (!current || busy) return
        setBusy(true)
        setError(null)
        try {
          const requested = current
          await request('POST', '/trash', { sessionId: requested.sessionId, title: requested.title })
          publish(null)
          await loadBin()
          await refreshSessionList({ handoff: requested.sessionId })
        } catch (reason) {
          setBusy(false)
          setError(messageOf(reason))
        }
      }, [current, busy])

      if (!open) return null

      const name = current.title || t('dialog.untitled')
      const running = current.running === true

      return React.createElement(
        'div',
        {
          style: backdropStyle,
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        React.createElement(
          'div',
          {
            role: 'dialog',
            'aria-modal': true,
            'aria-label': t('dialog.title'),
            'data-session-purge': 'dialog',
            style: cardStyle,
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement('h2', { style: titleStyle }, t('dialog.title')),
          React.createElement(
            'p',
            { style: metaStyle },
            t('dialog.nameLabel'),
            ': ',
            name,
            React.createElement('br'),
            t('dialog.idLabel'),
            ': ',
            current.sessionId,
          ),
          React.createElement('p', { style: bodyStyle }, t('dialog.desc')),
          running ? React.createElement('p', { style: warnStyle }, t('dialog.running')) : null,
          busy ? React.createElement('div', { style: statusStyle }, t('dialog.busy')) : null,
          error
            ? React.createElement('div', { style: errorStyle, role: 'alert' }, `${t('dialog.failed')}: ${error}`)
            : null,
          React.createElement(
            'div',
            { style: footerStyle },
            React.createElement(
              'button',
              {
                type: 'button',
                style: disabled(cancelButtonStyle, busy),
                disabled: busy,
                onClick: close,
              },
              t('dialog.cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                'data-session-purge': 'dialog-confirm',
                style: disabled(dangerButtonStyle, busy),
                disabled: busy,
                onClick: confirm,
              },
              busy ? t('dialog.busy') : t('dialog.confirm'),
            ),
          ),
        ),
      )
    }

    // --- the bin itself -------------------------------------------------------

    function BinPanel(props) {
      const t = tOf(props)
      const state = useStore(() => ({ open: binOpen, entries: binEntries, status: binStatus, error: binError }))
      const [busy, setBusy] = React.useState(null) // sessionId | 'empty' | null
      const [armed, setArmed] = React.useState(null) // sessionId awaiting a second click
      const [confirmEmpty, setConfirmEmpty] = React.useState(false)
      const [error, setError] = React.useState(null)
      const timer = React.useRef(null)

      const disarm = React.useCallback(() => {
        if (timer.current) {
          clearTimeout(timer.current)
          timer.current = null
        }
        setArmed(null)
      }, [])

      React.useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current)
        },
        [],
      )

      React.useEffect(() => {
        if (!state.open) {
          disarm()
          setConfirmEmpty(false)
          setError(null)
          return undefined
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          // Escape backs out of a pending confirmation FIRST and only closes the
          // panel when nothing is pending: an armed permanent delete must never
          // be a state the user cannot leave.
          if (armed !== null) {
            disarm()
            return
          }
          if (confirmEmpty) {
            setConfirmEmpty(false)
            return
          }
          closeBin()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [state.open, armed, confirmEmpty, disarm])

      // Arm a row's permanent delete. A second click within the window commits,
      // which keeps the irreversible action two gestures away without raising a
      // second modal on top of the panel.
      const arm = React.useCallback(
        (sessionId) => {
          if (timer.current) clearTimeout(timer.current)
          setArmed(sessionId)
          timer.current = setTimeout(() => {
            timer.current = null
            setArmed(null)
          }, CONFIRM_WINDOW_MS)
        },
        [],
      )

      const purge = React.useCallback(
        async (sessionId) => {
          if (busy) return
          setBusy(sessionId)
          setError(null)
          disarm()
          try {
            await request('POST', '/purge', { sessionId })
            await loadBin()
            await refreshSessionList({ handoff: sessionId })
          } catch (reason) {
            setError(messageOf(reason))
          }
          setBusy(null)
        },
        [busy, disarm],
      )

      const restore = React.useCallback(
        async (sessionId) => {
          if (busy) return
          setBusy(sessionId)
          setError(null)
          disarm()
          try {
            await request('POST', '/restore', { sessionId })
            await loadBin()
            await refreshSessionList({})
          } catch (reason) {
            setError(messageOf(reason))
          }
          setBusy(null)
        },
        [busy, disarm],
      )

      const emptyAll = React.useCallback(async () => {
        if (busy) return
        setBusy('empty')
        setError(null)
        try {
          const payload = await request('POST', '/empty')
          setConfirmEmpty(false)
          await loadBin()
          await refreshSessionList({})
          if (Array.isArray(payload.failed) && payload.failed.length > 0) {
            setError(t('panel.partialFailed'))
          }
        } catch (reason) {
          setError(messageOf(reason))
        }
        setBusy(null)
      }, [busy, t])

      if (!state.open) return null

      const entries = state.entries
      const count = entries.length

      const rows = entries.map((entry) => {
        const id = entry.sessionId
        const rowBusy = busy === id || busy === 'empty'
        const isArmed = armed === id
        return React.createElement(
          'li',
          { key: id, style: rowStyle, 'data-session-purge': 'trash-row' },
          React.createElement(
            'div',
            { style: rowMainStyle },
            React.createElement(
              'div',
              { style: rowTitleStyle, title: entry.title || t('panel.untitled') },
              entry.title || t('panel.untitled'),
            ),
            React.createElement(
              'div',
              { style: rowMetaStyle },
              `${t('panel.deletedAt')} ${formatDeletedAt(entry.deletedAt) || '\u2014'}`,
            ),
          ),
          // While a row is armed, its leading button becomes the way OUT of that
          // state, so a permanent delete is always one click from being called
          // off. It takes the restore button's place rather than adding a third
          // control: the row keeps its width, and the same finger position now
          // means "back off" instead of "restore" — the safe direction.
          isArmed
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  'data-session-purge': 'trash-cancel',
                  style: disabled(subtleButtonStyle, rowBusy),
                  disabled: rowBusy,
                  onClick: disarm,
                },
                t('panel.cancel'),
              )
            : React.createElement(
                'button',
                {
                  type: 'button',
                  'data-session-purge': 'trash-restore',
                  style: disabled(subtleButtonStyle, rowBusy),
                  disabled: rowBusy,
                  onClick: () => restore(id),
                },
                busy === id ? t('panel.restoring') : t('panel.restore'),
              ),
          React.createElement(
            'button',
            {
              type: 'button',
              'data-session-purge': 'trash-purge',
              'data-armed': isArmed ? 'true' : 'false',
              style: disabled(isArmed ? dangerButtonStyle : rowDangerButtonStyle, rowBusy),
              disabled: rowBusy,
              onClick: () => (isArmed ? purge(id) : arm(id)),
            },
            busy === id ? t('panel.purging') : isArmed ? t('panel.purgeConfirm') : t('panel.purge'),
          ),
        )
      })

      return React.createElement(
        'div',
        {
          style: backdropStyle,
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeBin()
          },
        },
        React.createElement(
          'div',
          {
            role: 'dialog',
            'aria-modal': true,
            'aria-label': t('panel.title'),
            'data-session-purge': 'trash-panel',
            style: binCardStyle,
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement(
            'div',
            { style: binHeaderStyle },
            React.createElement('h2', { style: { ...titleStyle, margin: 0, flex: '1 1 auto' } }, t('panel.title')),
            React.createElement('span', { style: countPillStyle }, `${t('panel.count')} ${count} ${t('panel.countUnit')}`.trim()),
          ),
          React.createElement(
            'p',
            { style: { ...bodyStyle, margin: '6px 20px 0' } },
            t('panel.subtitle'),
          ),
          count === 0
            ? React.createElement(
                'div',
                { style: { padding: '22px 20px 26px', textAlign: 'center' } },
                React.createElement(
                  'div',
                  { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
                  t('panel.empty'),
                ),
                React.createElement(
                  'div',
                  { style: { ...rowMetaStyle, marginTop: 6 } },
                  t('panel.emptyHint'),
                ),
              )
            : React.createElement('ul', { style: listStyle }, rows),
          state.error
            ? React.createElement('div', { style: { ...errorStyle, margin: '0 20px' }, role: 'alert' }, state.error)
            : null,
          error
            ? React.createElement('div', { style: { ...errorStyle, margin: '0 20px' }, role: 'alert' }, `${t('panel.failed')}: ${error}`)
            : null,
          confirmEmpty
            ? React.createElement(
                'div',
                { style: warnBarStyle },
                React.createElement('span', { style: { flex: '1 1 auto' } }, t('panel.confirmEmpty')),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    'data-session-purge': 'trash-empty-confirm',
                    style: disabled(dangerButtonStyle, busy === 'empty'),
                    disabled: busy === 'empty',
                    onClick: emptyAll,
                  },
                  busy === 'empty' ? t('panel.emptying') : t('panel.confirmEmptyYes'),
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: disabled(subtleButtonStyle, busy === 'empty'),
                    disabled: busy === 'empty',
                    onClick: () => setConfirmEmpty(false),
                  },
                  t('dialog.cancel'),
                ),
              )
            : null,
          React.createElement(
            'div',
            { style: { ...footerStyle, margin: '12px 20px 18px' } },
            count > 0
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    'data-session-purge': 'trash-empty',
                    style: disabled(rowDangerButtonStyle, busy !== null || confirmEmpty),
                    disabled: busy !== null || confirmEmpty,
                    onClick: () => setConfirmEmpty(true),
                  },
                  t('panel.emptyBin'),
                )
              : null,
            React.createElement(
              'button',
              { type: 'button', 'data-session-purge': 'trash-close', style: cancelButtonStyle, onClick: closeBin },
              t('panel.close'),
            ),
          ),
        ),
      )
    }

    // --- apply ----------------------------------------------------------------

    // The Client Session service: used for the header button's title/run state
    // and for the in-place list refresh after every mutation.
    let sessionsService = null
    let clientCtx = null

    // Refresh the sidebar in place — no page reload. The Client Session service
    // exposes `refresh()`; older builds exposed `refreshList()`. `handoff` is the
    // Session that just left the list: when it was the one on screen, the
    // workspace UI service (which owns Session selection) opens the next one.
    async function refreshSessionList(options) {
      const handoff = options && options.handoff
      const service = sessionsService
      try {
        let wasCurrent = false
        if (handoff && service && service.list) {
          const before = service.list.getSnapshot()
          wasCurrent =
            before && before.byId && before.byId[handoff]
              ? (before.byId[handoff].retainedBy?.mainView ?? 0) > 0
              : false
        }

        if (service && typeof service.refresh === 'function') {
          await service.refresh()
        } else if (service && typeof service.refreshList === 'function') {
          await service.refreshList()
        } else {
          window.location.reload()
          return
        }

        if (!wasCurrent) return
        const snapshot = service.list.getSnapshot()
        const ids = (snapshot && snapshot.ids) || []
        const next = ids.find((id) => id !== handoff)
        const uiWorkspace =
          clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null
        if (next && uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(next)
        }
      } catch {
        /* the mutation succeeded; a refresh hiccup is not a failure of it */
      }
    }

    function apply(ctx) {
      clientCtx = ctx
      sessionsService = ctx.get('sessions') || null
      if (!sessionsService) {
        ctx.inject(['sessions'], (sub) => {
          sessionsService = sub.sessions
        })
      }

      // Dictionaries follow the Client's active language. A missing locale
      // service is not fatal: the components fall back to the built-in copy.
      localeService = ctx.get('locale') || null
      if (localeService) {
        ctx.effect(() => localeService.register(NS, { zh, en }), 'session-purge: dictionaries')
      } else {
        ctx.inject(['locale'], (sub) => {
          localeService = sub.locale
          ctx.effect(() => localeService.register(NS, { zh, en }), 'session-purge: dictionaries')
        })
      }

      // `locale: NS` is what hands each occupant its `t` seat; when the
      // service is absent the components use the built-in dictionary.
      const localeSeat = () => (localeService ? { locale: NS } : {})

      ctx.slots.inject(MENU_SLOT, () =>
        ctx.slots.register({ name: MENU_SLOT, id: ID_MENU, order: 500, ...localeSeat() }, BinMenuItem),
      )

      ctx.slots.inject(HEADER_SLOT, () =>
        ctx.slots.register({ name: HEADER_SLOT, id: ID_HEADER, order: 30, ...localeSeat() }, BinHeaderButton),
      )

      ctx.slots.inject(FOOTER_SLOT, () =>
        ctx.slots.register({ name: FOOTER_SLOT, id: ID_FOOTER, order: 10, ...localeSeat() }, BinFooterButton),
      )

      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register({ name: OVERLAY_SLOT, id: ID_DIALOG, order: 100, ...localeSeat() }, BinDialog),
      )

      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register({ name: OVERLAY_SLOT, id: ID_PANEL, order: 110, ...localeSeat() }, BinPanel),
      )
    }

    return { name: 'session-purge', inject: ['slots'], apply }
  },
})
