import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as host from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const testRoot = () => mkdtemp(join(here, '.tmp-'))

/**
 * Build the fake Host context, capture the plugin's routes, and settle the
 * activation-time reconcile.
 * @param options - fake services, config, and live stores.
 * @returns route caller, event emitter, and recorded calls.
 */
async function mountPlugin({ persistence, registry, sessions, agents, config = {}, configEditor, fiber }) {
  const routes = []
  const listeners = new Map()
  const warnings = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => undefined
      },
      getOrigin: () => 'http://127.0.0.1:59957',
    },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessions') return sessions
      if (name === 'agents') return agents
      if (name === 'configEditor') return configEditor
      return undefined
    },
    fiber: { entry: fiber },
    inject(dependencies, callback) {
      callback(ctx)
      return () => undefined
    },
    effect(callback) {
      return callback()
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => undefined
    },
    logger: {
      warn(...values) {
        warnings.push(values)
      },
    },
  }
  await host.apply(ctx, config)
  assert.equal(routes.length, 4, 'move, list, action, and settings routes are registered')
  // Reconcile is fire-and-forget; let its stat calls settle.
  await new Promise((done) => setTimeout(done, 20))
  return {
    routes,
    warnings,
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    /**
     * Call one registered route.
     * @param path - exact route path.
     * @param input - method, body, headers.
     * @returns status and parsed payload.
     */
    async call(path, input = {}) {
      const route = routes.find(candidate => candidate.path === path)
      assert.ok(route, `route ${path} registered`)
      const req = {
        method: input.method ?? (path.endsWith('/trash') ? 'GET' : 'POST'),
        headers: input.headers ?? {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        async *[Symbol.asyncIterator]() {
          if (input.body !== undefined) yield Buffer.from(JSON.stringify(input.body), 'utf8')
        },
      }
      const state = { status: null, body: null }
      const res = {
        writeHead(status) {
          state.status = status
        },
        end(body) {
          state.body = body
        },
      }
      await route.handler(req, res)
      return { status: state.status, payload: state.body === null ? null : JSON.parse(state.body) }
    },
  }
}

/**
 * A registry whose workspaces carry mutable session order, like the real one.
 * @param workspaces - initial workspace descriptions.
 * @param calls - recorded registry calls.
 * @returns the fake registry.
 */
function fakeRegistry(workspaces, calls) {
  const entities = workspaces.map(({ id, sessionIds }) => {
    const workspace = {
      id,
      sessionIds: [...sessionIds],
      async detachSession(target) {
        calls.detached.push(target)
        workspace.sessionIds = workspace.sessionIds.filter(value => value !== target)
      },
      async attachSession(target) {
        calls.attached.push(target)
        workspace.sessionIds = [target, ...workspace.sessionIds.filter(value => value !== target)]
      },
      async insertSessionBefore(target, before) {
        calls.inserted.push([target, before ?? null])
        const without = workspace.sessionIds.filter(value => value !== target)
        const at = before === undefined ? without.length : without.indexOf(before)
        workspace.sessionIds = [...without.slice(0, at), target, ...without.slice(at)]
      },
    }
    return workspace
  })
  const registry = {
    archivedSessionIds: [],
    pinnedSessionIds: [],
    list: () => entities,
    entities,
    async archiveSession(id, options) {
      calls.archived.push({ id, options })
      if (!registry.archivedSessionIds.includes(id)) registry.archivedSessionIds.push(id)
    },
    async unarchiveSession(id) {
      calls.unarchived.push(id)
      registry.archivedSessionIds = registry.archivedSessionIds.filter(value => value !== id)
    },
    async unpinSession(id) {
      calls.unpinned.push(id)
    },
  }
  return registry
}

/**
 * Create a materialized session directory under a temp sessions root.
 * @param root - sessions root.
 * @param sessionId - Session directory name.
 * @param project - project directory name.
 * @returns the absolute session directory.
 */
