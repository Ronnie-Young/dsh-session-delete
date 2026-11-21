/**
 * dsh-session-delete — Host half: a Session recycle bin.
 *
 * Deleting a Session no longer shreds its log. The Client half moves the
 * Session to a trash page; this Host half:
 *
 *   1. stops the Session's running work and archives it (hidden everywhere),
 *   2. records where the row sat in its workspace and detaches it,
 *   3. moves the Session's own log directory into the plugin's trash area,
 *   4. keeps the entry for `retentionDays`, restorable from the trash page,
 *   5. permanently deletes entries on manual purge or once they expire
 *      (`expireAction: 'purge'`; `'lock'` keeps them, not restorable).
 *
 * A Session that is still live in this Host process cannot be destroyed by a
 * plugin (the Agent handle that owns it is a capability held elsewhere), so a
 * trashed Session keeps its archive entry until it disposes. Restoring clears
 * that entry again.
 *
 * @module dsh-session-delete
 */
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { checkSessionDirectory, encodeSegment } from './lib/path-guard.js'
import {
  DEFAULT_RETENTION_DAYS, EXPIRY_SWEEP_MS, describeEntry, findEntry, moveDirectory,
  pathExists, readManifest, removeDirectory, removeEntry, trashDirectoryFor, upsertEntry, writeManifest,
} from './lib/trash-store.js'

/** Loader row name; keep in sync with `cordis.patch.yml`. */
export const name = 'session-delete'

/** Route paths; the trash page and the menu share one namespace. */
const MOVE_ROUTE = '/session-delete/trash/move'
const TRASH_ROUTE = '/session-delete/trash'
const TRASH_ACTION_ROUTE = '/session-delete/trash/action'
const SETTINGS_ROUTE = '/session-delete/settings'

/** Refuse bodies larger than this; requests carry one id at most. */
const MAX_BODY_BYTES = 64 * 1024

/** Longest Session title kept in the manifest. */
const MAX_TITLE_CHARS = 500

/** One day in milliseconds. */
const DAY_MS = 86_400_000

/** Plugin configuration. */
export const Config = Schema.object({
  retentionDays: Schema.number().min(1).default(DEFAULT_RETENTION_DAYS)
    .description('会话在回收站里保留的天数；到期后按 expireAction 处理。'),
  expireAction: Schema.union([
    Schema.const('purge').description('到期自动永久删除。'),
    Schema.const('lock').description('到期保留数据，但不再允许恢复，只能手动永久删除。'),
  ]).default('purge').description('到期行为。'),
  dataDir: Schema.string().default('')
    .description('回收站数据目录；留空用 $DSH_HOME/session-delete。'),
})

/**
 * Activation-time runtime shared by the routes and the expiry sweep.
 * @typedef {object} Runtime
 * @property {object} ctx - plugin context.
 * @property {number} retentionDays - resolved retention.
 * @property {'purge'|'lock'} expireAction - resolved expiry behavior.
 * @property {string} dataDir - resolved plugin data directory.
 * @property {Set<string>} pendingArchiveCleanup - ids whose archive entry must clear on disposal.
 * @property {Promise<void>} queue - serializes manifest mutations.
 */

/**
 * Register the routes, the disposal listener, the expiry timer, and the
 * startup reconcile. Nothing else happens at activation.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 */
export async function apply(ctx, config) {
  const runtime = createRuntime(ctx, config)

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: MOVE_ROUTE,
        handler: (req, res) => handleDelete(runtime, webCtx, req, res),
      }),
      `session-delete: ${MOVE_ROUTE}`,
    )
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: TRASH_ROUTE,
        handler: (req, res) => handleList(runtime, webCtx, req, res),
      }),
      `session-delete: ${TRASH_ROUTE}`,
    )
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: TRASH_ACTION_ROUTE,
        handler: (req, res) => handleAction(runtime, webCtx, req, res),
      }),
      `session-delete: ${TRASH_ACTION_ROUTE}`,
    )
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => handleSettings(runtime, webCtx, req, res),
      }),
      `session-delete: ${SETTINGS_ROUTE}`,
    )
  })

  // A Session that is still live when it is purged cannot leave the Host
  // process from a plugin; this listener clears the archive entry it left
  // behind once its owner really releases it.
  ctx.on('session/disposed', (session) => {
    void releaseArchiveTombstone(runtime, session.id)
  })

  // Startup reconciliation: roll back a crash between the manifest write and
  // the file move, purge entries that expired while the app was closed, and
  // clear archive ids that no longer correspond to anything.
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], (readyCtx) => {
    runtime.ctx = readyCtx
    void reconcile(runtime).catch((error) => {
      readyCtx.logger?.warn?.('session-delete: startup reconcile failed: %s', error)
    })
  })

  // Hourly expiry sweep; the timer dies with the plugin.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void sweepExpired(runtime).catch((error) => {
        runtime.ctx.logger?.warn?.('session-delete: expiry sweep failed: %s', error)
      })
    }, EXPIRY_SWEEP_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'session-delete: expiry timer')
}

