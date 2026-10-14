// dsh-plugin-session-purge — HOST half.
//
// Permanently deletes one Session: its on-disk log, its projection-cache row
// and its workspace/archive/pin accounting. Exposes the operation twice, over
// ONE implementation (`purgeSession`):
//
//   POST /__session-purge/purge   the Client half's dialog calls this
//   GET  /__session-purge/list    {sessionId,title,running} read-back/diagnostics
//   session_purge                 the agent tool
//
// Why each step exists — the deletion has to survive the layers that would
// otherwise resurrect the Session:
//
//   1. a running Agent is cancelled and awaited, so its loop cannot append
//      after the log is gone;
//   2. a live Session is flushed while it is still alive, so the pending
//      writes land BEFORE the log is removed instead of during teardown;
//   3. the live Session is detached from the in-memory store, so the
//      persistence layer's dispose path has nothing left to re-create;
//   4. the log directory is removed (both id spellings, every workspace slug)
//      and re-swept, because a dispose already in flight can re-create it;
//   5. the projection-cache row is deleted through the open storage domain, so
//      memory and disk agree and no later flush re-publishes it;
//   6. workspace accounting is detached LAST and only once the log is
//      confirmed gone, so a failed delete can never leave a Session that has
//      fallen out of its group into "Ungrouped".
//
// The plugin deliberately imports NO @deepseek-ai package: every API below is
// reached through a Cordis service on the context, so the module cannot bind
// to a stale copy of the DSH packages. Each service is feature-detected, so a
// profile that lacks one degrades instead of failing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'session-purge'

// `tools` is the only hard dependency. Every other service is reached with
// ctx.get(), so their absence narrows what is cleaned rather than breaking
// activation.
export const inject = ['tools']

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGENT_STOP_TIMEOUT_MS = 15000

// `session/disposed` listeners are dispatched without being awaited, and two of
// them WRITE: the jsonl writer drains its buffer back to the log, and the
// projection cache forces a final checkpoint. Detaching a live Session
// therefore starts writes that can land AFTER our delete and re-create both the
// log directory and the projection row. These bound the wait for that teardown,
// and the number of delete/re-check passes that follow it.
const DISPOSE_SETTLE_MS = 300
const MAX_SWEEP_ATTEMPTS = 4

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Failure carrying the HTTP status the Client dialog should show. */
class PurgeError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'PurgeError'
    this.status = status
  }
}

// --- identifiers -------------------------------------------------------------

// A Session id appears in two spellings across the stores: the raw uuid and
// the `session-<uuid>` form. The projection cache has been observed holding
// both, while the log directories and workspace accounting use the prefixed
// form. Every cleanup therefore runs over all spellings.
function idVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (SESSION_ID_RE.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
}

// --- filesystem --------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

// Locate `~/.dsh/sessions/<workspace-slug>/<id>/` for every id spelling by
// scanning the slug directories, so the slug encoding never has to be
// re-derived here (it is derived from the session's cwd by the persistence
// layer, which is the only authority on it).
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  const variants = idVariants(sessionId)
  let slugs
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, slug.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch {
        /* keep scanning */
      }
    }
  }
  return found
}

function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return dirs.length
}

// --- live session / agent ----------------------------------------------------

// Cancel the Session's Agent and wait for it to go idle, time-boxed so a stuck
// driver can never block the delete. Returns whether an Agent was live.
async function stopAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  let agent
  for (const variant of idVariants(sessionId)) {
    agent = agents.get(variant)
    if (agent) break
  }
  if (!agent) return false
  if (typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      /* already settling */
    }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, AGENT_STOP_TIMEOUT_MS)),
      ])
    } catch {
      /* proceed: the delete must not depend on a clean quiescence */
    }
  }
  return true
}

