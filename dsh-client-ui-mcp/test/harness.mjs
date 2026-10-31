#!/usr/bin/env node
/**
 * Headless checks for the browser half.
 *
 * The bundle is a hand-authored `window.__ModuleLoader__.load({ id, factory })`
 * module with no importable file, so this harness supplies the minimum platform
 * it touches — a module loader, `react`, `react/jsx-runtime`, `document`, and
 * `fetch` — materializes the factory, and asserts two things that matter:
 *
 *   1. it registers itself as a Settings section (the objective's "have a
 *      section in the UI"), and
 *   2. it renders the empty state when the host reports zero servers, instead of
 *      rendering nothing.
 *
 * The React stand-in calls each function component once. That is enough for a
 * component whose branching is plain and whose hooks are read-only; it is not a
 * renderer, and it deliberately does not try to be one.
 *
 * Run with: node test/harness.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ── a React small enough to reason about ────────────────────────────────── */

/**
 * Minimal element description: enough for the harness to search by tag/text.
 * The automatic runtime passes `children` inside props, so it is read from
 * there — that is the shape the bundle actually emits.
 */
function element(type, props, ...children) {
  const given = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
  const fromProps = props?.children === undefined ? [] : [props.children].flat().filter((child) => child !== null && child !== undefined && child !== false)
  const { children: _ignored, ...rest } = props ?? {}
  return { type, props: rest, children: given.length > 0 ? given : fromProps }
}
const Fragment = Symbol('Fragment')

/**
 * Walk an element tree, rendering nested function components and collecting the
 * text and host-element class names it produces.
 *
 * Nested components matter: the section renders `ServerCard` per server, and a
 * walker that stopped at the component element would find no server text at all.
 * @param node - element, array, or primitive.
 * @param out - accumulator with `text` and `classNames`.
 */
function walk(node, out = { text: [], classNames: [] }) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return out
  }
  if (typeof node.type === 'function') {
    // A component: render it with its props so its own output is inspected. The
    // hook cursor is deliberately not reset — it advances monotonically through
    // one render, exactly as React orders hooks.
    walk(node.type(node.props ?? {}), out)
    return out
  }
  if (typeof node.props?.className === 'string') out.classNames.push(node.props.className)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** Every string in a tree, joined — used to assert on rendered copy. */
function textOf(node) {
  return walk(node).text.join(' ')
}

/**
 * Find the first host element satisfying a predicate.
 *
 * Descends into function components *without* touching the hook cursor: the
 * cursor belongs to one top-level render, and resetting it here would hand the
 * nested component the parent's hook slots.
 */
function findHost(node, predicate) {
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHost(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (typeof node.type === 'function') return findHost(node.type(node.props ?? {}), predicate)
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findHost(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** The click handler on a control, if it has one. */
function findClickHandler(node) {
  return typeof node?.props?.onClick === 'function' ? node.props.onClick : undefined
}

/** The form element in a tree, if present. */
function findForm(node) {
  return findHost(node, (item) => item.type === 'form')
}

let stateIndex = 0
const stateValues = []
/** Effect bodies captured during the current render, run by {@link render}. */
let pendingEffects = []
const react = {
  useState(initial) {
    const index = stateIndex
    stateIndex += 1
    if (!(index in stateValues)) stateValues[index] = typeof initial === 'function' ? initial() : initial
    return [stateValues[index], (next) => {
      stateValues[index] = typeof next === 'function' ? next(stateValues[index]) : next
    }]
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useEffect(effect) {
    pendingEffects.push(effect)
  }
}
const jsx = {
  jsx: (type, props) => element(type, props),
  jsxs: (type, props) => element(type, props),
  Fragment
}

/* ── the loader facade and the host's boot token ─────────────────────────── */

globalThis.__DSH_MCP_UI__ = { token: 'test-token', path: '/mcp-ui' }
globalThis.document = {
  head: { appendChild() {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', appendChild() {} })
}

/** Responses the fake host returns for GET /mcp-ui, newest use last. */
let listPayload = { path: 'C:\\probe\\cordis.patch.yml', servers: [] }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => listPayload })

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    }
  }
}

const source = readFileSync(BUNDLE, 'utf8')
new Function(source)()
if (registration === undefined) throw new Error('the bundle registered no factory')

const plugin = registration.factory((spec) => {
  if (spec === 'react') return react
  if (spec === 'react/jsx-runtime') return jsx
  throw new Error(`unexpected require("${spec}") — the bundle must stay on the platform baseline`)
})

/* ── assertions ──────────────────────────────────────────────────────────── */

console.log('bundle contract')
check('the module id is the package name', registration.id === '@local/dsh-client-ui-mcp', registration.id)
check('it injects the slot registry', JSON.stringify(plugin.inject) === '["slots"]', JSON.stringify(plugin.inject))
check('it exposes apply', typeof plugin.apply === 'function')
check('it requests nothing outside the platform baseline', true)

/** Capture the section registration. */
let registrationCall
let injectedInto
const ctx = {
  slots: {
    inject(name, callback) {
      injectedInto = name
      callback()
    },
    register(options, component) {
      registrationCall = { options, component }
      return () => {}
    }
  }
}
plugin.apply(ctx)

console.log('settings section')
check('it injects into the settings section slot', injectedInto === 'settings.section', String(injectedInto))
check('it registers exactly one section', registrationCall !== undefined)
check('the section targets the settings section slot', registrationCall?.options?.name === 'settings.section', JSON.stringify(registrationCall?.options))
check('the section has a stable id', registrationCall?.options?.id === 'mcp-servers', JSON.stringify(registrationCall?.options))
// The settings shell lists sections by `resolveSlotLabel(options.label)`, so a
// section without a label is composed but unreachable from the navigation. This
// is the regression guard for exactly that.
check('the section carries a navigation label', typeof registrationCall?.options?.label === 'function', typeof registrationCall?.options?.label)
check('the label reads as a section name', registrationCall?.options?.label?.() === 'MCP servers', String(registrationCall?.options?.label?.()))
check('the section renders a component', typeof registrationCall?.component === 'function')

/**
 * Give the render buffer a fresh start, once per test case.
 *
 * Called *before* a component's first render and never in between, so the state a
 * render seeds survives into the post-effect render. That is the whole point: the
 * loading state exists precisely because the fetch has not resolved yet.
 */
function resetRenderBuffer() {
  stateIndex = 0
  stateValues.length = 0
  pendingEffects = []
}

/**
 * Render the section and let its data load settle.
 *
 * Runs the loading render, then its fetch effect, then re-renders — which is the
 * state the assertions are about. State is intentionally *not* reset here: a
 * test case that clicks something must carry the resulting state into the next
 * render. Call {@link resetRenderBuffer} once per case instead.
 * @returns the settled render's element tree.
 */
async function render() {
  stateIndex = 0
  pendingEffects = []
  registrationCall.component({})
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) effect()
  // `load()` awaits the fetch and then the JSON body, so several microtask turns
  // separate the effect from the loaded state; a macrotask turn is the simple
  // guarantee that both have settled.
  await new Promise((resolve) => setTimeout(resolve, 0))
  stateIndex = 0
  return registrationCall.component({})
}

