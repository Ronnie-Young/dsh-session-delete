import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import { checkSessionDirectory, encodeSegment, isInside } from '../lib/path-guard.js'

test('isInside accepts the root itself and direct children only', () => {
  assert.equal(isInside('/root', '/root'), true)
  assert.equal(isInside('/root', `/root${sep}project`), true)
  assert.equal(isInside('/root', '/rooted/project'), false)
  assert.equal(isInside('/root', '/other'), false)
})

test('a session directory under the configured root is accepted', () => {
  const root = resolve('/tmp/dsh/root')
  const directory = resolve(root, '--Users-me-project--', 'session-1')
  assert.deepEqual(checkSessionDirectory(directory, root), { ok: true, directory })
})

test('_no-cwd project sessions are accepted as session directories', () => {
  const root = resolve('/tmp/dsh/root')
  const directory = resolve(root, '_no-cwd', 'session-1')
  assert.equal(checkSessionDirectory(directory, root).ok, true)
})

test('the root itself is refused', () => {
  const root = resolve('/tmp/dsh/root')
  const result = checkSessionDirectory(root, root)
  assert.equal(result.ok, false)
  assert.match(result.reason, /root itself/)
})

test('a project directory is refused even though it sits under the root', () => {
  const root = resolve('/tmp/dsh/root')
  const project = resolve(root, '--Users-me-project--')
  const result = checkSessionDirectory(project, root)
  assert.equal(result.ok, false)
  assert.match(result.reason, /project directory/)
})

test('a directory outside the configured root is refused', () => {
  const root = resolve('/tmp/dsh/root')
  const result = checkSessionDirectory(resolve('/tmp/elsewhere/session-1'), root)
  assert.equal(result.ok, false)
  assert.match(result.reason, /outside the session root/)
})

test('a parent directory of the root is refused', () => {
  const root = resolve('/tmp/dsh/root')
  const result = checkSessionDirectory(resolve(root, '..', 'session-1'), root)
  assert.equal(result.ok, false)
})

test('relative, empty, and traversing spellings are refused', () => {
  assert.equal(checkSessionDirectory('', '/root').ok, false)
  assert.equal(checkSessionDirectory('relative/session-1', '/root').ok, false)
  assert.equal(checkSessionDirectory('.', '/root').ok, false)
})

test('the session directory is accepted without a known root', () => {
  const directory = resolve('/tmp/dsh/root/--proj--/session-1')
  assert.deepEqual(checkSessionDirectory(directory, undefined), { ok: true, directory })
})

test('session ids are escaped to one safe path segment', () => {
  assert.equal(encodeSegment('session-1'), 'session-1')
  assert.equal(encodeSegment('a.b_c-d'), 'a.b_c-d')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a\\b'), 'a~005Cb')
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
  // The dots stay literal; the separator is escaped, so no traversal survives.
  assert.equal(encodeSegment('../x'), '..~002Fx')
  assert.equal(encodeSegment('a\u0000b'), 'a~0000b')
  assert.equal(encodeSegment('a/b') === encodeSegment('a~002Fb'), false)
  assert.throws(() => encodeSegment(''))
})
