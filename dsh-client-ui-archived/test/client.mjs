/**
 * Client-half harness: runs the shipped browser bundle under a minimal React
 * stub and drives it the way a person would — open the section, click the red
 * button, confirm — asserting the count, the confirm step, the POST payload,
 * the list refresh, the result notice, and the failure path.
 *
 * React is not re-implemented here; only the six hooks this component uses, with
 * an explicit render pass, so the component's own logic is what runs.
 *
 *   node test/client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** jsx runtime stub: elements are plain `{ type, props, key }` records. */
const jsxRuntime = {
	Fragment: "Fragment",
	jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
	jsxs: (type, props, key) => ({ type, props: props ?? {}, key })
}

/**
 * A minimal hooks implementation: one cell array per mounted component, walked
 * in order by a render pass, with effects deferred until the pass completes.
 */
function createReact() {
	const cells = []
	let cursor = 0
	let pending = []
	const same = (left, right) =>
		left !== null && right !== null && left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
	const react = {
		useState(initial) {
			const cell = (cells[cursor] ??= { value: typeof initial === "function" ? initial() : initial })
			cursor += 1
			return [
				cell.value,
				(next) => {
					cell.value = typeof next === "function" ? next(cell.value) : next
				}
			]
		},
		useMemo(fn, deps) {
			const cell = (cells[cursor] ??= {})
			cursor += 1
			if (!same(cell.deps, deps)) {
				cell.deps = deps
				cell.value = fn()
			}
			return cell.value
		},
		useCallback(fn, deps) {
			const cell = (cells[cursor] ??= {})
			cursor += 1
			if (!same(cell.deps, deps)) {
				cell.deps = deps
				cell.value = fn
			}
			return cell.value
		},
		useEffect(fn, deps) {
			const cell = (cells[cursor] ??= { deps: null })
			cursor += 1
			if (!same(cell.deps, deps)) {
				cell.deps = deps
				pending.push(fn)
			}
		},
		useSyncExternalStore(_subscribe, getSnapshot) {
			return getSnapshot()
		},
		/**
		 * One render pass of a function component, walking its hooks from the
		 * start and then running the effects whose dependencies changed.
		 */
		async pass(component, props) {
			cursor = 0
			pending = []
			const tree = component(props)
			const effects = pending
			pending = []
			for (const effect of effects) await effect()
			return tree
		}
	}
	return react
}

/** Every node in an element tree, depth-first. */
function walk(node, out = []) {
	if (node === null || node === undefined || node === false) return out
	if (Array.isArray(node)) {
		for (const child of node) walk(child, out)
		return out
	}
	if (typeof node !== "object") return out
	out.push(node)
	walk(node.props?.children, out)
	return out
}

/** The concatenated text of an element subtree. */
const text = (node) =>
	typeof node === "string" || typeof node === "number"
		? String(node)
		: Array.isArray(node)
			? node.map(text).join("")
			: node && typeof node === "object"
				? text(node.props?.children)
				: ""

/** One snapshot-store double for a client service. */
function fakeService(initial) {
	const listeners = new Set()
	const service = {
		state: initial,
		list: {
			getSnapshot: () => service.state,
			subscribe: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			}
		},
		set(next) {
			service.state = next
			for (const listener of [...listeners]) listener()
		}
	}
	return service
}

/**
 * Load the bundle in a fresh context and wire fake services around it.
 * @param options - token (null omits the boot global), archive set, session summaries,
 *   host size report, and whether the POST fails.
 */
async function load({ token = "boot-token", archived = [], summaries = {}, items = [], postFails = false } = {}) {
	const calls = []
	let captured
	const context = {
		document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: "" }), head: { appendChild() {} } },
		console,
		setTimeout,
		window: { __ModuleLoader__: { load: (mod) => (captured = mod) } }
	}
	if (token !== null) context.__DSH_ARCHIVED_UI__ = { token, path: "/archived-ui" }
	const workspaces = fakeService({ items: [], archivedSessionIds: [...archived] })
	const sessions = fakeService({ ids: [...archived], byId: { ...summaries } })
	let refreshed = 0
	sessions.refresh = async () => {
		refreshed += 1
	}
	context.fetch = async (path, init) => {
		const method = init?.method ?? "GET"
		calls.push({ path, method, init })
		if (method === "GET") {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					sessionsRoot: "C:\\home\\sessions",
					totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
					items
				})
			}
		}
		if (postFails) return { ok: false, status: 409, json: async () => ({ ok: false, error: "a delete is already running" }) }
		return {
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				deleted: [...archived],
				skipped: [],
				freedBytes: items.reduce((sum, item) => sum + item.bytes, 0)
			})
		}
	}
	vm.createContext(context)
	vm.runInContext(source, context)
	const react = createReact()
	const exports = captured.factory((specifier) => {
		if (specifier === "react") return react
		if (specifier === "react/jsx-runtime") return jsxRuntime
		throw new Error(`unexpected require ${specifier}`)
	})
	return { exports, react, calls, workspaces, sessions, refreshedCount: () => refreshed }
}

