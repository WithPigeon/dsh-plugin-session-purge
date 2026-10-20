// Verification harness for dsh-plugin-session-purge's CLIENT half.
//
// The Host half has real coverage in verify-session-purge.mjs, but every UI
// failure mode here is invisible to it: a renamed hook, a slot key that no
// longer exists, an occupant that throws on its first render. Those only surface
// in a browser, which makes them expensive to find. So this loads the real
// bundle the way the module loader does, runs the real `apply()`, and renders
// every occupant to prove the trees build and the copy is right.
//
// The React stub is deliberately small but NOT stateless: `useState`/`useRef`
// persist per component across renders, so state transitions (the two-step
// permanent delete, the empty-all confirm) are exercised here too. Effects are
// not run, so nothing fetches unless a rendered handler is invoked on purpose.
//
// It does not claim the result LOOKS right — only that the wiring and the
// interaction logic are sound.
//
//   node verify-client-half.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, 'src', 'client.js'), 'utf8')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// --- a React stub just real enough to render and to keep state --------------

function createElement(type, props, ...children) {
  return { type, props: props || {}, children }
}

// Hook slots live per component function. Every hooks-consuming call takes the
// next index, so the order must stay stable across renders — the same contract
// React enforces with its rules of hooks.
const hookStores = new WeakMap()
let currentStore = null
let hookCursor = 0

function initialValue(initial) {
  return typeof initial === 'function' ? initial() : initial
}

const ReactStub = {
  createElement,
  useState(initial) {
    const store = currentStore
    const index = hookCursor++
    if (!store) return [initialValue(initial), () => {}]
    if (!(index in store)) store[index] = initialValue(initial)
    const set = (next) => {
      store[index] = typeof next === 'function' ? next(store[index]) : next
    }
    return [store[index], set]
  },
  useRef(initial) {
    const store = currentStore
    const index = hookCursor++
    if (!store) return { current: initial }
    if (!(index in store)) store[index] = { current: initial }
    return store[index]
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useEffect() {},
  useLayoutEffect() {},
}

function render(component, props) {
  let store = hookStores.get(component)
  if (!store) {
    store = {}
    hookStores.set(component, store)
  }
  currentStore = store
  hookCursor = 0
  try {
    return component(props)
  } finally {
    currentStore = null
  }
}

// --- load the bundle exactly as the module loader does -----------------------

let definition = null
globalThis.window = {
  location: { reload() {} },
  __ModuleLoader__: {
    load(candidate) {
      definition = candidate
    },
  },
}

vm.runInThisContext(source, { filename: 'src/client.js' })

check('bundle: __ModuleLoader__.load called', definition !== null)
check(
  'bundle: id is the package name',
  Boolean(definition) && definition.id === 'dsh-plugin-session-purge',
  definition && definition.id,
)
check('bundle: factory is exported', Boolean(definition) && typeof definition.factory === 'function')

if (!definition) {
  console.log('\n0/1 checks passed')
  process.exit(1)
}

const half = definition.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error(`unexpected require('${id}')`)
})

check('half: name', half && half.name === 'session-purge', half && half.name)
check(
  'half: inject declares slots',
  Boolean(half) && Array.isArray(half.inject) && half.inject.includes('slots'),
  half && JSON.stringify(half.inject),
)
check('half: apply is a function', Boolean(half) && typeof half.apply === 'function')

// --- run apply() against a slot registry ------------------------------------

const registrations = []
const ctx = {
  get: () => undefined,
  inject() {},
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject(_key, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
    registerFactory() {
      return () => {}
    },
  },
}

half.apply(ctx)

const EXPECTED_SLOTS = [
  { name: 'sidebar.workspaces.session.menu.item', id: 'session-purge', order: 500 },
  { name: 'conversation.session.header.actions', id: 'session-purge', order: 30 },
  { name: 'sidebar.footer.action', id: 'session-purge-trash', order: 10 },
  { name: 'shell.overlay', id: 'session-purge-dialog', order: 100 },
  { name: 'shell.overlay', id: 'session-purge-trash-panel', order: 110 },
]

const describe = (entry) => `${entry.options.name}#${entry.options.id}`
check(
  'slots: five occupants registered',
  registrations.length === EXPECTED_SLOTS.length,
  registrations.map(describe).join(', '),
)
for (const expected of EXPECTED_SLOTS) {
  const found = registrations.find(
    (entry) => entry.options.name === expected.name && entry.options.id === expected.id,
  )
  check(
    `slot: ${expected.name}#${expected.id} at order ${expected.order}`,
    Boolean(found) && found.options.order === expected.order,
    found ? `order=${found.options.order}` : 'missing',
  )
}

