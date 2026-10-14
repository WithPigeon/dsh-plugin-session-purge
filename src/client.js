// dsh-plugin-session-purge — CLIENT half.
//
// Registers three slot occupants that together delete a Session permanently:
//
//   sidebar.workspaces.session.menu.item  id 'session-purge', order 500
//       A "Delete session" row in the Session row's "..." menu, beside the
//       shipped pin/rename/fork/archive rows. It receives the row's
//       `sessionId` + `displayTitle` owner props and the menu's
//       `useMenuOpenState` hook, so it never has to guess which Session the
//       menu belongs to and never switches the conversation.
//
//   conversation.session.header.actions   id 'session-purge', order 30
//       A trash button beside the Session title for the open Session.
//
//   shell.overlay                         id 'session-purge-dialog'
//       The one risk-consent dialog both entry points raise. It is a
//       frame-wide overlay occupant, and the only thing that talks to the
//       Host.
//
// Host protocol (registered by the package's Host half):
//   POST /__session-purge/purge   { sessionId } -> { ok, ...report }
//
// Deliberate constraints, per the Cordis plugin guide:
//   * plain React only — no Harness Client package (no ui-primitives) is
//     imported, so the bundle cannot break on a Client package version bump;
//     the trash glyph is an inline SVG and the dialog is plain markup.
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
    const OVERLAY_SLOT = 'shell.overlay'

    const ID_MENU = 'session-purge'
    const ID_HEADER = 'session-purge'
    const ID_DIALOG = 'session-purge-dialog'

    const ENDPOINT = '/__session-purge/purge'

    // --- dictionaries ---------------------------------------------------------

    const zh = {
      'menu.delete': '彻底删除会话',
      'button.title': '彻底删除会话',
      'button.titleRunning': '彻底删除会话（运行中，删除会先停止任务）',

      'dialog.title': '彻底删除会话',
      'dialog.nameLabel': '会话',
      'dialog.idLabel': '会话 ID',
      'dialog.untitled': '未命名会话',

      'dialog.desc': '将永久删除该会话的日志、投影缓存与工作区记账。此操作不可恢复。',
      'dialog.running': '该会话正在运行。删除会先停止它的任务，进行中的工作将立即中断且无法恢复。',
      'dialog.notFound': '没有找到这个会话，它可能已经被删除。请刷新会话列表后重试。',

      'dialog.ack': '我已了解后果，确认彻底删除',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.busy': '正在删除…',
      'dialog.deleted': '已彻底删除',
      'dialog.failed': '删除失败',
    }

    const en = {
      'menu.delete': 'Delete session permanently',
      'button.title': 'Delete session permanently',
      'button.titleRunning': 'Delete session permanently (running — its task is stopped first)',

      'dialog.title': 'Delete session permanently',
      'dialog.nameLabel': 'Session',
      'dialog.idLabel': 'Session ID',
      'dialog.untitled': 'Untitled session',

      'dialog.desc': 'Permanently deletes this session\u2019s log, projection cache and workspace accounting. This cannot be undone.',
      'dialog.running': 'This session is running. Deleting it stops its task first; work in progress is interrupted and cannot be recovered.',
      'dialog.notFound': 'This session was not found — it may already be deleted. Refresh the session list and try again.',

      'dialog.ack': 'I understand the consequences \u2014 delete permanently',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.busy': 'Deleting\u2026',
      'dialog.deleted': 'Permanently deleted',
      'dialog.failed': 'Delete failed',
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

    // --- pending-request store ------------------------------------------------
    //
    // One module-level cell shared by the two triggers and the dialog. The
    // triggers only publish; the overlay occupant renders from it. This keeps
    // the dialog in exactly one place without inventing cross-slot plumbing.

    let pending = null
    const listeners = new Set()

    function publish(next) {
      pending = next
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

    function usePending() {
      const [value, setValue] = React.useState(pending)
      React.useEffect(() => subscribe(() => setValue(pending)), [])
      return value
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

    const ackStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      margin: '4px 0 0',
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
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

    function disabled(style, isDisabled) {
      return isDisabled ? { ...style, opacity: 0.5, cursor: 'default' } : style
    }

    // --- glyph ----------------------------------------------------------------

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

    // --- host call ------------------------------------------------------------

    async function callPurge(sessionId) {
      let response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } catch (reason) {
        throw new Error(reason && reason.message ? reason.message : String(reason))
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

    // --- entry points ---------------------------------------------------------

    function PurgeMenuItem(props) {
      const t = tOf(props)
      const { sessionId, displayTitle } = props
      // Supplied by the slot owner (ui-workspace) for this menu.
      const menu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
      const [hover, setHover] = React.useState(false)

      const onSelect = React.useCallback(() => {
        if (menu && typeof menu[1] === 'function') menu[1](false)
        publish({ sessionId, title: displayTitle || '', running: undefined, phase: 'confirm' })
      }, [menu, sessionId, displayTitle])

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

    function PurgeHeaderButton(props) {
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
        publish({ sessionId, title, running, phase: 'confirm' })
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

    function PurgeDialog(props) {
      const t = tOf(props)
      const request = usePending()
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const open = request !== null && request.phase === 'confirm'

      // A fresh request always starts unacknowledged.
      React.useEffect(() => {
        if (open) {
          setAcknowledged(false)
          setError(null)
          setBusy(false)
        }
      }, [open, request && request.sessionId])

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
        if (!request || !acknowledged || busy) return
        setBusy(true)
        setError(null)
        try {
          await callPurge(request.sessionId)
          publish(null)
          await refreshAfterPurge(request.sessionId)
        } catch (reason) {
          setBusy(false)
          setError(reason && reason.message ? reason.message : String(reason))
        }
      }, [request, acknowledged, busy])

      if (!open) return null

      const name = request.title || t('dialog.untitled')
      const running = request.running === true

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
            request.sessionId,
          ),
          React.createElement('p', { style: bodyStyle }, t('dialog.desc')),
          running ? React.createElement('p', { style: warnStyle }, t('dialog.running')) : null,
          React.createElement(
            'label',
            { style: ackStyle },
            React.createElement('input', {
              type: 'checkbox',
              checked: acknowledged,
              disabled: busy,
              onChange: (event) => setAcknowledged(event.target.checked),
            }),
            React.createElement('span', null, t('dialog.ack')),
          ),
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
                style: disabled(dangerButtonStyle, busy || !acknowledged),
                disabled: busy || !acknowledged,
                onClick: confirm,
              },
              busy ? t('dialog.busy') : t('dialog.confirm'),
            ),
          ),
        ),
      )
    }

    // --- apply ----------------------------------------------------------------

    // The Client Session service: used for the header button's title/run state
    // and for the in-place list refresh after a delete.
    let sessionsService = null
    let clientCtx = null

    // Refresh the sidebar in place after a successful delete — no page reload.
    // The Client Session service exposes `refresh()`; older builds exposed
    // `refreshList()`. If the deleted Session was the one on screen, hand off
    // to the workspace UI service, which owns Session selection (there is no
    // `open()` on the sessions service itself).
    async function refreshAfterPurge(deletedId) {
      const service = sessionsService
      try {
        const before = service && service.list ? service.list.getSnapshot() : null
        const wasCurrent =
          before && before.byId && before.byId[deletedId]
            ? (before.byId[deletedId].retainedBy?.mainView ?? 0) > 0
            : false

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
        const next = ids.find((id) => id !== deletedId)
        const uiWorkspace =
          clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null
        if (next && uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(next)
        }
      } catch {
        /* the delete succeeded; a refresh hiccup is not a delete failure */
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
        ctx.slots.register(
          { name: MENU_SLOT, id: ID_MENU, order: 500, ...localeSeat() },
          PurgeMenuItem,
        ),
      )

      ctx.slots.inject(HEADER_SLOT, () =>
        ctx.slots.register(
          { name: HEADER_SLOT, id: ID_HEADER, order: 30, ...localeSeat() },
          PurgeHeaderButton,
        ),
      )

      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register(
          { name: OVERLAY_SLOT, id: ID_DIALOG, order: 100, ...localeSeat() },
          PurgeDialog,
        ),
      )
    }

    return { name: 'session-purge', inject: ['slots'], apply }
  },
})