// Flush a live Session while it is still alive, so buffered events reach the
// log before we delete it rather than during teardown.
async function flushLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function' || typeof sessions.flush !== 'function') return false
  let flushed = false
  for (const variant of idVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    try {
      await sessions.flush(session)
      flushed = true
    } catch {
      /* the log is removed anyway */
    }
  }
  return flushed
}

// Detach the live Session from the in-memory store so its teardown cannot
// re-create the log directory we are about to remove.
//
// UNSUPPORTED API: the session store exposes no public removal, so this uses
// the store's own teardown path when the running build happens to expose it.
// It is purely an optimisation — a build without it still deletes correctly,
// because the directory sweep below runs again after any in-flight dispose.
function detachLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of idVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (entry.session && sessions.attachments && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    }
  } catch {
    /* best effort only */
  }
  return detached
}

// --- storage domains ---------------------------------------------------------

// Delete the projection-cache row through the OPEN domain, so the in-memory
// table and the per-record file on disk agree and no later flush can
// re-publish the row. The domain's table.delete() awaits the backend's
// deleteRecord, so the removal is durable when this resolves.
async function dropProjectionRows(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  if (!storageDomain || typeof storageDomain.get !== 'function') return false
  let removed = false
  try {
    const domain = storageDomain.get('session_projcache')
    if (!domain || typeof domain.table !== 'function') return false
    const table = domain.table('sessions')
    for (const variant of idVariants(sessionId)) {
      if (typeof table.get === 'function' && table.get(variant) === undefined) continue
      const deleted = await table.delete(variant)
      if (deleted !== false) removed = true
    }
  } catch {
    /* domain closed or table absent: nothing to clean here */
  }
  return removed
}

// Read which workspace-accounting surfaces hold this Session, BEFORE anything
// is deleted — while the Session's log still resolves, so a Workspace's
// membership check can still recognise it.
//
// This is recorded for two reasons: it makes the delete report accurate, and
// it lets an unknown id still be recognised as unknown after the log and the
// projection row are already gone (by then nothing else can tell).
function inspectWorkspaceAccounting(ctx, sessionId) {
  const variants = idVariants(sessionId)
  const found = { available: false, workspaceIds: [], archived: false, pinned: false }

  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    found.available = true
    try {
      for (const workspace of registry.list()) {
        if (!workspace || !Array.isArray(workspace.sessionIds)) continue
        if (variants.some((variant) => workspace.sessionIds.includes(variant))) {
          found.workspaceIds.push(workspace.id)
        }
      }
    } catch {
      /* registry unreadable */
    }
    if (Array.isArray(registry.archivedSessionIds)) {
      found.archived = variants.some((variant) => registry.archivedSessionIds.includes(variant))
    }
    if (Array.isArray(registry.pinnedSessionIds)) {
      found.pinned = variants.some((variant) => registry.pinnedSessionIds.includes(variant))
    }
    return found
  }

  const storageDomain = ctx.get('storageDomain')
  if (!storageDomain || typeof storageDomain.get !== 'function') return found
  try {
    const domain = storageDomain.get('workspace')
    if (!domain) return found
    found.available = true
    if (typeof domain.table === 'function') {
      for (const [workspaceId, record] of domain.table('workspaces').entries()) {
        if (!record || !Array.isArray(record.sessionIds)) continue
        if (variants.some((variant) => record.sessionIds.includes(variant))) {
          found.workspaceIds.push(workspaceId)
        }
      }
    }
    const global = domain.global
    const state = global && typeof global.get === 'function' ? global.get() : null
    if (state) {
      if (Array.isArray(state.archivedSessionIds)) {
        found.archived = variants.some((variant) => state.archivedSessionIds.includes(variant))
      }
      if (Array.isArray(state.pinnedSessionIds)) {
        found.pinned = variants.some((variant) => state.pinnedSessionIds.includes(variant))
      }
    }
  } catch {
    /* domain closed */
  }
  return found
}

function accountingHolds(accounting) {
  return accounting.workspaceIds.length > 0 || accounting.archived || accounting.pinned
}