const componentOn = (name, id) =>
  registrations.find((entry) => entry.options.name === name && entry.options.id === id).component

const MenuItem = componentOn('sidebar.workspaces.session.menu.item', 'session-purge')
const HeaderButton = componentOn('conversation.session.header.actions', 'session-purge')
const Footer = componentOn('sidebar.footer.action', 'session-purge-trash')
const Dialog = componentOn('shell.overlay', 'session-purge-dialog')
const Panel = componentOn('shell.overlay', 'session-purge-trash-panel')

// --- tree inspection --------------------------------------------------------

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (typeof node === 'object' && node.type !== undefined) {
    visit(node)
    walk(node.children, visit)
  }
}

function textOf(tree) {
  const parts = []
  walk(tree, (item) => {
    if (item.text !== undefined) parts.push(item.text)
  })
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function attrs(tree, name) {
  const found = []
  walk(tree, (item) => {
    if (item.props && item.props[name] !== undefined) found.push(item.props[name])
  })
  return found
}

function elements(tree) {
  return (() => {
    const found = []
    walk(tree, (item) => {
      if (item.text === undefined) found.push(item)
    })
    return found
  })()
}

const byMarker = (tree, marker) =>
  elements(tree).filter((item) => item.props && item.props['data-session-purge'] === marker)

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'

// --- the menu row -----------------------------------------------------------

{
  const tree = render(MenuItem, { sessionId: SESSION_ID, displayTitle: '一个会话' })
  check('menu: renders a menuitem', attrs(tree, 'role').includes('menuitem'), attrs(tree, 'role').join(','))
  check('menu: wears its own marker', attrs(tree, 'data-session-purge').includes('menu'))
  check('menu: says "move to recycle bin"', textOf(tree).includes('移到回收站'), textOf(tree))
  check('menu: renders nothing without an id', render(MenuItem, {}) === null)
}

// --- the header button ------------------------------------------------------

{
  const tree = render(HeaderButton, { sessionId: SESSION_ID })
  check('header: wears its own marker', attrs(tree, 'data-session-purge').includes('header'))
  check(
    'header: has an accessible name',
    attrs(tree, 'aria-label').some((label) => String(label).includes('回收站')),
  )
  check('header: renders nothing without an id', render(HeaderButton, {}) === null)
}

// --- the footer entry -------------------------------------------------------

{
  const rail = render(Footer, { wide: false })
  const wide = render(Footer, { wide: true })
  check('footer: wears its own marker', attrs(rail, 'data-session-purge').includes('footer'))
  check('footer: rail shows no label text', !textOf(rail).includes('回收站'), textOf(rail) || '(no text)')
  check('footer: wide shows the label', textOf(wide).includes('回收站'), textOf(wide))
  check(
    'footer: counts in the accessible name',
    attrs(rail, 'aria-label').some((label) => String(label).includes('0')),
    attrs(rail, 'aria-label').join(','),
  )
}

// --- the confirm dialog -----------------------------------------------------
//
// Opening it is what the header button does on click, so the click is the test.

{
  check('dialog: closed by default', render(Dialog, {}) === null)

  render(HeaderButton, { sessionId: SESSION_ID }).props.onClick()
  const tree = render(Dialog, {})
  check(
    'dialog: opens from the header button',
    tree !== null && attrs(tree, 'data-session-purge').includes('dialog'),
  )
  check('dialog: names the session id', textOf(tree).includes(SESSION_ID))
  check('dialog: explains the bin is reversible', textOf(tree).includes('恢复'), textOf(tree))
  check('dialog: confirm button is reachable', attrs(tree, 'data-session-purge').includes('dialog-confirm'))
}

// --- the bin panel ----------------------------------------------------------

let requested = []
globalThis.fetch = async (url) => {
  requested.push(url)
  return { ok: true, status: 200, json: async () => binPayload }
}
let binPayload = { ok: true, entries: [] }

{
  check('panel: closed by default', render(Panel, {}) === null)

  // The footer's click is the only way in, and it is what triggers the read.
  render(Footer, { wide: true }).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const empty = render(Panel, {})
  check(
    'panel: opens from the footer',
    empty !== null && attrs(empty, 'data-session-purge').includes('trash-panel'),
  )
  check('panel: shows the empty state', textOf(empty).includes('回收站是空的'), textOf(empty))
  check('panel: offers a close button', attrs(empty, 'data-session-purge').includes('trash-close'))
  check('panel: hides empty-all while empty', !attrs(empty, 'data-session-purge').includes('trash-empty'))

  binPayload = {
    ok: true,
    entries: [
      {
        sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444',
        title: '第一个会话',
        deletedAt: '2026-10-20T08:30:55.546Z',
      },
      {
        sessionId: 'session-bbbbbbbb-1111-2222-3333-444444444444',
        title: null,
        deletedAt: '2026-10-19T01:02:03.000Z',
      },
    ],
  }
  render(Footer, { wide: true }).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const filled = render(Panel, {})
  const markers = attrs(filled, 'data-session-purge')
  const rowMarkers = markers.filter((marker) => marker === 'trash-row').length
  check('panel: one row per entry', rowMarkers === 2, `rows=${rowMarkers}`)
  check('panel: every row can restore', markers.filter((marker) => marker === 'trash-restore').length === 2)
  check('panel: every row can purge', markers.filter((marker) => marker === 'trash-purge').length === 2)
  check('panel: offers empty-all once filled', markers.includes('trash-empty'))
  check('panel: shows the stored title', textOf(filled).includes('第一个会话'), textOf(filled))
  check('panel: falls back for an untitled session', textOf(filled).includes('未命名会话'), textOf(filled))
  check('panel: renders a deletion date', textOf(filled).includes('删除于'), textOf(filled))
  check(
    'panel: the date is humanised, not the raw ISO string',
    !textOf(filled).includes('2026-10-20T08:30:55.546Z'),
    textOf(filled),
  )
  check(
    'panel: the armed state is off until clicked',
    attrs(filled, 'data-armed').every((value) => value === 'false'),
  )

  // The two-step permanent delete is the one irreversible control in the panel,
  // so its "arm, then commit" contract is asserted explicitly.
  requested = []
  const purgeButtons = byMarker(filled, 'trash-purge')
  check('panel: purge buttons are buttons', purgeButtons.every((item) => item.type === 'button'))

  purgeButtons[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  check('panel: first click performs no request', requested.length === 0, requested.join(',') || '(none)')

  const armed = render(Panel, {})
  check(
    'panel: the armed row asks for confirmation',
    textOf(armed).includes('确认彻底删除'),
    textOf(armed),
  )
  check(
    'panel: only the armed row changes',
    attrs(armed, 'data-armed').filter((value) => value === 'true').length === 1,
    attrs(armed, 'data-armed').join(','),
  )

  // The armed state must be escapable. It takes the restore button's place, so
  // the armed row has exactly one leading control and it is the way out.
  check(
    'panel: the armed row offers a cancel',
    byMarker(armed, 'trash-cancel').length === 1,
    attrs(armed, 'data-session-purge').join(','),
  )
  check(
    'panel: the armed row trades restore for cancel',
    byMarker(armed, 'trash-restore').length === 1,
    `restore=${byMarker(armed, 'trash-restore').length} cancel=${byMarker(armed, 'trash-cancel').length}`,
  )

  requested = []
  byMarker(armed, 'trash-cancel')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const calledOff = render(Panel, {})
  check('panel: cancelling performs no request', requested.length === 0, requested.join(',') || '(none)')
  check(
    'panel: cancelling restores the plain buttons',
    byMarker(calledOff, 'trash-cancel').length === 0 &&
      byMarker(calledOff, 'trash-restore').length === 2 &&
      !textOf(calledOff).includes('确认彻底删除'),
    attrs(calledOff, 'data-session-purge').join(','),
  )

  // ...and arming again after a cancel still commits on the second click.
  byMarker(calledOff, 'trash-purge')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const rearmed = render(Panel, {})
  check('panel: re-arming works after a cancel', byMarker(rearmed, 'trash-cancel').length === 1)

  requested = []
  byMarker(rearmed, 'trash-purge')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    'panel: second click commits the permanent delete',
    requested.includes('/__session-purge/purge'),
    requested.join(',') || '(none)',
  )

  // Empty-all must also ask twice.
  requested = []
  const beforeEmpty = render(Panel, {})
  byMarker(beforeEmpty, 'trash-empty')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const confirming = render(Panel, {})
  check(
    'panel: empty-all asks before acting',
    requested.length === 0 && textOf(confirming).includes('不可恢复'),
    `requests=${requested.length}`,
  )
  check(
    'panel: empty-all exposes an explicit confirm',
    byMarker(confirming, 'trash-empty-confirm').length === 1,
  )
  byMarker(confirming, 'trash-empty-confirm')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    'panel: confirmed empty-all reaches the Host',
    requested.includes('/__session-purge/empty'),
    requested.join(',') || '(none)',
  )
}

// --- summary ----------------------------------------------------------------

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
