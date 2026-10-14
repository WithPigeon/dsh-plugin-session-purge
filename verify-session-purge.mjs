// Self-contained verification harness for dsh-plugin-session-purge's HOST half.
//
// It runs the real `apply()` and the real registered `session_purge` tool
// against a throwaway DSH_HOME beside this file and stub Cordis services,
// so the deletion chain is exercised end-to-end without touching the live
// ~/.dsh or any real Session.
//
//   node verify-session-purge.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// --- throwaway DSH home ------------------------------------------------------

const DSH = path.join(here, '.verify-dsh-home')
fs.rmSync(DSH, { recursive: true, force: true })
process.env.DSH_HOME = DSH

const SESSIONS = path.join(DSH, 'sessions')
const SLUG_A = '--C-project--'
const SLUG_B = '--D-project--'

const KNOWN = 'session-3e8013bf-3d99-49e4-a449-58d4a23851a4'
const ARCHIVED = 'session-5eaa7930-78b8-4146-b185-aba813c07c07'
const PINNED = 'session-f90d1a00-51c1-46e8-ae08-6332669ad777'
const LIVE = 'session-abcdef01-2345-6789-abcd-ef0123456789'
const UNKNOWN = '11111111-2222-3333-4444-555555555555'

function makeLogDir(slug, id) {
  const dir = path.join(SESSIONS, slug, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'fixture-log')
  return dir
}

const dirA = makeLogDir(SLUG_A, KNOWN)
const dirArchived = makeLogDir(SLUG_B, ARCHIVED)
const dirPinned = makeLogDir(SLUG_B, PINNED)
const dirLive = makeLogDir(SLUG_A, LIVE)

// --- stub services -----------------------------------------------------------

// In-memory stand-in for the projection-cache storage domain (per-record).
const projectionRows = new Map([
  [KNOWN, { rows: { title: { val: 'fixture' } } }],
  [ARCHIVED, { rows: {} }],
  [PINNED, { rows: {} }],
  [LIVE, { rows: {} }],
])
const projectionDeletes = []
const projectionDomain = {
  table: () => ({
    get: (key) => projectionRows.get(key),
    delete: async (key) => {
      projectionDeletes.push(key)
      if (!projectionRows.has(key)) return false
      projectionRows.delete(key)
      return true
    },
  }),
}

// Workspace registry stand-in (detachSession / unarchive / unpin).
const detachCalls = []
const workspaces = [
  { id: 'ws-a', sessionIds: [KNOWN, LIVE], path: 'C:\\a', detachSession: async (id) => detachCalls.push(id) },
  { id: 'ws-b', sessionIds: [ARCHIVED, PINNED], path: 'D:\\b', detachSession: async (id) => detachCalls.push(id) },
]
const archivedSessionIds = [ARCHIVED]
const pinnedSessionIds = [PINNED]
const workspaceRegistry = {
  list: () => workspaces,
  get archivedSessionIds() {
    return archivedSessionIds
  },
  get pinnedSessionIds() {
    return pinnedSessionIds
  },
  async unarchiveSession(id) {
    const at = archivedSessionIds.indexOf(id)
    if (at >= 0) archivedSessionIds.splice(at, 1)
  },
  async unpinSession(id) {
    const at = pinnedSessionIds.indexOf(id)
    if (at >= 0) pinnedSessionIds.splice(at, 1)
  },
}

// A live Session whose disposal writes back AFTER being detached — the exact
// race the re-sweep loop exists for. Each `detachEntered` schedules one
// resurrection of both the log directory and the projection row.
const sessionStore = new Map([[LIVE, { id: LIVE, session: {} }]])
let resurrections = 0
const sessionsService = {
  get: (id) => (sessionStore.has(id) ? { id } : undefined),
  flush: async () => true,
  store: sessionStore,
  detachEntered: (entry) => {
    sessionStore.delete(entry.id)
    resurrections += 1
    setTimeout(() => {
      fs.mkdirSync(path.join(SESSIONS, SLUG_A, entry.id), { recursive: true })
      fs.writeFileSync(path.join(SESSIONS, SLUG_A, entry.id, 'session.v4.jsonl.zstd'), 'recreated')
      projectionRows.set(entry.id, { rows: {} })
    }, 120)
  },
}