/**
 * Resolve configuration and plugin-owned paths.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 * @returns the runtime.
 */
function createRuntime(ctx, config) {
  const configuredDays = Number(config?.retentionDays)
  const retentionDays = Number.isFinite(configuredDays) && configuredDays >= 1
    ? Math.floor(configuredDays)
    : DEFAULT_RETENTION_DAYS
  const expireAction = config?.expireAction === 'lock' ? 'lock' : 'purge'
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir !== ''
    ? resolve(config.dataDir)
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-delete')
  return { ctx, retentionDays, expireAction, dataDir, pendingArchiveCleanup: new Set(), queue: Promise.resolve() }
}

/**
 * Serialize manifest/file mutations so two route calls cannot interleave.
 * @param runtime - plugin runtime.
 * @param task - operation to run.
 * @returns the task's result.
 */
function enqueue(runtime, task) {
  const run = runtime.queue.then(task, task)
  runtime.queue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * One HTTP request that moves a Session into the trash.
 * @param runtime - plugin runtime.
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @param res - owned response.
 */
async function handleDelete(runtime, webCtx, req, res) {
  if (!guard(runtime, webCtx, req, res, { method: 'POST', json: true })) return
  const body = await readBody(req, res)
  if (body === null) return
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '' || sessionId.length > 256) {
    send(res, 400, failure('BAD_REQUEST', 'sessionId must be a non-empty string'))
    return
  }
  const displayTitle = typeof body.displayTitle === 'string' ? body.displayTitle : ''
  let result
  try {
    result = await enqueue(runtime, () => moveToTrash(runtime, sessionId, displayTitle))
  } catch (error) {
    result = failureResult(error)
  }
  send(res, 200, result)
}

/**
 * One HTTP request that lists the trash page contents.
 * @param runtime - plugin runtime.
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @param res - owned response.
 */
async function handleList(runtime, webCtx, req, res) {
  if (!guard(runtime, webCtx, req, res, { method: 'GET', json: false })) return
  try {
    const value = await enqueue(runtime, () => listTrash(runtime))
    send(res, 200, { ok: true, ...value })
  } catch (error) {
    send(res, 200, failureResult(error))
  }
}

/**
 * One HTTP request that restores or permanently deletes trashed Sessions.
 * @param runtime - plugin runtime.
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @param res - owned response.
 */
async function handleAction(runtime, webCtx, req, res) {
  if (!guard(runtime, webCtx, req, res, { method: 'POST', json: true })) return
  const body = await readBody(req, res)
  if (body === null) return
  const action = typeof body.action === 'string' ? body.action : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  let result
  try {
    result = await enqueue(runtime, async () => {
      if (action === 'restore') {
        if (sessionId === '') throw codedError('BAD_REQUEST', 'sessionId is required')
        return { ok: true, ...(await restoreFromTrash(runtime, sessionId)) }
      }
      if (action === 'purge') {
        if (sessionId === '') throw codedError('BAD_REQUEST', 'sessionId is required')
        return { ok: true, ...(await purgeFromTrash(runtime, sessionId)) }
      }
      if (action === 'purge-all') {
        const counters = await purgeAll(runtime)
        return { ok: true, ...counters }
      }
      throw codedError('BAD_REQUEST', `unknown action: ${action}`)
    })
  } catch (error) {
    result = failureResult(error)
  }
  send(res, 200, result)
}

/**
 * Admit one request: method, same-origin, and JSON content type.
 * @param runtime - plugin runtime.
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @param res - owned response.
 * @param options - expected method and whether a JSON body is required.
 * @returns whether the handler may continue.
 */