/**
 * Mount the section the way the Settings shell does: call the registered
 * component, then render whatever function component it returned.
 * @returns an async rerender function.
 */
function mount(loaded, component) {
	const outer = component()
	const Section = outer.type
	const props = outer.props
	assert.equal(typeof Section, "function", "the registered component renders the section")
	return () => loaded.react.pass(Section, props)
}

/** Find the red delete button in one render. */
const dangerButton = (tree) => walk(tree).find((node) => node.props?.className === "dsh-arch_button dsh-arch_danger")

/** Find a plain button by its label. */
const buttonLabelled = (tree, label) =>
	walk(tree).find((node) => node.props?.className === "dsh-arch_button" && text(node.props?.children) === label)

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test("registers a labelled Settings section", async () => {
	const loaded = await load()
	const registered = []
	const ctx = {
		get: (name) => (name === "sessions" ? loaded.sessions : name === "workspaces" ? loaded.workspaces : undefined),
		slots: {
			inject: (hole, factory) => {
				assert.equal(hole, "settings.section")
				factory()
			},
			register: (options, component) => {
				registered.push({ options, component })
				return () => {}
			}
		}
	}
	loaded.exports.apply(ctx)
	assert.equal(registered.length, 1)
	assert.equal(registered[0].options.name, "settings.section")
	assert.equal(registered[0].options.id, "archived")
	assert.equal(typeof registered[0].options.order, "number")
	assert.equal(registered[0].options.label(), "Archived")
	assert.equal(typeof registered[0].component, "function")
})

test("shows the count, the names, the sizes and which one is open", async () => {
	const loaded = await load({
		archived: ["session-aaaa", "session-bbbb"],
		summaries: {
			"session-aaaa": { id: "session-aaaa", displayTitle: "First chat", cwd: "C:\\a" },
			"session-bbbb": { id: "session-bbbb", displayTitle: "Second chat" }
		},
		items: [
			{ id: "session-aaaa", bytes: 4096, directories: 1, live: false },
			{ id: "session-bbbb", bytes: 118784, directories: 1, live: true }
		]
	})
	let registered
	loaded.exports.apply({
		get: (name) => (name === "sessions" ? loaded.sessions : name === "workspaces" ? loaded.workspaces : undefined),
		slots: { inject: (_hole, factory) => factory(), register: (options, component) => (registered = { options, component }) }
	})
	const rerender = mount(loaded, registered.component)
	await rerender()
	await flush()
	const tree = await rerender()
	const all = text(tree)
	assert.match(all, /Archived conversations/)
	assert.match(all, /2 archived/)
	assert.match(all, /First chat/)
	assert.match(all, /Second chat/)
	assert.match(all, /4\.0 KB/)
	assert.match(all, /116 KB/)
	assert.match(all, /open/)
	assert.match(all, /120 KB/)
	assert.match(all, /Delete all 2 archived/)
	assert.equal(walk(tree).filter((node) => node.props?.className === "dsh-arch_item").length, 2)
})