async function seedSession(root, sessionId, project = '--project--') {
  const sessionDir = join(root, project, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v3.jsonl'), '{"type":"session"}\n', 'utf8')
  return sessionDir
}

/**
 * A persistence fake reporting a real materialized location for one id.
 * @param root - sessions root.
 * @param sessionDir - session directory.
 * @returns the fake service.
 */
function fakePersistence(root, sessionDir) {
  return {
    config: { root },
    async stat(id) {
      if (id !== 's-1') return undefined
      return { header: { id, cwd: '/tmp/project' }, location: { kind: 'jsonl', path: join(sessionDir, 'session.v3.jsonl') } }
    },
  }
}

test('the plugin exposes the loader row, a host apply, and a validated Config', () => {
  assert.equal(host.name, 'session-delete')
  assert.equal(typeof host.apply, 'function')
  const defaults = host.Config({})
  assert.equal(defaults.retentionDays, 14)
  assert.equal(defaults.expireAction, 'purge')
  assert.equal(host.Config({ retentionDays: 7, expireAction: 'lock' }).expireAction, 'lock')
  assert.throws(() => host.Config({ retentionDays: 0 }))
  assert.throws(() => host.Config({ expireAction: 'nope' }))
})

test('routes refuse the wrong method, content type, and origin', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry: fakeRegistry([], calls),
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    const wrongMethod = await harness.call('/session-delete/trash/move', { method: 'GET', body: { sessionId: 's-1' } })
    assert.equal(wrongMethod.status, 405)
    const wrongType = await harness.call('/session-delete/trash/move', {
      headers: { 'content-type': 'text/plain', origin: 'http://127.0.0.1:59957' },
      body: { sessionId: 's-1' },
    })
    assert.equal(wrongType.status, 415)
    const crossOrigin = await harness.call('/session-delete/trash/move', {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: { sessionId: 's-1' },
    })
    assert.equal(crossOrigin.status, 403)
    const listWrongMethod = await harness.call('/session-delete/trash', { method: 'POST' })
    assert.equal(listWrongMethod.status, 405)
    // Headerless requests are the normal shape for a same-origin GET in a
    // WebView (no Origin, sometimes no Sec-Fetch-Site): they must be admitted.
    const headerlessGet = await harness.call('/session-delete/trash', { headers: {} })
    assert.equal(headerlessGet.status, 200)
    const headerlessPost = await harness.call('/session-delete/trash/move', {
      headers: { 'content-type': 'application/json' },
      body: { sessionId: 'no-such-id' },
    })
    assert.equal(headerlessPost.status, 200)
    assert.equal(headerlessPost.payload.empty, true)
    // An Origin that matches the request's own Host is same-origin even when
    // the listener advertises a different host form (proxy / publicUrl).
    const proxied = await harness.call('/session-delete/trash/move', {
      headers: {
        'content-type': 'application/json',
        origin: 'http://harness.example:8080',
        host: 'harness.example:8080',
      },
      body: { sessionId: 'no-such-id' },
    })
    assert.equal(proxied.status, 200)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('moving a Session records its workspace position and moves its log into the trash', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['a', 's-1', 'b'] }], calls)
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    const moved = await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1', displayTitle: 'Weekly report' } })
    assert.equal(moved.payload.ok, true)
    assert.equal(moved.payload.moved, true)
    assert.equal(moved.payload.title, 'Weekly report')
    assert.equal(moved.status, 200)
    // Log moved out of the sessions root.
    await assert.rejects(async () => { await stat(seed) })
    // Manifest recorded position and kept the Session archived.
    const manifest = JSON.parse(await readFile(join(root, 'data', 'trash.json'), 'utf8'))
    assert.equal(manifest.entries.length, 1)
    const entry = manifest.entries[0]
    assert.equal(entry.sessionId, 's-1')
    assert.equal(entry.workspaceId, 'w-1')
    assert.equal(entry.beforeSessionId, 'b')
    assert.equal(entry.index, 1)
    assert.equal(entry.sessionDir, seed)
    assert.deepEqual(calls.detached, ['s-1'])
    assert.equal(registry.archivedSessionIds.includes('s-1'), true, 'trashed Session stays hidden behind the archive set')
    assert.deepEqual(calls.unarchived, [])
    assert.equal(registry.entities[0].sessionIds.join(','), 'a,b')

    const list = await harness.call('/session-delete/trash')
    assert.equal(list.payload.ok, true)
    assert.equal(list.payload.retentionDays, 14)
    assert.equal(list.payload.expireAction, 'purge')
    assert.equal(list.payload.entries.length, 1)
    assert.equal(list.payload.entries[0].title, 'Weekly report')
    assert.equal(list.payload.entries[0].restorable, true)
    assert.equal(list.payload.entries[0].hasFiles, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restoring puts the log back and returns the row to its recorded position', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['a', 's-1', 'b'] }], calls)
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1', displayTitle: 'Weekly report' } })
    const restored = await harness.call('/session-delete/trash/action', { body: { action: 'restore', sessionId: 's-1' } })
    assert.equal(restored.payload.ok, true)
    assert.equal(restored.payload.title, 'Weekly report')
    assert.equal(restored.payload.workspaceRestored, true)
    // Log back at its original absolute directory.
    assert.equal((await stat(join(seed, 'session.v3.jsonl'))).isFile(), true)
    // Row back before its old anchor.
    assert.deepEqual(calls.attached, ['s-1'])
    assert.deepEqual(calls.inserted, [['s-1', 'b']])
    assert.equal(registry.entities[0].sessionIds.join(','), 'a,s-1,b')
    assert.equal(registry.archivedSessionIds.includes('s-1'), false)
    assert.deepEqual(calls.unarchived, ['s-1'])
    const manifest = JSON.parse(await readFile(join(root, 'data', 'trash.json'), 'utf8'))
    assert.equal(manifest.entries.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('permanent delete removes the moved files and the archive entry', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    const metadata = JSON.parse(await readFile(join(root, 'data', 'trash.json'), 'utf8'))
    const trashDir = metadata.entries[0].trashDir
    const purged = await harness.call('/session-delete/trash/action', { body: { action: 'purge', sessionId: 's-1' } })
    assert.equal(purged.payload.ok, true)
    await assert.rejects(async () => { await stat(trashDir) })
    assert.equal(registry.archivedSessionIds.includes('s-1'), false)
    assert.deepEqual(calls.unarchived, ['s-1'])
    const manifest = JSON.parse(await readFile(join(root, 'data', 'trash.json'), 'utf8'))
    assert.equal(manifest.entries.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('clearing the trash purges every entry', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const first = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const harness = await mountPlugin({
      persistence: fakePersistence(root, first),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    const purged = await harness.call('/session-delete/trash/action', { body: { action: 'purge-all' } })
    assert.equal(purged.payload.purged, 1)
    const manifest = JSON.parse(await readFile(join(root, 'data', 'trash.json'), 'utf8'))
    assert.equal(manifest.entries.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Session that is still live keeps the archive entry after a purge, and disposal clears it', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const sessions = { get: (id) => (id === 's-1' ? { id } : undefined) }
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      sessions,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    await harness.call('/session-delete/trash/action', { body: { action: 'purge', sessionId: 's-1' } })
    assert.equal(registry.archivedSessionIds.includes('s-1'), true, 'live Session stays hidden')
    assert.deepEqual(calls.unarchived, [])
    harness.emit('session/disposed', { id: 's-1' })
    await new Promise((done) => setTimeout(done, 20))
    assert.deepEqual(calls.unarchived, ['s-1'])
    assert.equal(registry.archivedSessionIds.includes('s-1'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the purge policy deletes expired entries at startup; the lock policy refuses restore', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const dataDir = join(root, 'data')
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir },
    })
    await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    const manifestFile = join(dataDir, 'trash.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.entries[0].expiresAt = Date.now() - 1
    await writeFile(manifestFile, JSON.stringify(manifest), 'utf8')
    const metadata = JSON.parse(await readFile(manifestFile, 'utf8'))
    const trashDir = metadata.entries[0].trashDir

    // A fresh activation reconciles and purges the expired entry.
    const restarted = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir },
    })
    await assert.rejects(async () => { await stat(trashDir) })
    const after = JSON.parse(await readFile(manifestFile, 'utf8'))
    assert.equal(after.entries.length, 0)
    assert.equal(registry.archivedSessionIds.includes('s-1'), false)
    assert.equal(restarted.routes.length, 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the lock policy keeps an expired entry and refuses restore', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const dataDir = join(root, 'data')
    const write = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'lock', dataDir },
    })
    await write.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    const manifestFile = join(dataDir, 'trash.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.entries[0].expiresAt = Date.now() - 1
    await writeFile(manifestFile, JSON.stringify(manifest), 'utf8')

    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'lock', dataDir },
    })
    await new Promise((done) => setTimeout(done, 20))
    const list = await harness.call('/session-delete/trash')
    assert.equal(list.payload.expireAction, 'lock')
    assert.equal(list.payload.entries[0].expired, true)
    assert.equal(list.payload.entries[0].locked, true)
    assert.equal(list.payload.entries[0].restorable, false)
    const restored = await harness.call('/session-delete/trash/action', { body: { action: 'restore', sessionId: 's-1' } })
    assert.equal(restored.payload.ok, false)
    assert.equal(restored.payload.error.code, 'EXPIRED')
    await assert.rejects(async () => { await stat(join(seed, 'session.v3.jsonl')) }, 'nothing was moved back')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unsafe reported path is refused before anything moves', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'session.v3.jsonl'), '{}\n', 'utf8')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const persistence = {
      config: { root: join(root, '--root--') },
      async stat() {
        return { header: { id: 's-1' }, location: { kind: 'jsonl', path: join(outside, 'session.v3.jsonl') } }
      },
    }
    const dataDir = join(root, 'data')
    const harness = await mountPlugin({
      persistence,
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir },
    })
    const result = await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    assert.equal(result.payload.ok, false)
    assert.equal(result.payload.error.code, 'UNSAFE_PATH')
    assert.deepEqual(calls.detached, [])
    assert.deepEqual(calls.archived, [])
    await assert.rejects(async () => { await readFile(join(dataDir, 'trash.json'), 'utf8') })
    assert.equal((await stat(join(outside, 'session.v3.jsonl'))).isFile(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Session that no longer exists resolves as an empty trash entry', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const registry = fakeRegistry([], calls)
    const persistence = { config: { root: join(root, 'root') }, stat: async () => undefined }
    const harness = await mountPlugin({
      persistence,
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    const result = await harness.call('/session-delete/trash/move', { body: { sessionId: 'gone' } })
    assert.equal(result.payload.ok, true)
    assert.equal(result.payload.empty, true)
    await assert.rejects(async () => { await readFile(join(root, 'data', 'trash.json'), 'utf8') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a second move for the same Session is refused', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const registry = fakeRegistry([{ id: 'w-1', sessionIds: ['s-1'] }], calls)
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry,
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    const again = await harness.call('/session-delete/trash/move', { body: { sessionId: 's-1' } })
    assert.equal(again.payload.ok, false)
    assert.equal(again.payload.error.code, 'ALREADY_TRASHED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the trash page can save the retention policy through the config editor', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const seed = await seedSession(root, 's-1')
    const edits = []
    const configEditor = {
      async edit(entry, change) {
        const current = { retentionDays: 14, expireAction: 'purge', dataDir: '/data' }
        edits.push({ entry, next: change(current) })
      },
    }
    const harness = await mountPlugin({
      persistence: fakePersistence(root, seed),
      registry: fakeRegistry([], calls),
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
      configEditor,
      fiber: { id: 'session-delete' },
    })

    const list = await harness.call('/session-delete/trash')
    assert.equal(list.payload.canSave, true)

    const saved = await harness.call('/session-delete/settings', {
      body: { retentionDays: 7, expireAction: 'lock' },
    })
    assert.equal(saved.payload.ok, true)
    assert.equal(saved.payload.retentionDays, 7)
    assert.equal(saved.payload.restarting, true)
    assert.equal(edits.length, 1)
    assert.equal(edits[0].entry.id, 'session-delete')
    assert.equal(edits[0].next.retentionDays, 7)
    assert.equal(edits[0].next.expireAction, 'lock')
    assert.equal(edits[0].next.dataDir, '/data', 'other config keys are preserved')

    for (const bad of [{ retentionDays: 0, expireAction: 'purge' }, { retentionDays: 999, expireAction: 'purge' }, { retentionDays: 7, expireAction: 'nope' }]) {
      const refused = await harness.call('/session-delete/settings', { body: bad })
      assert.equal(refused.status, 400)
      assert.equal(refused.payload.ok, false)
    }
    assert.equal(edits.length, 1, 'invalid values never reach the editor')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('without a config editor the page reports that settings cannot be saved', async () => {
  const root = await testRoot()
  try {
    const calls = { archived: [], unarchived: [], detached: [], attached: [], inserted: [], unpinned: [] }
    const harness = await mountPlugin({
      persistence: { config: { root: join(root, 'root') }, stat: async () => undefined },
      registry: fakeRegistry([], calls),
      config: { retentionDays: 14, expireAction: 'purge', dataDir: join(root, 'data') },
    })
    const list = await harness.call('/session-delete/trash')
    assert.equal(list.payload.canSave, false)
    const saved = await harness.call('/session-delete/settings', {
      body: { retentionDays: 14, expireAction: 'purge' },
    })
    assert.equal(saved.payload.ok, false)
    assert.equal(saved.payload.error.code, 'SETTINGS_UNAVAILABLE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
