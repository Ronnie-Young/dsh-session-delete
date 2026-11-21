/**
 * Durable trash manifest and the file moves behind it.
 *
 * The recycle bin keeps each trashed Session's own log directory next to a
 * manifest entry, both under the plugin's data directory. The manifest is the
 * single source of truth for "what is in the bin": it is written before files
 * move and rolled back by a startup reconcile if a crash interrupted that
 * sequence.
 *
 * Layout:
 *   <dataDir>/trash.json                     manifest
 *   <dataDir>/trash/<encoded session id>/    moved Session directory
 *
 * @module dsh-session-delete/lib/trash-store
 */
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Manifest schema version; bump when fields or semantics change. */
export const TRASH_VERSION = 1

/** Default retention when the plugin row names none. */
export const DEFAULT_RETENTION_DAYS = 14

/** Hour used for the background expiry sweep. */
export const EXPIRY_SWEEP_MS = 60 * 60 * 1000

/** One millisecond per day, for the remaining-days projection. */
const DAY_MS = 86_400_000

/**
 * @typedef {object} TrashEntry
 * @property {string} sessionId - trashed Session.
 * @property {string} title - row title captured at trash time.
 * @property {number} deletedAt - epoch milliseconds.
 * @property {number} expiresAt - epoch milliseconds; 0 means no expiry.
 * @property {string|null} workspaceId - workspace whose position should be restored.
 * @property {string|null} beforeSessionId - anchor the Session sat in front of.
 * @property {number|null} index - position inside the workspace at trash time.
 * @property {string|null} cwd - stored Session cwd, kept for diagnostics.
 * @property {string|null} logPath - original materialized log file, when any.
 * @property {string|null} sessionDir - original absolute Session directory.
 * @property {string|null} trashDir - absolute directory holding the moved log.
 */

/**
 * An empty manifest.
 * @returns {{ version: number, entries: TrashEntry[] }} fresh manifest.
 */
export function emptyManifest() {
  return { version: TRASH_VERSION, entries: [] }
}

/**
 * Read a manifest value defensively: unknown fields are dropped and a bad
 * shape yields an empty manifest rather than a crash.
 * @param value - parsed JSON value.
 * @returns a normalized manifest.
 */
export function normalizeManifest(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.entries)) return emptyManifest()
  const entries = []
  for (const entry of value.entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue
    entries.push({
      sessionId: entry.sessionId,
      title: typeof entry.title === 'string' ? entry.title : '',
      deletedAt: Number.isFinite(entry.deletedAt) ? entry.deletedAt : 0,
      expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0,
      workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
      beforeSessionId: typeof entry.beforeSessionId === 'string' ? entry.beforeSessionId : null,
      index: Number.isInteger(entry.index) ? entry.index : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      logPath: typeof entry.logPath === 'string' ? entry.logPath : null,
      sessionDir: typeof entry.sessionDir === 'string' ? entry.sessionDir : null,
      trashDir: typeof entry.trashDir === 'string' ? entry.trashDir : null,
    })
  }
  return { version: TRASH_VERSION, entries }
}

/**
 * Find one manifest entry.
 * @param manifest - current manifest.
 * @param sessionId - Session to look for.
 * @returns the entry, or undefined.
 */
export function findEntry(manifest, sessionId) {
  return manifest.entries.find(entry => entry.sessionId === sessionId)
}

/**
 * Replace or insert one entry without mutating the input.
 * @param manifest - current manifest.
 * @param entry - entry to store.
 * @returns a new manifest.
 */
export function upsertEntry(manifest, entry) {
  const entries = manifest.entries.filter(candidate => candidate.sessionId !== entry.sessionId)
  entries.push(entry)
  return { version: TRASH_VERSION, entries }
}

/**
 * Drop one entry without mutating the input.
 * @param manifest - current manifest.
 * @param sessionId - Session to drop.
 * @returns a new manifest.
 */
export function removeEntry(manifest, sessionId) {
  return { version: TRASH_VERSION, entries: manifest.entries.filter(entry => entry.sessionId !== sessionId) }
}

/**
 * Absolute trash directory for one Session under the plugin data directory.
 * @param dataDir - plugin data directory.
 * @param sessionId - Session id, escaped before use.
 * @param encode - session-id path escape.
 * @returns absolute directory path.
 */
export function trashDirectoryFor(dataDir, sessionId, encode) {
  return join(dataDir, 'trash', encode(sessionId))
}

/**
 * Read the manifest, tolerating a missing file.
 * @param dataDir - plugin data directory.
 * @returns the manifest and whether the file existed.
 */
export async function readManifest(dataDir) {
  const file = join(dataDir, 'trash.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { manifest: emptyManifest(), existed: false }
    throw error
  }
  try {
    return { manifest: normalizeManifest(JSON.parse(text)), existed: true }
  } catch {
    // A corrupt manifest must not wedge the plugin: keep starting from an
    // empty bin rather than failing every route.
    return { manifest: emptyManifest(), existed: true }
  }
}

/**
 * Persist the manifest atomically (temporary file + rename).
 * @param dataDir - plugin data directory.
 * @param manifest - manifest to write.
 */
export async function writeManifest(dataDir, manifest) {
  await mkdir(dataDir, { recursive: true })
  const file = join(dataDir, 'trash.json')
  const temporary = `${file}.tmp-${String(process.pid)}-${String(Date.now())}`
  await writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
  await rename(temporary, file)
}

/**
 * Whether a path exists (any type).
 * @param path - absolute path.
 * @returns whether it exists.
 */
export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Move a directory to a new absolute location, falling back to a copy when the
 * two paths live on different filesystems (rename would fail with EXDEV).
 * @param from - existing absolute source directory.
 * @param to - absolute destination path, which must not exist.
 */
export async function moveDirectory(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
  await rm(from, { recursive: true, force: true })
}

/**
 * Remove a directory tree if present.
 * @param path - absolute directory path.
 */
export async function removeDirectory(path) {
  await rm(path, { recursive: true, force: true })
}

/**
 * Describe one entry for the Client: remaining days, expiry, restorability.
 * Entries past their expiry wait for the next sweep when the policy is
 * `purge`, and are locked (visible but not restorable) when it is `lock`.
 * @param entry - manifest entry.
 * @param options - current time, retention policy, and whether files exist.
 * @returns presentation values.
 */
export function describeEntry(entry, { now, expireAction, hasFiles }) {
  const expired = entry.expiresAt > 0 && now >= entry.expiresAt
  const daysLeft = entry.expiresAt > 0
    ? Math.max(0, Math.ceil((entry.expiresAt - now) / DAY_MS))
    : null
  return {
    sessionId: entry.sessionId,
    title: entry.title,
    deletedAt: entry.deletedAt,
    expiresAt: entry.expiresAt,
    daysLeft,
    expired,
    locked: expired && expireAction === 'lock',
    restorable: !expired,
    hasFiles,
    workspaceId: entry.workspaceId,
  }
}