let captured = null
const registeredRoutes = []

const services = {
  workspaceRegistry,
  storageDomain: { get: (name) => (name === 'session_projcache' ? projectionDomain : undefined) },
  sessions: sessionsService,
  agents: undefined,
  webServer: {
    register: (route) => {
      registeredRoutes.push(route)
      return () => {}
    },
  },
}

const ctx = {
  // The plugin declares `inject = ['tools']`, so it reaches the registry as a
  // context property rather than through ctx.get().
  tools: {
    register(definition) {
      captured = definition
      return () => {}
    },
  },
  get: (key) => services[key],
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject() {},
  on() {},
}

// --- run ---------------------------------------------------------------------

const mod = await import('./src/index.js')
mod.apply(ctx)

if (captured === null) throw new Error('host half did not register the session_purge tool')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

check('routes registered', registeredRoutes.length === 2, registeredRoutes.map((r) => r.path).join(', '))
check('tool registered', captured.name === 'session_purge' && typeof captured.execute === 'function', captured.name)

// 1. a fully-accounted Session is purged end to end
const report1 = await captured.execute({ sessionId: KNOWN }, {})
check('known: reports purged', /^purged: /m.test(report1))
check('known: log dir removed from disk', !fs.existsSync(dirA))
check('known: projection row deleted via the domain', projectionDeletes.includes(KNOWN))
check('known: workspace accounting detached', detachCalls.includes(KNOWN))

// 2. an archived Session also leaves the archive set
const report2 = await captured.execute({ sessionId: ARCHIVED }, {})
check('archived: purged', /^purged: /m.test(report2))
check('archived: log dir removed', !fs.existsSync(dirArchived))
check('archived: removed from archivedSessionIds', !archivedSessionIds.includes(ARCHIVED))

// 3. a pinned Session also leaves the pin set
const report3 = await captured.execute({ sessionId: PINNED }, {})
check('pinned: purged', /^purged: /m.test(report3))
check('pinned: log dir removed', !fs.existsSync(dirPinned))
check('pinned: removed from pinnedSessionIds', !pinnedSessionIds.includes(PINNED))

// 4. an unknown id is refused as not-found
const report4 = await captured.execute({ sessionId: UNKNOWN }, {})
check('unknown: refused as not found', /session not found/.test(report4), report4)
check('unknown: did NOT claim workspace accounting', !/workspace accounting detached: true/.test(report4))

// 5. a malformed id is refused
const report5 = await captured.execute({ sessionId: 'nope' }, {})
check('invalid: refused', /invalid session id/.test(report5), report5)

// 6. the raw-uuid spelling resolves to the `session-` prefixed log directory
const RAW = KNOWN.replace(/^session-/, '')
const rawDir = makeLogDir(SLUG_A, KNOWN)
const report6 = await captured.execute({ sessionId: RAW }, {})
check('raw-uuid spelling: purged the prefixed log dir', !fs.existsSync(rawDir) && /^purged: /m.test(report6))

// 7. a live Session whose disposal writes back is still left fully deleted
const report7 = await captured.execute({ sessionId: LIVE }, {})
check('live: disposal race happened', resurrections === 1, `resurrections=${resurrections}`)
check('live: log dir gone after the race', !fs.existsSync(dirLive), `exists=${fs.existsSync(dirLive)}`)
check('live: projection row gone after the race', !projectionRows.has(LIVE))
check('live: reported purged', /^purged: /m.test(report7), report7.split('\n')[0])

// 8. The HTTP route family: fence handling and no opaque failures.
//
// The plugin reads the fence through the TOLERANT accessor `ctx.get('connection')`,
// never the `ctx.connection` property: a Cordis context resolves a service by
// property access only when the plugin declared it in `inject`, and reading an
// undeclared one THROWS. That throw is what the web carrier turns into a bare,
// bodyless 400 — the exact failure this section exists to prevent from returning.
function makeRes() {
  const state = { status: 0, body: null, ended: false, headersSent: false, destroyed: false }
  return {
    state,
    set statusCode(value) { state.status = value },
    get statusCode() { return state.status },
    writeHead(code) { state.status = code; state.headersSent = true },
    end(body) { if (body !== undefined) state.body = body; state.ended = true; state.headersSent = true },
    destroy() { state.destroyed = true },
  }
}

