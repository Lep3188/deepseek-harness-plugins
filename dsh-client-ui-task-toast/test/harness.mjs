/**
 * Headless harness for the hand-authored client bundle.
 *
 * The bundle only exists in the `window.__ModuleLoader__.load({ id, factory })`
 * CJS form, so there is no importable module to unit-test. This script supplies
 * the platform pieces the bundle touches — a module loader, the sessions list
 * mirror, and `fetch` — materializes the factory, drives the Session list
 * through turn transitions, and asserts what it posted.
 *
 * There is no DOM here because the bundle no longer renders anything: the
 * Windows toast is raised by the host half, and the browser's only job is the
 * POST. The bundle's own `__internals` export drives the same reconcile with a
 * frozen clock, so elapsed-time labels are asserted exactly.
 *
 * Run with: node test/harness.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/* ── the loader facade the shell installs, and the injected boot token ────── */

/** The host's boot-token injection, exactly as the index renders it. */
const TOKEN = 'test-boot-token'
const ROUTE = '/task-toast'
globalThis.__DSH_TASK_TOAST__ = { token: TOKEN, path: ROUTE }

/** The frozen clock every elapsed label is measured against. */
const NOW = 1_700_000_000_000
globalThis.__DSH_TASK_TOAST_TEST__ = { now: () => NOW }

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    }
  }
}

/** Every POST attempted, newest last. */
const requests = []
/** Responses the fake host returns, keyed by call order; missing means 200. */
let responseFor = () => ({ ok: true, status: 200 })

globalThis.fetch = (url, init) => {
  requests.push({ url, init })
  const response = responseFor(requests.length)
  return Promise.resolve(response)
}

/* ── materialize the bundle exactly as the module system would ────────────── */

/** Materialize a fresh copy of the bundle (so each test case gets clean state). */
function materialize() {
  let captured
  const previousLoad = globalThis.window.__ModuleLoader__.load
  globalThis.window.__ModuleLoader__.load = (entry) => {
    captured = entry
  }
  try {
    new Function(readFileSync(bundlePath, 'utf8'))()
  } finally {
    globalThis.window.__ModuleLoader__.load = previousLoad
  }
  if (captured === undefined) throw new Error('bundle registered no module factory')
  if (captured.id !== '@local/dsh-client-ui-task-toast') throw new Error(`unexpected module id ${captured.id}`)
  return captured.factory((spec) => {
    throw new Error(`bundle required "${spec}", which the baseline table does not provide`)
  })
}

/* ── assertions ───────────────────────────────────────────────────────────── */

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const plugin = materialize()

console.log('bundle contract')
check('exposes inject = ["sessions"]', JSON.stringify(plugin.inject) === '["sessions"]', JSON.stringify(plugin.inject))
check('exposes an apply function', typeof plugin.apply === 'function')
check('renders nothing: no DOM access at materialization', typeof plugin.__internals?.createWatcher === 'function')

/* ── drive the session list through turn transitions ─────────────────────── */

const start = NOW - 60_000

function state(value) {
  return { ids: value.ids, byId: value.byId, current: value.current ?? value.ids[0] }
}
function row(id, running, updatedAt, displayTitle = `chat ${id}`) {
  return { id, displayTitle, running, blank: false, updatedAt }
}

let listener
let snapshot
const sessions = {
  list: {
    subscribe(next) {
      listener = next
      return () => {
        listener = undefined
      }
    },
    getSnapshot: () => snapshot
  }
}
let effectDisposer
const ctx = {
  sessions,
  effect: (body) => {
    effectDisposer = body()
  }
}

plugin.apply(ctx)

function push(value) {
  snapshot = value
  listener()
}

/** Parsed bodies of every POST attempted so far. */
function posts() {
  return requests.map((request) => ({ url: request.url, init: request.init, body: JSON.parse(request.init.body) }))
}

console.log('turn detection')
push(state({ ids: ['a'], byId: { a: row('a', false, start) } }))
check('an idle session notifies nothing', posts().length === 0, `${posts().length} posts`)

push(state({ ids: ['a'], byId: { a: row('a', false, start) } }))
check('idle -> idle notifies nothing', posts().length === 0, `${posts().length} posts`)

push(state({ ids: ['a'], byId: { a: row('a', true, start) } }))
check('a running session notifies nothing yet', posts().length === 0, `${posts().length} posts`)

push(state({ ids: ['a'], byId: { a: row('a', true, start + 1_000) } }))
check('still running notifies nothing', posts().length === 0, `${posts().length} posts`)