function guard(runtime, webCtx, req, res, { method, json }) {
  if (req.method !== method) {
    send(res, 405, failure('METHOD_NOT_ALLOWED', `${method} is required`))
    return false
  }
  if (!isSameOrigin(webCtx, req)) {
    send(res, 403, failure('FORBIDDEN_ORIGIN', crossOriginDiagnosis(webCtx, req)))
    return false
  }
  if (json) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.includes('application/json')) {
      send(res, 415, failure('UNSUPPORTED_MEDIA_TYPE', 'application/json is required'))
      return false
    }
  }
  return true
}

/**
 * Whether a request comes from this page rather than another origin.
 *
 * Browsers do not promise the same headers for every request shape: a
 * same-origin GET may carry no `Origin` at all, and a WebView may omit
 * `Sec-Fetch-Site`. Only explicit cross-origin evidence is treated as a
 * refusal — an `Origin` whose host is not the request's own host, or a
 * `Sec-Fetch-Site` other than same-origin/none. A browser cannot forge those
 * on a cross-site request, and a local process without headers can already
 * touch these files directly.
 *
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @returns whether the request may proceed.
 */
function isSameOrigin(webCtx, req) {
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined
  const site = typeof req.headers?.['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined
  const host = typeof req.headers?.host === 'string' ? req.headers.host : undefined
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    const parsed = new URL(origin)
    if (host !== undefined && parsed.host === host) return true
  } catch {
    return false
  }
  const listenerOrigin = readOrigin(webCtx)
  return listenerOrigin !== undefined && origin === listenerOrigin
}

/**
 * Name the signals a refused request carried, so a deployment can tell the
 * difference between a missing header and a real cross-origin caller.
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @returns one short localized-neutral message.
 */
function crossOriginDiagnosis(webCtx, req) {
  const origin = String(req.headers?.origin ?? '-')
  const site = String(req.headers?.['sec-fetch-site'] ?? '-')
  const host = String(req.headers?.host ?? '-')
  let listener = '-'
  try {
    listener = readOrigin(webCtx) ?? '-'
  } catch {
    listener = '-'
  }
  return `same-origin requests are required (origin=${origin}, site=${site}, host=${host}, listener=${listener})`
}

/**
 * Move one Session into the trash.
 *
 * The manifest entry is durable before the files move, so a crash in between
 * is rolled back by the startup reconcile instead of losing the Session.
 *
 * @param runtime - plugin runtime.
 * @param sessionId - Session to trash.
 * @param displayTitle - row title captured by the Client, shown in the trash.
 * @returns JSON outcome.
 */