// Whether a projection-cache row still exists for any id spelling. Used to
// confirm a delete really landed rather than trusting a single attempt.
async function projectionRowExists(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  if (!storageDomain || typeof storageDomain.get !== 'function') return false
  try {
    const domain = storageDomain.get('session_projcache')
    if (!domain || typeof domain.table !== 'function') return false
    const table = domain.table('sessions')
    if (typeof table.get !== 'function') return false
    return idVariants(sessionId).some((variant) => table.get(variant) !== undefined)
  } catch {
    return false
  }
}

// Drop the Session from every workspace-accounting surface: its Workspace's
// sessionIds, the registry-global archived set and the registry-global pin
// set. Prefers the workspace registry (the owning service); falls back to the
// workspace storage domain when the registry is not mounted.
//
// Both registry entry points are no-ops when the id is absent, so they are
// called unconditionally; the return value says whether anything was written.
async function detachWorkspaceAccounting(ctx, sessionId, accounting) {
  const variants = idVariants(sessionId)
  let changed = false

  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    const accounted = new Set(accounting.workspaceIds)
    try {
      for (const workspace of registry.list()) {
        // Only the Workspaces the pre-delete inspection recorded: a
        // post-delete read can no longer resolve the Session's path, so the
        // recorded membership is the only reliable target list.
        if (!workspace || !accounted.has(workspace.id)) continue
        if (typeof workspace.detachSession !== 'function') continue
        for (const variant of variants) {
          try {
            await workspace.detachSession(variant)
          } catch {
            /* not accountable here */
          }
        }
        changed = true
      }
    } catch {
      /* registry unreadable */
    }
    for (const variant of variants) {
      if (accounting.archived && typeof registry.unarchiveSession === 'function') {
        try {
          await registry.unarchiveSession(variant)
          changed = true
        } catch {
          /* already absent */
        }
      }
      if (accounting.pinned && typeof registry.unpinSession === 'function') {
        try {
          await registry.unpinSession(variant)
          changed = true
        } catch {
          /* already absent */
        }
      }
    }
    return changed
  }

  // Fallback: edit the workspace domain directly (`workspace` v2: a
  // `workspaces` table plus a global holding the archive/pin sets).
  const storageDomain = ctx.get('storageDomain')
  if (!storageDomain || typeof storageDomain.get !== 'function') return false
  try {
    const domain = storageDomain.get('workspace')
    if (!domain) return false
    if (typeof domain.table === 'function') {
      const table = domain.table('workspaces')
      for (const [workspaceId, record] of table.entries()) {
        if (!record || !Array.isArray(record.sessionIds)) continue
        if (!variants.some((variant) => record.sessionIds.includes(variant))) continue
        await table.put(workspaceId, {
          ...record,
          sessionIds: record.sessionIds.filter((id) => !variants.includes(id)),
        })
        changed = true
      }
    }
    const global = domain.global
    if (global && typeof global.get === 'function' && typeof global.set === 'function') {
      const state = global.get()
      if (state) {
        const next = { ...state }
        let touched = false
        for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
          if (!Array.isArray(next[key])) continue
          if (!variants.some((variant) => next[key].includes(variant))) continue
          next[key] = next[key].filter((id) => !variants.includes(id))
          touched = true
        }
        if (touched) {
          await global.set(next)
          changed = true
        }
      }
    }
  } catch {
    /* domain closed or table absent */
  }
  return changed
}

// --- the operation -----------------------------------------------------------

/**
 * Permanently delete one Session. Returns a report of what was removed.
 * @throws {PurgeError} on an invalid id, an unremovable log, or an unknown Session.
 */