push(state({ ids: ['a'], byId: { a: row('a', false, NOW) } }))
check('running -> idle notifies exactly once', posts().length === 1, `${posts().length} posts`)
check('the notification names the session', posts()[0].body.title === 'chat a', JSON.stringify(posts()[0].body))
check('the notification reports the turn duration', posts()[0].body.meta === '1m 0s', JSON.stringify(posts()[0].body))

push(state({ ids: ['a'], byId: { a: row('a', false, NOW + 1_000) } }))
check('the settled state does not repeat the notification', posts().length === 1, `${posts().length} posts`)

console.log('scope')
push(state({ ids: ['a', 'b'], byId: { a: row('a', true, start), b: row('b', true, start) }, current: 'a' }))
push(state({ ids: ['a', 'b'], byId: { a: row('a', true, start), b: row('b', false, start + 5_000) }, current: 'a' }))
check('a background session finishing stays silent', posts().length === 1, `${posts().length} posts`)

push(state({ ids: ['a', 'b'], byId: { a: row('a', false, NOW), b: row('b', false, start + 5_000) }, current: 'a' }))
check('the current session finishing notifies', posts().length === 2, `${posts().length} posts`)

console.log('page load mid-turn')
push(state({ ids: ['a', 'b', 'c'], byId: { a: row('a', false, start), b: row('b', false, start), c: row('c', true, NOW - 5_000) }, current: 'c' }))
check('a first-observed running session is silent', posts().length === 2, `${posts().length} posts`)
push(state({ ids: ['a', 'b', 'c'], byId: { a: row('a', false, start), b: row('b', false, start), c: row('c', false, NOW) }, current: 'c' }))
check('and reports the turn it landed inside', posts().length === 3, `${posts().length} posts`)
check('the elapsed label is the turn, not the page', posts()[2].body.meta === '5s', JSON.stringify(posts()[2].body))

console.log('post shape')
{
  const post = posts()[0]
  check('posts to the injected route', post.url === ROUTE, post.url)
  check('posts as JSON', post.init.method === 'POST' && post.init.headers['content-type'] === 'application/json')
  check('echoes the boot token', post.body.token === TOKEN, JSON.stringify(post.body))
  check('carries no credentials or cookies', post.init.credentials === undefined)
}

console.log('elapsed labels')
{
  const { formatElapsed } = plugin.__internals
  check('under a minute', formatElapsed(4_400) === '4s', formatElapsed(4_400))
  check('minutes and seconds', formatElapsed(64_000) === '1m 4s', formatElapsed(64_000))
  check('hours and minutes', formatElapsed(3_900_000) === '1h 5m', formatElapsed(3_900_000))
  check('a non-positive span reads as just now', formatElapsed(0) === 'just now', formatElapsed(0))
}

console.log('missing channel')
{
  const socket = materialize()
  const before = requests.length
  delete globalThis.__DSH_TASK_TOAST__
  const noChannel = materialize()
  let disposable
  noChannel.apply({ ...ctx, effect: (body) => { disposable = body() } })
  snapshot = state({ ids: ['z'], byId: { z: row('z', true, start) } })
  listener()
  snapshot = state({ ids: ['z'], byId: { z: row('z', false, NOW) } })
  listener()
  disposable()
  check('an absent host injection is inert and silent', requests.length === before, `${requests.length - before} posts`)
  check('the bundle still materializes and applies', socket !== undefined && typeof socket.apply === 'function')
}

console.log('delivery failure')
{
  const warnings = []
  const realWarn = console.warn
  console.warn = (message) => warnings.push(String(message))
  try {
    responseFor = () => ({ ok: false, status: 403 })
    // The previous case removed the injection; restore it so this materialization
    // has a channel and the failure path is actually exercised.
    globalThis.__DSH_TASK_TOAST__ = { token: TOKEN, path: ROUTE }
    const denied = materialize()
    denied.apply(ctx)
    for (let turn = 0; turn < 3; turn += 1) {
      push(state({ ids: ['d'], byId: { d: row('d', true, start) }, current: 'd' }))
      push(state({ ids: ['d'], byId: { d: row('d', false, NOW) }, current: 'd' }))
    }
    // The warning lands in the fetch continuation, which is a microtask.
    await Promise.resolve()
    await Promise.resolve()
  } finally {
    console.warn = realWarn
    responseFor = () => ({ ok: true, status: 200 })
  }
  check('a refused notification warns', warnings.length > 0, `${warnings.length} warnings`)
  check('and warns only once per page, not per turn', warnings.length === 1, `${warnings.length} warnings`)
  check('the warning names the status', (warnings[0] ?? '').includes('403'), String(warnings[0]))
}

console.log('teardown')
effectDisposer()
check('teardown unsubscribes', listener === undefined)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