async function moveToTrash(runtime, sessionId, displayTitle) {
  const persistence = runtime.ctx.get('sessionPersistence')
  const registry = runtime.ctx.get('workspaceRegistry')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    throw codedError('UNAVAILABLE', 'session persistence is not mounted in this profile')
  }
  if (registry === undefined || typeof registry.list !== 'function') {
    throw codedError('UNAVAILABLE', 'the workspace registry is not mounted in this profile')
  }

  const { manifest } = await readManifest(runtime.dataDir)
  if (findEntry(manifest, sessionId) !== undefined) {
    throw codedError('ALREADY_TRASHED', 'this session is already in the trash')
  }

  const snapshot = await persistence.stat(sessionId)
  const live = isSessionLive(runtime, sessionId)
  const accounted = registry.list().some(workspace => workspace.sessionIds.includes(sessionId))
  if (snapshot === undefined && !live && !accounted) {
    // Nothing exists to trash: a stale row (or an id deleted outside DSH).
    // Still archive/unarchive-clean so the caller can drop the row locally.
    await unarchiveQuietly(runtime, registry, sessionId)
    return {
      ok: true, sessionId, empty: true, title: displayTitle.trim(),
      retentionDays: runtime.retentionDays, expiresAt: 0,
    }
  }

  let directory = null
  let logPath = null
  if (snapshot !== undefined) {
    const location = snapshot.location
    if (location !== undefined && location !== null) {
      if (location.kind !== 'jsonl' || typeof location.path !== 'string') {
        throw codedError(
          'UNSUPPORTED_BACKEND',
          `this build only trashes logs from the JSONL backend (reported: ${String(location.kind)})`,
        )
      }
      const root = typeof persistence.config?.root === 'string' ? persistence.config.root : undefined
      const check = checkSessionDirectory(dirname(location.path), root)
      if (!check.ok) throw codedError('UNSAFE_PATH', check.reason)
      const reported = resolve(location.path)
      if (dirname(reported) !== check.directory) {
        throw codedError('UNSAFE_PATH', 'the reported log file is not inside the reported session directory')
      }
      let info
      try {
        info = await lstat(check.directory)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (info !== undefined) {
        if (!info.isDirectory()) {
          throw codedError('UNSAFE_PATH', `the reported session directory is not a real directory: ${check.directory}`)
        }
        directory = check.directory
        logPath = reported
      }
    }
  }

  // Stop running work and hide the Session before anything moves.
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
  } catch (error) {
    if (!isUnknownSession(error)) throw error
  }

  // Record where the row sat, then detach it from workspace accounting.
  let position = { workspaceId: null, beforeSessionId: null, index: null }
  for (const workspace of registry.list()) {
    const index = workspace.sessionIds.indexOf(sessionId)
    if (index < 0) continue
    position = {
      workspaceId: workspace.id,
      beforeSessionId: workspace.sessionIds[index + 1] ?? null,
      index,
    }
    await workspace.detachSession(sessionId)
    break
  }
  if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId)

  const deletedAt = Date.now()
  const entry = {
    sessionId,
    title: displayTitle.trim().slice(0, MAX_TITLE_CHARS),
    deletedAt,
    expiresAt: runtime.retentionDays > 0 ? deletedAt + runtime.retentionDays * DAY_MS : 0,
    ...position,
    cwd: typeof snapshot?.header?.cwd === 'string' ? snapshot.header.cwd : null,
    logPath,
    sessionDir: directory,
    trashDir: directory === null ? null : trashDirectoryFor(runtime.dataDir, sessionId, encodeSegment),
  }
  const next = upsertEntry(manifest, entry)
  try {
    await writeManifest(runtime.dataDir, next)
  } catch (error) {
    await restoreWorkspacePosition(runtime, registry, entry).catch(() => undefined)
    await unarchiveQuietly(runtime, registry, sessionId)
    throw codedError(
      'TRASH_RECORD_FAILED',
      'the trash record could not be written: '
      + (error instanceof Error ? error.message : String(error)),
    )
  }

  let moved = false
  if (directory !== null && entry.trashDir !== null) {
    try {
      await moveDirectory(directory, entry.trashDir)
      moved = true
    } catch (error) {
      // Roll the record back so the Session stays visible instead of pointing
      // at files that never left their project directory.
      await writeManifest(runtime.dataDir, removeEntry(next, sessionId)).catch(() => undefined)
      await restoreWorkspacePosition(runtime, registry, entry).catch(() => undefined)
      await unarchiveQuietly(runtime, registry, sessionId)
      throw codedError(
        'TRASH_MOVE_FAILED',
        `the session log could not be moved to the trash (${directory}): `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  return {
    ok: true,
    sessionId,
    title: entry.title,
    expiresAt: entry.expiresAt,
    retentionDays: runtime.retentionDays,
    moved,
  }
}

/**
 * Restore one trashed Session: move its log back, make it visible again, and
 * put it back where it sat in its workspace.
 * @param runtime - plugin runtime.
 * @param sessionId - Session to restore.
 * @returns JSON outcome.
 */
async function restoreFromTrash(runtime, sessionId) {
  const registry = runtime.ctx.get('workspaceRegistry')
  if (registry === undefined) throw codedError('UNAVAILABLE', 'the workspace registry is not mounted')
  const { manifest } = await readManifest(runtime.dataDir)
  const entry = findEntry(manifest, sessionId)
  if (entry === undefined) throw codedError('NOT_TRASHED', 'this session is not in the trash')
  const expired = entry.expiresAt > 0 && Date.now() >= entry.expiresAt
  if (expired) throw codedError('EXPIRED', 'this session is past its retention period')

  if (entry.sessionDir !== null && entry.trashDir !== null) {
    if (await pathExists(entry.sessionDir)) {
      throw codedError('RESTORE_CONFLICT', `the original session directory already exists: ${entry.sessionDir}`)
    }
    await moveDirectory(entry.trashDir, entry.sessionDir)
  }
  await unarchiveQuietly(runtime, registry, sessionId)
  const workspaceRestored = await restoreWorkspacePosition(runtime, registry, entry)
    .then(() => true)
    .catch((error) => {
      runtime.ctx.logger?.warn?.('session-delete: could not restore the workspace position: %s', error)
      return false
    })
  await writeManifest(runtime.dataDir, removeEntry(manifest, sessionId)).catch((error) => {
    runtime.ctx.logger?.warn?.('session-delete: could not update the trash manifest: %s', error)
  })
  return { sessionId, title: entry.title, workspaceRestored }
}

/**
 * Permanently delete one trashed Session.
 * @param runtime - plugin runtime.
 * @param sessionId - Session to purge.
 * @returns JSON outcome.
 */
async function purgeFromTrash(runtime, sessionId) {
  const { manifest } = await readManifest(runtime.dataDir)
  const entry = findEntry(manifest, sessionId)
  if (entry === undefined) return { sessionId, alreadyPurged: true }
  try {
    await purgeEntry(runtime, entry)
  } catch (error) {
    throw codedError(
      'PURGE_FAILED',
      `the trashed log could not be removed (${entry.trashDir ?? ''}): `
      + (error instanceof Error ? error.message : String(error)),
    )
  }
  await writeManifest(runtime.dataDir, removeEntry(manifest, sessionId))
  return { sessionId }
}

/**
 * Permanently delete every trashed Session.
 * @param runtime - plugin runtime.
 * @returns number of entries removed.
 */
async function purgeAll(runtime) {
  const { manifest } = await readManifest(runtime.dataDir)
  if (manifest.entries.length === 0) return { purged: 0, failed: 0 }
  const kept = []
  let purged = 0
  for (const entry of manifest.entries) {
    try {
      await purgeEntry(runtime, entry)
      purged += 1
    } catch (error) {
      kept.push(entry)
      runtime.ctx.logger?.warn?.('session-delete: could not purge %s: %s', entry.sessionId, error)
    }
  }
  await writeManifest(runtime.dataDir, { version: manifest.version, entries: kept })
  return { purged, failed: kept.length }
}

/**
 * Remove one entry's files and its archive record.
 * @param runtime - plugin runtime.
 * @param entry - manifest entry.
 */
async function purgeEntry(runtime, entry) {
  if (entry.trashDir !== null) await removeDirectory(entry.trashDir)
  await clearArchive(runtime, entry.sessionId)
}

/**
 * Remove the archive entry for a Session that no longer exists.
 * @param runtime - plugin runtime.
 * @param sessionId - Session id.
 */
async function clearArchive(runtime, sessionId) {
  const registry = runtime.ctx.get('workspaceRegistry')
  if (registry === undefined) return
  if (isSessionLive(runtime, sessionId)) {
    // The Session still exists in this process: keep the archive entry so it
    // stays hidden, and let the disposal listener clear it.
    runtime.pendingArchiveCleanup.add(sessionId)
    return
  }
  await registry.unarchiveSession(sessionId).catch((error) => {
    runtime.ctx.logger?.warn?.('session-delete: could not clear the archive id for %s: %s', sessionId, error)
  })
}

/**
 * Unarchive a Session that is being restored or rolled back.
 * @param runtime - plugin runtime.
 * @param registry - workspace registry.
 * @param sessionId - Session id.
 */
async function unarchiveQuietly(runtime, registry, sessionId) {
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    runtime.ctx.logger?.warn?.('session-delete: could not unarchive %s: %s', sessionId, error)
  }
}

/**
 * Put a Session back where it sat inside its recorded workspace.
 * @param runtime - plugin runtime.
 * @param registry - workspace registry.
 * @param entry - manifest entry with the recorded position.
 * @returns resolution after the workspace write.
 */
async function restoreWorkspacePosition(runtime, registry, entry) {
  if (entry.workspaceId === null) return
  const workspace = registry.list().find(candidate => candidate.id === entry.workspaceId)
  if (workspace === undefined) return
  await workspace.attachSession(entry.sessionId)
  const siblings = workspace.sessionIds.filter(id => id !== entry.sessionId)
  const anchor = entry.beforeSessionId !== null && siblings.includes(entry.beforeSessionId)
    ? entry.beforeSessionId
    : entry.index !== null && entry.index < siblings.length
      ? siblings[entry.index]
      : undefined
  await workspace.insertSessionBefore(entry.sessionId, anchor)
}

/**
 * List the trash page contents.
 * @param runtime - plugin runtime.
 * @returns retention policy plus one described row per entry.
 */
async function listTrash(runtime) {
  const { manifest } = await readManifest(runtime.dataDir)
  const now = Date.now()
  const entries = []
  for (const entry of manifest.entries) {
    const hasFiles = entry.trashDir === null ? false : await pathExists(entry.trashDir)
    entries.push(describeEntry(entry, { now, expireAction: runtime.expireAction, hasFiles }))
  }
  entries.sort((left, right) => right.deletedAt - left.deletedAt)
  return {
    retentionDays: runtime.retentionDays,
    expireAction: runtime.expireAction,
    canSave: canSaveSettings(runtime),
    entries,
  }
}

/**
 * Startup repair: roll back interrupted trashes, purge expired entries under
 * the `purge` policy, and clear archive ids that no longer correspond to
 * anything.
 * @param runtime - plugin runtime.
 */
async function reconcile(runtime) {
  const { manifest } = await readManifest(runtime.dataDir)
  let next = manifest
  for (const entry of manifest.entries) {
    const original = entry.sessionDir === null ? false : await pathExists(entry.sessionDir)
    const trashed = entry.trashDir === null ? false : await pathExists(entry.trashDir)
    if (trashed) {
      if (original) await removeDirectory(entry.sessionDir).catch(() => undefined)
      continue
    }
    // The manifest survived but the move never completed (or the data is gone):
    // forget the entry and make the Session visible again if it still exists.
    next = removeEntry(next, entry.sessionId)
    await clearArchive(runtime, entry.sessionId)
  }
  if (next !== manifest) await writeManifest(runtime.dataDir, next)
  if (runtime.expireAction === 'purge') await sweepExpired(runtime)
  await sweepOrphanedArchiveIds(runtime)
}

/**
 * Permanently delete entries past their retention period under `purge`.
 * @param runtime - plugin runtime.
 * @returns number of entries removed.
 */
async function sweepExpired(runtime) {
  if (runtime.expireAction !== 'purge') return 0
  const { manifest } = await readManifest(runtime.dataDir)
  const now = Date.now()
  const due = manifest.entries.filter(entry => entry.expiresAt > 0 && now >= entry.expiresAt)
  if (due.length === 0) return 0
  const kept = []
  for (const entry of due) {
    try {
      await purgeEntry(runtime, entry)
    } catch (error) {
      kept.push(entry)
      runtime.ctx.logger?.warn?.('session-delete: could not purge expired %s: %s', entry.sessionId, error)
    }
  }
  await writeManifest(runtime.dataDir, {
    version: manifest.version,
    entries: manifest.entries.filter(entry => !due.includes(entry) || kept.includes(entry)),
  })
  return due.length - kept.length
}

/**
 * Clear archive ids that are not in the trash, not live, and have no stored
 * log — leftovers from a crash between deletion and disposal.
 * @param runtime - plugin runtime.
 */
async function sweepOrphanedArchiveIds(runtime) {
  const registry = runtime.ctx.get('workspaceRegistry')
  const persistence = runtime.ctx.get('sessionPersistence')
  if (registry === undefined || persistence === undefined) return
  const { manifest } = await readManifest(runtime.dataDir)
  const trashed = new Set(manifest.entries.map(entry => entry.sessionId))
  for (const sessionId of [...registry.archivedSessionIds]) {
    if (trashed.has(sessionId)) continue
    if (isSessionLive(runtime, sessionId)) continue
    let snapshot
    try {
      snapshot = await persistence.stat(sessionId)
    } catch {
      continue
    }
    if (snapshot !== undefined) continue
    await registry.unarchiveSession(sessionId).catch((error) => {
      runtime.ctx.logger?.warn?.('session-delete: could not clear stale archive id %s: %s', sessionId, error)
    })
  }
}

/**
 * Drop the archive tombstone for one Session that has finished disposing.
 * @param runtime - plugin runtime.
 * @param sessionId - disposed Session.
 */
async function releaseArchiveTombstone(runtime, sessionId) {
  if (!runtime.pendingArchiveCleanup.delete(sessionId)) return
  const registry = runtime.ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    runtime.ctx.logger?.warn?.('session-delete: could not clear the archive id for %s: %s', sessionId, error)
  }
}