async function purgeSession(ctx, rawSessionId) {
  const sessionId = String(rawSessionId || '').trim()
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new PurgeError(`invalid session id: ${sessionId || '(empty)'}`, 400)
  }

  // Read the accounting surfaces first: after the log is gone nothing can
  // resolve the Session's workspace path any more.
  const accounting = inspectWorkspaceAccounting(ctx, sessionId)

  const stopped = await stopAgent(ctx, sessionId)
  const flushed = await flushLive(ctx, sessionId)
  const detached = detachLive(ctx, sessionId)
  const wasLive = stopped || flushed || detached

  // Let a live Session's disposal finish writing before the first sweep — its
  // `session/disposed` listeners drain the log writer and force a projection
  // checkpoint, and the emitter does not await either.
  if (wasLive) await settle(DISPOSE_SETTLE_MS)

  // Remove the log and the projection row, then confirm what is left. A dispose
  // still in flight can re-create either one, so a live Session must survive
  // TWO consecutive clean passes before the delete is believed — one clean pass
  // only proves nothing had landed yet. A Session that was never live cannot be
  // written by anything, so it needs just one.
  const requiredCleanPasses = wasLive ? 2 : 1
  let logDirsRemoved = 0
  let projectionRowRemoved = false
  let cleanPasses = 0
  for (let attempt = 0; attempt < MAX_SWEEP_ATTEMPTS; attempt += 1) {
    logDirsRemoved += removeSessionDirs(sessionId)
    if (await dropProjectionRows(ctx, sessionId)) projectionRowRemoved = true

    const dirty = findSessionDirs(sessionId).length > 0 || (await projectionRowExists(ctx, sessionId))
    if (dirty) {
      cleanPasses = 0
    } else {
      cleanPasses += 1
      if (cleanPasses >= requiredCleanPasses) break
    }
    await settle(DISPOSE_SETTLE_MS)
  }

  const remaining = findSessionDirs(sessionId)
  if (remaining.length > 0) {
    throw new PurgeError(`session files could not be fully removed: ${remaining.join(', ')}`, 500)
  }
  if (await projectionRowExists(ctx, sessionId)) {
    throw new PurgeError(`session projection cache could not be removed: ${sessionId}`, 500)
  }

  // Workspace accounting goes LAST, and only after the log is confirmed gone: a
  // half-deleted Session must never fall out of its group into "Ungrouped".
  const workspaceAccountingDetached = await detachWorkspaceAccounting(ctx, sessionId, accounting)

  const logRemoved = logDirsRemoved > 0
  // "Existed" is decided from evidence gathered on both sides of the delete:
  // a log directory removed, a projection row removed, a live Agent stopped or
  // flushed, a live Session detached, or a pre-delete accounting membership.
  const existed =
    logRemoved ||
    projectionRowRemoved ||
    stopped ||
    flushed ||
    detached ||
    accountingHolds(accounting)
  if (!existed) {
    throw new PurgeError(`session not found: ${sessionId}`, 404)
  }

  return {
    sessionId,
    stopped,
    flushed,
    detached,
    logDirsRemoved,
    projectionRowRemoved,
    workspaceAccountingDetached,
  }
}

// The Sessions a caller can act on: ids and titles from the projection cache
// (the authority for titles), plus liveness from the agent registry.
function listSessions(ctx) {
  const out = []
  const storageDomain = ctx.get('storageDomain')
  const agents = ctx.get('agents')
  if (!storageDomain || typeof storageDomain.get !== 'function') return out
  try {
    const domain = storageDomain.get('session_projcache')
    if (!domain || typeof domain.table !== 'function') return out
    const table = domain.table('sessions')
    for (const [id, record] of table.entries()) {
      const rows = record && typeof record === 'object' && record.rows ? record.rows : {}
      const title = rows.title ? rows.title.val : null
      let running = false
      if (agents && typeof agents.get === 'function') {
        running = idVariants(id).some((variant) => Boolean(agents.get(variant)))
      }
      const identity = record && record.identity ? record.identity : {}
      out.push({
        sessionId: id,
        title: typeof title === 'string' ? title : null,
        cwd: typeof identity.cwd === 'string' ? identity.cwd : null,
        createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
        running,
      })
    }
  } catch {
    /* domain closed */
  }
  return out
}

