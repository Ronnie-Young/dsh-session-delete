/**
 * Path safety for session-log deletion.
 *
 * The JSONL backend reports each stored session's artifact as
 * `location: { kind: 'jsonl', path }`, and the session owns the *directory*
 * that holds that artifact (all format generations live beside it). Deleting a
 * session therefore means removing that directory, which makes one wrong path
 * catastrophic. These checks are pure string work so they can be unit tested;
 * the caller still confirms with the filesystem that the directory exists and
 * is not a symlink target it did not expect.
 *
 * @module dsh-session-delete/lib/path-guard
 */
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

/**
 * Whether `candidate` is the same path as, or nested under, `root`.
 * @param root - absolute root directory.
 * @param candidate - absolute path to test.
 * @returns true when candidate is root itself or below it.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return candidate.startsWith(prefix)
}

/**
 * Check the reported session directory against the backend layout before
 * anything is removed.
 *
 * A session directory sits one level below a project directory, which itself
 * sits one level below the persistence root (`<root>/--<project>--/<session>`).
 * A path that is the root, a project directory, or outside the root is refused.
 *
 * @param directory - directory the backend reported for the session artifact.
 * @param root - configured persistence root, when the backend exposes it.
 * @returns an ok result with the resolved directory, or a refusal reason.
 */
export function checkSessionDirectory(directory, root) {
  if (typeof directory !== 'string' || directory === '') {
    return { ok: false, reason: 'the session log reports an empty directory' }
  }
  if (!isAbsolute(directory)) {
    return { ok: false, reason: `the session directory is not absolute: ${directory}` }
  }
  const resolvedDirectory = resolve(directory)
  const name = basename(resolvedDirectory)
  if (name === '' || name === '.' || name === '..' || name === sep) {
    return { ok: false, reason: `the session directory has no usable final segment: ${resolvedDirectory}` }
  }
  // Project directories are shared by every session of one working directory;
  // `_no-cwd` is the project directory for sessions without one.
  if (name === '_no-cwd' || (name.startsWith('--') && name.endsWith('--'))) {
    return {
      ok: false,
      reason: `the reported directory is a project directory, not one session's own directory: ${resolvedDirectory}`,
    }
  }
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    return { ok: true, directory: resolvedDirectory }
  }
  const resolvedRoot = resolve(root)
  if (resolvedDirectory === resolvedRoot) {
    return { ok: false, reason: 'the reported directory is the session root itself' }
  }
  if (!isInside(resolvedRoot, dirname(resolvedDirectory))) {
    return {
      ok: false,
      reason: `the reported directory is outside the session root ${resolvedRoot}: ${resolvedDirectory}`,
    }
  }
  return { ok: true, directory: resolvedDirectory }
}

/**
 * Encode an arbitrary string as one safe path segment, injectively.
 *
 * This is the session-persistence backend's own escape rule (`~XXXX` for every
 * code unit outside `[A-Za-z0-9._-]`, with `.` and `..` special-cased), copied
 * here so the trash directory name for a Session id can never traverse. A
 * Session id is an unvalidated branded string; using it raw in a path would be
 * a traversal bug.
 *
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string') throw new TypeError('encodeSegment requires a string')
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