/**
 * Whether this Host process still holds the Session or its Agent.
 * @param runtime - plugin runtime.
 * @param sessionId - Session to test.
 * @returns whether a live Session or Agent still exists.
 */
function isSessionLive(runtime, sessionId) {
  const sessions = runtime.ctx.get('sessions')
  const agents = runtime.ctx.get('agents')
  const liveSession = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  const liveAgent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  return liveSession !== undefined || liveAgent !== undefined
}

/**
 * One HTTP request that saves the trash policy.
 *
 * The value is persisted through the config editor, which validates the
 * candidate, serializes the profile write, and restarts the plugin so `apply`
 * rebuilds its state from the new configuration.
 *
 * @param runtime - plugin runtime.
 * @param webCtx - context owning the web server.
 * @param req - incoming request.
 * @param res - owned response.
 */
async function handleSettings(runtime, webCtx, req, res) {
  if (!guard(runtime, webCtx, req, res, { method: 'POST', json: true })) return
  const body = await readBody(req, res)
  if (body === null) return
  const days = Number(body.retentionDays)
  const expireAction = typeof body.expireAction === 'string' ? body.expireAction : ''
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    send(res, 400, failure('BAD_REQUEST', 'retentionDays must be an integer between 1 and 365'))
    return
  }
  if (expireAction !== 'purge' && expireAction !== 'lock') {
    send(res, 400, failure('BAD_REQUEST', 'expireAction must be purge or lock'))
    return
  }
  const editor = runtime.ctx.get('configEditor')
  const entry = runtime.ctx.fiber?.entry
  if (editor === undefined || typeof editor.edit !== 'function' || entry === undefined) {
    send(res, 200, failure(
      'SETTINGS_UNAVAILABLE',
      'this profile cannot save plugin configuration; edit the plugin row in cordis.patch.yml or the Plugins page',
    ))
    return
  }
  try {
    await editor.edit(entry, current => ({ ...current, retentionDays: days, expireAction }))
    send(res, 200, { ok: true, retentionDays: days, expireAction, restarting: true })
  } catch (error) {
    send(res, 200, failure(
      'SETTINGS_REJECTED',
      error instanceof Error ? error.message : String(error),
    ))
  }
}