test("the red button asks once, then deletes, refreshes the list and reports bytes", async () => {
	const loaded = await load({
		archived: ["session-aaaa"],
		summaries: { "session-aaaa": { id: "session-aaaa", displayTitle: "First chat" } },
		items: [{ id: "session-aaaa", bytes: 122880, directories: 1, live: false }]
	})
	let registered
	loaded.exports.apply({
		get: (name) => (name === "sessions" ? loaded.sessions : name === "workspaces" ? loaded.workspaces : undefined),
		slots: { inject: (_hole, factory) => factory(), register: (options, component) => (registered = { options, component }) }
	})
	const rerender = mount(loaded, registered.component)
	await rerender()
	await flush()
	let tree = await rerender()
	assert.match(text(dangerButton(tree)), /Delete all 1 archived/)
	assert.equal(loaded.calls.filter((call) => call.method === "POST").length, 0, "no POST before the click")

	dangerButton(tree).props.onClick()
	tree = await rerender()
	assert.match(text(dangerButton(tree)), /Yes — delete 1 permanently/)
	assert.ok(buttonLabelled(tree, "Cancel") !== undefined)
	assert.match(text(tree), /cannot be undone/)

	dangerButton(tree).props.onClick()
	await flush()
	loaded.workspaces.set({ items: [], archivedSessionIds: [] })
	await rerender()
	await flush()
	tree = await rerender()

	const posted = loaded.calls.filter((call) => call.method === "POST")
	assert.equal(posted.length, 1)
	assert.equal(posted[0].path, "/archived-ui")
	const payload = JSON.parse(posted[0].init.body)
	assert.equal(payload.action, "purge")
	assert.equal(payload.token, "boot-token")
	assert.equal(loaded.refreshedCount(), 1, "the session list was refreshed once")
	assert.match(text(tree), /Deleted 1 archived conversation, freeing 120 KB/)
	assert.match(text(tree), /No archived conversations/)
})

test("cancel leaves everything alone", async () => {
	const loaded = await load({ archived: ["session-aaaa"], items: [{ id: "session-aaaa", bytes: 1, directories: 1, live: false }] })
	let registered
	loaded.exports.apply({
		get: (name) => (name === "sessions" ? loaded.sessions : name === "workspaces" ? loaded.workspaces : undefined),
		slots: { inject: (_hole, factory) => factory(), register: (options, component) => (registered = { options, component }) }
	})
	const rerender = mount(loaded, registered.component)
	await rerender()
	await flush()
	let tree = await rerender()
	dangerButton(tree).props.onClick()
	tree = await rerender()
	buttonLabelled(tree, "Cancel").props.onClick()
	tree = await rerender()
	assert.match(text(dangerButton(tree)), /Delete all 1 archived/)
	assert.equal(loaded.calls.filter((call) => call.method === "POST").length, 0)
})

test("without the host half it says so instead of offering a dead button", async () => {
	const loaded = await load({ token: null })
	let registered
	loaded.exports.apply({
		get: (name) => (name === "sessions" ? loaded.sessions : name === "workspaces" ? loaded.workspaces : undefined),
		slots: { inject: (_hole, factory) => factory(), register: (options, component) => (registered = { options, component }) }
	})
	const rerender = mount(loaded, registered.component)
	const tree = await rerender()
	assert.match(text(tree), /host half is not composed/)
	assert.equal(dangerButton(tree), undefined)
})

test("a failed delete surfaces the host's message and keeps the rows", async () => {
	const loaded = await load({
		archived: ["session-aaaa"],
		items: [{ id: "session-aaaa", bytes: 1, directories: 1, live: false }],
		postFails: true
	})
	let registered
	loaded.exports.apply({
		get: (name) => (name === "sessions" ? loaded.sessions : name === "workspaces" ? loaded.workspaces : undefined),
		slots: { inject: (_hole, factory) => factory(), register: (options, component) => (registered = { options, component }) }
	})
	const rerender = mount(loaded, registered.component)
	await rerender()
	await flush()
	let tree = await rerender()
	dangerButton(tree).props.onClick()
	tree = await rerender()
	dangerButton(tree).props.onClick()
	await flush()
	tree = await rerender()
	assert.match(text(tree), /a delete is already running/)
	assert.equal(walk(tree).some((node) => node.props?.className === "dsh-arch_error"), true)
	assert.match(text(tree), /Delete all 1 archived/, "the button is offered again")
	assert.equal(loaded.refreshedCount(), 0, "no list refresh after a failure")
})

let failed = 0
for (const { name, fn } of cases) {
	try {
		await fn()
		console.log(`  ok   ${name}`)
	} catch (error) {
		failed += 1
		console.log(`  FAIL ${name}`)
		console.log(`       ${error?.message ?? error}`)
	}
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