// --- HTTP helpers ------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new PurgeError('bad json body', 400))
      }
    })
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// The HTTP carrier itself applies no Host/Origin fence and no browser
// authentication — a raw route is reachable by anything that can open a local
// socket. The fence and the auth check live in the `connection` service, so a
// hand-rolled route must apply them itself. Returns true when the request was
// already rejected (and answered).
//
// The service is read with ctx.get() rather than `ctx.connection` ON PURPOSE.
// A Cordis context resolves a service by property access only when the plugin
// DECLARED it in `inject`; reading an undeclared one throws. The official fence
// users (dsh-host-open-in-app) can write `Reflect.get(ctx, 'connection')`
// because they list `connection` in their inject array. This plugin must not:
// it also runs in profiles with no web surface at all, so a hard dependency on
// the web carrier would stop it activating there. ctx.get() is the tolerant
// accessor that yields undefined instead of throwing.
//
// Because serving this route can permanently destroy data, an unevaluable
// fence FAILS CLOSED with a diagnosable response rather than quietly serving
// the request unauthenticated.
function rejectIfUntrusted(ctx, req, res) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }
  if (!connection || typeof connection.requestRejection !== 'function') {
    sendJson(res, 503, {
      error: 'session-purge: the connection fence is unavailable, refusing to serve this route',
    })
    return true
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch (error) {
    sendJson(res, 503, { error: `session-purge: connection fence failed: ${error.message}` })
    return true
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

// --- plugin ------------------------------------------------------------------

/**
 * Register the routes and the agent tool. `webServer` is optional — a
 * terminal-only profile has no web surface — so the routes attach as soon as
 * that service exists instead of gating activation on it.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  // The web carrier answers a THROWING route handler with a bare 400 and no
  // body, which is impossible to diagnose from the client. Every handler is
  // therefore wrapped so any unhandled failure becomes an explicit JSON status.
  function guard(handler) {
    return async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        if (res.headersSent) {
          res.destroy()
          return
        }
        sendJson(res, 500, { error: `${error.name || 'error'}: ${error.message || String(error)}` })
      }
    }
  }

  function registerRoutes(webServer, owner) {
    owner.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/__session-purge/list',
        handler: guard((req, res) => {
          if (rejectIfUntrusted(ctx, req, res)) return
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
          sendJson(res, 200, { ok: true, sessions: listSessions(ctx) })
        }),
      }),
    )

    owner.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/__session-purge/purge',
        handler: guard(async (req, res) => {
          if (rejectIfUntrusted(ctx, req, res)) return
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message })
          }
          try {
            const report = await purgeSession(ctx, body.sessionId)
            sendJson(res, 200, { ok: true, ...report })
          } catch (error) {
            sendJson(res, error instanceof PurgeError ? error.status : 500, { error: error.message })
          }
        }),
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }

  // The agent tool. Declared as a raw definition (name/parameters/output) so
  // the host half needs no import of the tools package.
  ctx.effect(() =>
    ctx.tools.register({
      name: 'session_purge',
      description:
        'Permanently delete one Session of this Harness profile. Stops the Session\'s agent if it is running, then removes its persisted log, its projection-cache row and its workspace/archive/pin accounting. Permanent and irreversible: the conversation record is gone. Use the session id, not the title.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The Session id to delete (uuid or session-<uuid> form).',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        try {
          const report = await purgeSession(ctx, args && args.sessionId)
          return [
            `purged: ${report.sessionId}`,
            `agent stopped: ${report.stopped}`,
            `log directories removed: ${report.logDirsRemoved}`,
            `projection row removed: ${report.projectionRowRemoved}`,
            `workspace accounting detached: ${report.workspaceAccountingDetached}`,
          ].join('\n')
        } catch (error) {
          return `purge failed: ${error.message}`
        }
      },
    }),
  )
}