/**
 * Whether the trash page may write the plugin configuration from here.
 * @param runtime - plugin runtime.
 * @returns whether a config editor and this plugin's loader entry are available.
 */
function canSaveSettings(runtime) {
  const editor = runtime.ctx.get('configEditor')
  return editor !== undefined && typeof editor.edit === 'function' && runtime.ctx.fiber?.entry !== undefined
}

/**
 * Read the listener origin without turning an unbound listener into a 500.
 * @param webCtx - context that owns `webServer`.
 * @returns the origin, or undefined.
 */
function readOrigin(webCtx) {
  try {
    const origin = webCtx.webServer.getOrigin()
    return typeof origin === 'string' ? origin : undefined
  } catch {
    return undefined
  }
}

/**
 * An archive refusal for an id that no longer exists is not a failure.
 * @param error - rejection from `archiveSession`.
 * @returns whether the Session was simply unknown.
 */
function isUnknownSession(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /hold no such session/i.test(message)
}

/**
 * Read a bounded JSON body.
 * @param req - incoming request.
 * @param res - owned response.
 * @returns the parsed body, or null after writing a refusal.
 */
async function readBody(req, res) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
      chunks.push(chunk)
    }
  } catch (error) {
    send(res, 400, failure('BAD_REQUEST', error instanceof Error ? error.message : String(error)))
    return null
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    send(res, 400, failure('BAD_REQUEST', 'request body is not valid JSON'))
    return null
  }
}

/**
 * Build one failure payload from a thrown value.
 * @param error - thrown value.
 * @returns JSON-serializable failure.
 */
function failureResult(error) {
  return failure(
    error?.code ?? 'TRASH_FAILED',
    error instanceof Error ? error.message : String(error),
  )
}

/**
 * @param code - stable failure code.
 * @param message - human-readable reason.
 * @returns JSON-serializable failure.
 */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Write one JSON response.
 * @param res - owned response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Build an error whose message reaches the user through the Client half.
 * @param code - stable failure code.
 * @param message - human-readable reason.
 * @returns the error to throw.
 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