function makeReq(method, jsonBody) {
  const listeners = {}
  const req = {
    method,
    headers: {},
    on(event, callback) {
      ;(listeners[event] ||= []).push(callback)
      return req
    },
  }
  // readJsonBody attaches its listeners synchronously and then awaits.
  setTimeout(() => {
    if (jsonBody !== undefined) for (const cb of listeners.data || []) cb(jsonBody)
    for (const cb of listeners.end || []) cb()
  }, 0)
  return req
}

function routesWith(connection) {
  const routes = []
  mod.apply({
    ...ctx,
    get: (key) => {
      if (key === 'webServer') {
        return { register: (route) => { routes.push(route); return () => {} } }
      }
      if (key === 'connection') return connection
      return services[key]
    },
  })
  return routes
}

const purgePath = '/__session-purge/purge'
const unknownBody = JSON.stringify({ sessionId: UNKNOWN })

// (a) fence rejects -> answered with the fence's own status, operation never runs
{
  const res = makeRes()
  await routesWith({ requestRejection: () => 401 }).find((r) => r.path === purgePath).handler(makeReq('POST'), res)
  check('gate: fence rejection answered with 401', res.state.status === 401 && res.state.ended, `status=${res.state.status}`)
}

// (b) fence passes -> the operation runs and reports its own status
{
  const res = makeRes()
  await routesWith({ requestRejection: () => undefined })
    .find((r) => r.path === purgePath)
    .handler(makeReq('POST', unknownBody), res)
  check(
    'gate: request past the fence reaches the operation',
    res.state.status === 404,
    `status=${res.state.status} body=${res.state.body}`,
  )
}

// (c) fence unavailable -> fail CLOSED with a diagnosable status, never a silent pass
{
  const res = makeRes()
  await routesWith(undefined).find((r) => r.path === purgePath).handler(makeReq('POST'), res)
  check('gate: unevaluable fence fails closed', res.state.status === 503 && res.state.ended, `status=${res.state.status}`)
}

// (d) a fence that itself throws must not surface as an opaque bodyless 400
{
  const res = makeRes()
  await routesWith({ requestRejection: () => { throw new Error('boom') } })
    .find((r) => r.path === purgePath)
    .handler(makeReq('POST'), res)
  check(
    'gate: throwing fence yields a diagnosable 503',
    res.state.status === 503 && typeof res.state.body === 'string' && res.state.body.includes('boom'),
    `status=${res.state.status} body=${res.state.body}`,
  )
}

// (e) a handler fault surfaces as JSON, not the carrier's bodyless 400
{
  const broken = {
    ...ctx,
    get: (key) => {
      if (key === 'webServer') {
        return {
          register: (route) => {
            route.handler(makeReq('GET'), makeRes())
            return () => {}
          },
        }
      }
      if (key === 'connection') return { requestRejection: () => undefined }
      // A storageDomain whose table lookup explodes deep inside the operation.
      if (key === 'storageDomain') return { get: () => { throw new Error('exploded') } }
      return undefined
    },
  }
  // `listSessions` swallows storage faults by design, so drive the purge route,
  // whose unguarded path is the one that must still answer with JSON.
  const routes = []
  mod.apply({
    ...broken,
    get: (key) =>
      key === 'webServer'
        ? { register: (route) => { routes.push(route); return () => {} } }
        : broken.get(key),
  })
  const res = makeRes()
  await routes
    .find((r) => r.path === purgePath)
    .handler(makeReq('POST', '{"sessionId":"not-a-session-id"'), res)
  check(
    'gate: malformed body answers with JSON, not a bare 400',
    res.state.status === 400 && typeof res.state.body === 'string' && res.state.body.includes('bad json body'),
    `status=${res.state.status} body=${res.state.body}`,
  )
}

// --- summary -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
fs.rmSync(DSH, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
