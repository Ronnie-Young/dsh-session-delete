import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

/**
 * Load the plain-JS client bundle the way the page does: one
 * `window.__ModuleLoader__.load` call whose factory returns the plugin object.
 * @returns the captured definition, console errors, and the vm sandbox.
 */
async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const loaded = []
  const errors = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => loaded.push(definition) } },
    document: {
      head: { appendChild() {} },
      createElement() {
        return { setAttribute() {}, remove() {}, textContent: '' }
      },
      addEventListener() {},
      removeEventListener() {},
      activeElement: null,
      visibilityState: 'visible',
    },
    HTMLElement: class {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    console: {
      log() {},
      error(...values) {
        errors.push(values)
      },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the bundle registers exactly one client plugin')
  assert.equal(loaded[0].id, 'dsh-session-delete')
  return { definition: loaded[0], errors, sandbox }
}

/**
 * Minimal React stand-in that keeps a traversable element tree, so a test can
 * press the dialog buttons the same way a click would.
 * @returns the fake module.
 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/**
 * Walk an element tree and return every node matching a predicate.
 * @param tree - root element or child list.
 * @param predicate - node test.
 * @returns matching nodes.
 */
function findNodes(tree, predicate) {
  const found = []
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (predicate(node)) found.push(node)
    visit(node.children)
  }
  visit(tree)
  return found
}

/**
 * Build a client context that records every registration and resolves locale
 * keys the way the real service does.
 * @param state - mutable active locale id.
 * @returns the fake context plus its recordings.
 */
function fakeContext(state) {
  const recordings = { slots: [], menus: [], dicts: [], effects: [] }
  const byNamespace = new Map()
  const translate = (namespace, key, params) => {
    const dictionaries = byNamespace.get(namespace)
    const template = dictionaries?.[state.locale]?.[key] ?? dictionaries?.en?.[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
  }
  const ctx = {
    effect(callback, label) {
      recordings.effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'uiWorkspace') {
        return {
          archiveSession: async () => undefined,
          unarchiveSession: async () => undefined,
        }
      }
      if (name === 'sessions') {
        return {
          refresh: async () => undefined,
          handleSessionRemoved() {},
        }
      }
      return undefined
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        recordings.slots.push({ ...options, component })
        return () => {}
      },
    },
    locale: {
      register(namespace, dictionaries) {
        recordings.dicts.push({ namespace, dictionaries })
        byNamespace.set(namespace, dictionaries)
        return () => {}
      },
      bind(namespace) {
        return (key, params) => translate(namespace, key, params)
      },
    },
    contextMenus: {
      register(contribution) {
        recordings.menus.push(contribution)
        return () => {}
      },
      notify() {},
    },
  }
  return { ctx, recordings }
}

/**
 * Install a fetch stub that answers by route.
 * @param sandbox - vm sandbox the bundle runs in.
 * @param routes - path to payload map.
 * @returns the recorded fetch calls.
 */
function stubFetch(sandbox, routes) {
  const calls = []
  sandbox.fetch = async (url, options) => {
    calls.push({ url, options })
    const payload = routes[url] ?? { ok: true }
    const status = payload.status ?? 200
    return { ok: status === 200, status, json: async () => payload }
  }
  return calls
}