/** Re-render after a state change, without running effects again. */
function rerender() {
  stateIndex = 0
  pendingEffects = []
  return registrationCall.component({})
}

console.log('the empty state')
resetRenderBuffer()
const empty = await render()
const emptyText = textOf(empty)
check('it says there are no servers configured', /No MCP servers are configured/.test(emptyText), emptyText.slice(0, 200))
check('it offers the add affordance', /Add server/.test(emptyText), emptyText.slice(0, 200))
check('it names the file it manages', /cordis\.patch\.yml/.test(emptyText), emptyText.slice(0, 200))
check('it renders a list container', walk(empty).classNames.includes('dsh-mcp_root'), JSON.stringify(walk(empty).classNames))

console.log('the populated state')
resetRenderBuffer()
listPayload = {
  path: 'C:\\probe\\cordis.patch.yml',
  servers: [
    {
      id: 'mcp-probe',
      serverName: 'probe',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      ok: true,
      tools: [{ name: 'echo', description: 'Echo text.', parameters: ['text'], required: ['text'] }]
    },
    { id: 'mcp-dead', serverName: 'dead', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', ok: false, error: 'connect ECONNREFUSED' }
  ]
}
const populated = await render()
const populatedText = textOf(populated)
check('it does not show the empty state', !/No MCP servers are configured/.test(populatedText))
check('it names each server', /probe/.test(populatedText) && /dead/.test(populatedText), populatedText.slice(0, 300))
check('it qualifies tools with the server prefix', /mcp__probe__echo/.test(populatedText), populatedText.slice(0, 300))
check('it shows a live server as connected', /connected/.test(populatedText))
check('it shows the failure reason for an unreachable server', /ECONNREFUSED/.test(populatedText), populatedText.slice(0, 400))
check('it offers to test and remove', /Test connection/.test(populatedText) && /Remove/.test(populatedText))
check('it counts the tools', /1 tool/.test(populatedText), populatedText.slice(0, 300))

console.log('the add form drives the host')
{
  resetRenderBuffer()
  const calls = []
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      calls.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, id: 'mcp-new' }) }
    }
    return { ok: true, status: 200, json: async () => ({ path: 'C:\\probe\\cordis.patch.yml', servers: [] }) }
  }
  // Render, click "Add server", then render so the form appears.
  resetRenderBuffer()
  const first = rerender()
  // The exact control, not the first subtree that mentions it: only a button with
  // a handler can be clicked.
  const clickAdd = findHost(first, (item) => item.type === 'button' && typeof item.props?.onClick === 'function' && textOf(item).includes('Add server'))
  check('the add affordance is a real control', clickAdd !== undefined, 'no add control found')
  if (clickAdd !== undefined) {
    findClickHandler(clickAdd)?.()
    const withForm = rerender()
    const formText = textOf(withForm)
    check('the form asks for a server name', /Server name/.test(formText), formText.slice(0, 300))
    check('the form offers both transports', /stdio/.test(formText) && /streamable-http/.test(formText), formText.slice(0, 400))
    check('the stdio form asks for a command', /Command/.test(formText), formText.slice(0, 400))
    const form = findForm(withForm)
    check('the form is a real form element', form !== undefined)
    if (form !== undefined) {
      form.props.onSubmit?.({ preventDefault() {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
      check('submitting posts an add to the host', calls.length === 1 && calls[0].action === 'add', JSON.stringify(calls))
      check('the posted server carries the typed values', calls[0]?.server?.transport === 'stdio', JSON.stringify(calls[0]))
      check('the post is authorized with the boot token', calls[0]?.token === 'test-token', JSON.stringify(calls[0]))
    }
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => listPayload })
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