test('the client half loads and registers without console errors', async () => {
  const { definition, errors } = await loadClient()
  const { ctx } = fakeContext({ locale: 'zh' })
  const plugin = definition.factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected module request: ${name}`)
  })
  assert.equal(JSON.stringify(plugin.inject), JSON.stringify(['slots', 'locale', 'contextMenus']))
  plugin.apply(ctx)
  assert.deepEqual(errors, [])
})

test('both dictionaries carry the same keys', async () => {
  const { definition } = await loadClient()
  const { ctx, recordings } = fakeContext({ locale: 'en' })
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  assert.equal(recordings.dicts.length, 1)
  assert.equal(recordings.dicts[0].namespace, 'sessionDelete')
  const { zh, en } = recordings.dicts[0].dictionaries
  assert.equal(Object.keys(zh).length > 40, true)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const value of Object.values(en)) assert.notEqual(value, '')
})

test('registers the dialog, the menu glyph, the sidebar entry, and its page', async () => {
  const { definition } = await loadClient()
  const { ctx, recordings } = fakeContext({ locale: 'zh' })
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  const names = recordings.slots.map((slot) => slot.name).sort()
  assert.deepEqual(names, ['contextMenu.icon', 'main', 'shell.overlay', 'sidebar.panellist'])
  const overlay = recordings.slots.find((slot) => slot.name === 'shell.overlay')
  assert.equal(overlay.id, 'session-delete.confirm')
  const glyph = recordings.slots.find((slot) => slot.name === 'contextMenu.icon')
  assert.equal(glyph.key, 'session-delete.trash')
  const entry = recordings.slots.find((slot) => slot.name === 'sidebar.panellist')
  assert.equal(entry.id, 'session-delete')
  assert.equal(entry.order, 40)
  assert.equal(typeof entry.label, 'function')
  assert.equal(entry.label(), '回收站')
  const page = recordings.slots.find((slot) => slot.name === 'main')
  assert.equal(page.key, 'session-delete')
})

test('contributes one reversible Session menu row after Archive', async () => {
  const { definition } = await loadClient()
  const { ctx, recordings } = fakeContext({ locale: 'zh' })
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  assert.equal(recordings.menus.length, 1)
  const contribution = recordings.menus[0]
  assert.equal(contribution.id, 'session.delete')
  assert.equal(contribution.target, 'session')
  assert.equal(contribution.order, 700)
  const actions = contribution.resolve({ sessionId: 's-1', displayTitle: '项目周报' })
  assert.equal(actions.length, 1)
  const action = actions[0]
  assert.equal(action.id, 'delete')
  assert.equal(action.label, '移到回收站')
  assert.equal(action.danger, undefined, 'a reversible move is not styled as destructive')
  assert.equal(action.separatorBefore, true)
  assert.equal(action.afterContent, true)
  assert.equal(action.icon.key, 'session-delete.trash')
  assert.equal(action.failureLabel, '会话没有移入回收站，请重试。')
  assert.equal(action.run({ sessionId: 's-1' }), undefined)
})

test('the menu label follows the active locale at open time', async () => {
  const { definition } = await loadClient()
  const state = { locale: 'en' }
  const { ctx, recordings } = fakeContext(state)
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  const contribution = recordings.menus[0]
  assert.equal(contribution.resolve({ sessionId: 's-1' })[0].label, 'Move to trash')
  state.locale = 'zh'
  assert.equal(contribution.resolve({ sessionId: 's-1' })[0].label, '移到回收站')
})

test('the confirmed move archives, calls the trash route, and offers Restore in the toast', async () => {
  const { definition, sandbox } = await loadClient()
  const calls = { archived: [], removed: [], notified: [], fetched: [], refreshed: 0 }
  const { ctx, recordings } = fakeContext({ locale: 'en' })
  ctx.get = (name) => {
    if (name === 'uiWorkspace') {
      return {
        archiveSession: async (sessionId, options) => {
          calls.archived.push({ sessionId, options })
        },
        unarchiveSession: async () => undefined,
      }
    }
    if (name === 'sessions') {
      return {
        refresh: async () => {
          calls.refreshed += 1
        },
        handleSessionRemoved: (sessionId) => {
          calls.removed.push(sessionId)
        },
      }
    }
    return undefined
  }
  ctx.contextMenus.notify = (...values) => {
    calls.notified.push(values)
  }
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  const fetchCalls = stubFetch(sandbox, {
    '/session-delete/trash': { ok: true, retentionDays: 14, expireAction: 'purge', entries: [] },
    '/session-delete/trash/move': { ok: true, moved: true, title: 'Weekly report', retentionDays: 14 },
    '/session-delete/trash/action': { ok: true, title: 'Weekly report' },
  })

  const contribution = recordings.menus[0]
  const [action] = contribution.resolve({ sessionId: 's-1', displayTitle: 'Weekly report' })
  action.run()
  const overlay = recordings.slots.find((slot) => slot.name === 'shell.overlay')
  const tree = overlay.component({})
  const confirm = findNodes(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-button-primary'))
  const cancel = findNodes(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-button-outline'))
  assert.equal(confirm.length, 1)
  assert.equal(cancel.length, 1)
  assert.equal(joinText(confirm[0]), 'Move to trash')
  cancel[0].props.onClick()
  assert.deepEqual(calls.archived, [])
  assert.equal(fetchCalls.length, 1, 'only the trash list was read while the menu was open')

  action.run()
  const reopened = overlay.component({})
  const confirmAgain = findNodes(reopened, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-button-primary'))
  await press(confirmAgain[0], 60)

  assert.equal(calls.archived.length, 1)
  assert.equal(calls.archived[0].options.stopActivity, true)
  const move = fetchCalls.find(call => call.url === '/session-delete/trash/move')
  assert.equal(move.options.method, 'POST')
  assert.equal(JSON.parse(move.options.body).sessionId, 's-1')
  assert.equal(JSON.parse(move.options.body).displayTitle, 'Weekly report')
  assert.deepEqual(calls.removed, ['s-1'])
  assert.equal(calls.refreshed, 0, 'a move must not refresh the list that still contains the Session')
  assert.equal(calls.notified.length, 1)
  assert.equal(calls.notified[0][0], 'Moved “Weekly report” to the trash')
  assert.equal(calls.notified[0][1], true)
  const toastAction = calls.notified[0][2]
  assert.equal(toastAction.label, 'Restore')
  assert.equal(typeof toastAction.run, 'function')

  // Pressing the toast's Restore action restores through the action route.
  toastAction.run()
  await settle(60)
  const restore = fetchCalls.find(call => call.url === '/session-delete/trash/action')
  assert.equal(JSON.parse(restore.options.body).action, 'restore')
  assert.equal(calls.refreshed >= 1, true, 'restoring makes the row visible again')
  assert.equal(calls.notified[calls.notified.length - 1][0], 'Restored “Weekly report”')
})

test('the trash page shows the graphical settings and posts the chosen policy', async () => {
  const { definition, sandbox } = await loadClient()
  const calls = { notify: [], settings: [] }
  const { ctx, recordings } = fakeContext({ locale: 'en' })
  ctx.contextMenus.notify = (...values) => calls.notify.push(values)
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  const fetchCalls = stubFetch(sandbox, {
    '/session-delete/trash': {
      ok: true,
      retentionDays: 14,
      expireAction: 'purge',
      canSave: true,
      entries: [],
    },
    '/session-delete/settings': { ok: true, retentionDays: 7, expireAction: 'lock', restarting: true },
  })
  // Opening the dialog loads the shared trash state with the policy.
  recordings.menus[0].resolve({ sessionId: 's-1' })[0].run()
  await settle(30)

  const en = recordings.dicts[0].dictionaries.en
  const translate = (key, params) => {
    const template = en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
  }
  const page = recordings.slots.find((slot) => slot.name === 'main')
  const tree = page.component({ t: translate })
  const inputs = findNodes(tree, (node) => node.type === 'input')
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].props.value, '14')
  assert.equal(inputs[0].props.min, 1)
  assert.equal(inputs[0].props.max, 365)
  const radios = findNodes(tree, (node) => node.props?.role === 'radio')
  assert.equal(radios.length, 2)
  assert.equal(radios[0].props['aria-checked'], 'true')
  assert.equal(radios[1].props['aria-checked'], 'false')
  const save = findNodes(tree, (node) => node.type === 'button' && joinText(node) === 'Save settings')
  assert.equal(save.length, 1)
  assert.equal(save[0].props.disabled, true, 'an unchanged policy cannot be saved twice')

  // Pressing save posts the seeded policy to the settings route.
  save[0].props.onClick()
  await settle(60)
  const posted = fetchCalls.find(call => call.url === '/session-delete/settings')
  assert.equal(posted.options.method, 'POST')
  assert.deepEqual(JSON.parse(posted.options.body), { retentionDays: 14, expireAction: 'purge' })
  assert.equal(calls.notify.length, 1)
  assert.equal(calls.notify[0][0], 'Settings saved')
})

test('settings are unavailable when the Host cannot save configuration', async () => {
  const { definition, sandbox } = await loadClient()
  const { ctx, recordings } = fakeContext({ locale: 'en' })
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  stubFetch(sandbox, {
    '/session-delete/trash': { ok: true, retentionDays: 14, expireAction: 'purge', canSave: false, entries: [] },
  })
  recordings.menus[0].resolve({ sessionId: 's-1' })[0].run()
  await settle(30)
  const en = recordings.dicts[0].dictionaries.en
  const translate = (key, params) => {
    const template = en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
  }
  const page = recordings.slots.find((slot) => slot.name === 'main')
  const tree = page.component({ t: translate })
  assert.equal(findNodes(tree, (node) => node.type === 'input').length, 0)
  const note = findNodes(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshsd-notice'))
  assert.match(joinText(note[0]), /cordis.patch.yml/)
})

test('a Host generation without the trash routes is reported as restart-needed and the archive is undone', async () => {
  const { definition, sandbox } = await loadClient()
  const calls = { archived: [], unarchived: [], removed: [] }
  const { ctx, recordings } = fakeContext({ locale: 'en' })
  ctx.get = (name) => {
    if (name === 'uiWorkspace') {
      return {
        archiveSession: async () => {
          calls.archived.push('s-1')
        },
        unarchiveSession: async () => {
          calls.unarchived.push('s-1')
        },
      }
    }
    if (name === 'sessions') return { handleSessionRemoved: (id) => calls.removed.push(id) }
    return undefined
  }
  ctx.contextMenus.notify = () => {}
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  stubFetch(sandbox, {
    '/session-delete/trash': { status: 404 },
    '/session-delete/trash/move': { status: 404 },
  })
  const [action] = recordings.menus[0].resolve({ sessionId: 's-1', displayTitle: 'Old chat' })
  action.run()
  const overlay = recordings.slots.find((slot) => slot.name === 'shell.overlay')
  const confirm = findNodes(overlay.component({}), (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-button-primary'))
  await press(confirm[0], 60)
  assert.deepEqual(calls.archived, ['s-1'])
  assert.deepEqual(calls.unarchived, ['s-1'], 'the archive is rolled back')
  assert.deepEqual(calls.removed, [], 'the row is not dropped when nothing moved')
  const reopened = overlay.component({})
  const error = findNodes(reopened, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-error'))
  assert.equal(error.length, 1)
  assert.match(joinText(error[0]), /app restart/)
})

test('the trash page renders entries with restore and permanent-delete actions', async () => {
  const { definition, sandbox } = await loadClient()
  const { ctx, recordings } = fakeContext({ locale: 'en' })
  const plugin = definition.factory((name) => (name === 'react' ? fakeReact() : null))
  plugin.apply(ctx)
  const now = Date.now()
  stubFetch(sandbox, {
    '/session-delete/trash': {
      ok: true,
      retentionDays: 14,
      expireAction: 'purge',
      entries: [{
        sessionId: 's-1',
        title: 'Old chat',
        deletedAt: now - 86_400_000 * 3,
        expiresAt: now + 86_400_000 * 11,
        daysLeft: 11,
        expired: false,
        locked: false,
        restorable: true,
        hasFiles: true,
      }],
    },
  })
  // Opening the dialog reads the trash list and fills the shared store.
  const contribution = recordings.menus[0]
  contribution.resolve({ sessionId: 's-1' })[0].run()
  await settle(30)

  const en = recordings.dicts[0].dictionaries.en
  const translate = (key, params) => {
    const template = en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
  }
  const page = recordings.slots.find((slot) => slot.name === 'main')
  const tree = page.component({ t: translate })
  const titles = findNodes(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-row-title'))
  assert.equal(titles.length, 1)
  assert.equal(joinText(titles[0]), 'Old chat')
  const buttons = findNodes(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-small'))
  const labels = buttons.map(joinText)
  assert.equal(labels.includes('Restore'), true)
  assert.equal(labels.includes('Delete permanently'), true)
  const subtitle = findNodes(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-page-sub'))
  assert.match(joinText(subtitle[0]), /14 days/)

  const icon = recordings.slots.find((slot) => slot.name === 'sidebar.panellist')
  const iconTree = icon.component({ size: 18, active: false })
  assert.equal(findNodes(iconTree, (node) => node.type === 'svg').length, 1)
  const badge = findNodes(iconTree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dshsd-icon-badge'))
  assert.equal(badge.length, 1, 'a non-empty trash shows a count')
  assert.equal(joinText(badge[0]), '1')
})

/**
 * Concatenate an element's text children.
 * @param node - rendered element.
 * @returns its text content.
 */
function joinText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(joinText).join('')
  return joinText(node.children)
}


/**
 * Press a dialog button and let its asynchronous flow settle.
 * @param button - rendered button node.
 * @param delayMs - settle window.
 */
async function press(button, delayMs) {
  button.props.onClick()
  await settle(delayMs)
}

/**
 * Let queued promises and timers run.
 * @param delayMs - window length.
 */
async function settle(delayMs) {
  await new Promise((done) => setTimeout(done, delayMs))
}
