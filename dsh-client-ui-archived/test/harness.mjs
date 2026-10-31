/**
 * Host-half harness: exercises the delete path against a throwaway harness home
 * instead of the real one. Nothing here touches `~/.dsh`.
 *
 *   node test/harness.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const here = new URL('..', import.meta.url)
const module_ = await import(new URL('lib/index.js', here).href)

/** A fresh fake harness home with two archived conversations on disk. */
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'dsh-arch-test-'))
	const project = join(home, 'sessions', '--C-proj--')
	const transcript = join(project, 'session-aaaa', 'session.v3.jsonl.zstd')
	await mkdir(join(project, 'session-aaaa'), { recursive: true })
	await mkdir(join(project, 'session-bbbb'), { recursive: true })
	await writeFile(transcript, 'x'.repeat(4096))
	await writeFile(join(project, 'session-bbbb', 'session.v3.jsonl.zstd'), 'y'.repeat(1024))
	await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
	await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-aaaa.json'), '{"cached":true}')
	await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-bbbb.json'), '{"cached":true}')
	return { home, project }
}

/** Boot the plugin against a fake context; returns the route handler and token. */
function boot(home, registry, liveSessions) {
	const disposers = []
	const listeners = []
	let handler
	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
			if (name === 'workspaceRegistry') return registry
			if (name === 'sessions') return liveSessions
			if (name === 'sessionPersistence') return { root: join(home, 'sessions') }
			return undefined
		},
		effect(fn) {
			disposers.push(fn())
			return () => {}
		},
		webServer: {
			register(row) {
				handler = row.handler
				return () => {}
			}
		},
		on(event, fn) {
			listeners.push([event, fn])
			return () => {}
		}
	}
	module_.apply(ctx)
	assert.equal(typeof handler, 'function', 'the plugin registered a route')
	const table = []
	for (const [event, fn] of listeners) if (event === 'webserver/index-inject') fn(table)
	assert.equal(table.length, 1, 'the plugin injected exactly one boot global')
	return { handler, global: table[0] }
}

/** A response double that records the status and JSON body. */
function responseDouble() {
	const out = { status: 0, body: '' }
	return {
		out,
		res: {
			headersSent: false,
			writeHead(status) {
				out.status = status
				this.headersSent = true
			},
			end(body) {
				out.body = String(body ?? '')
			}
		}
	}
}

/** A GET request double. */
const getRequest = () => ({ method: 'GET', setEncoding() {} })

/** A POST request double carrying `payload` as its body. */
function postRequest(payload) {
	return Object.assign(Readable.from([JSON.stringify(payload)]), { method: 'POST' })
}

/** A registry double that tracks archive-set writes and detach calls. */
function registryDouble(archived, workspaces) {
	let archivedSessionIds = [...archived]
	return {
		workspaces,
		get archivedSessionIds() {
			return archivedSessionIds
		},
		list: () => workspaces,
		requireState: () => ({ initialized: true, workspaceIds: ['w1'], archivedSessionIds: [...archivedSessionIds] }),
		async setState(state) {
			archivedSessionIds = [...state.archivedSessionIds]
		},
		async enqueueOperation(operation) {
			return await operation()
		}
	}
}

/** A workspace double that records session detachments. */
function workspaceDouble() {
	return {
		sessionIds: ['session-aaaa', 'session-bbbb'],
		detached: [],
		async detachSession(id) {
			this.detached.push(id)
			this.sessionIds = this.sessionIds.filter((candidate) => candidate !== id)
		}
	}
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

process.env.DSH_HOME = join(tmpdir(), 'dsh-arch-unused-home')

test('GET reports the archive set with sizes and never mutates anything', async () => {
	const { home, project } = await fixture()
	const workspace = workspaceDouble()
	const { handler, global } = boot(home, registryDouble(['session-aaaa', 'session-bbbb'], [workspace]), { get: () => undefined })
	const { out, res } = responseDouble()
	await handler(getRequest(), res)
	assert.equal(out.status, 200)
	const value = JSON.parse(out.body)
	assert.equal(value.items.length, 2)
	assert.equal(value.items[0].id, 'session-aaaa')
	assert.equal(value.items[0].bytes, 4096)
	assert.equal(value.items[1].bytes, 1024)
	assert.equal(value.totalBytes, 5120)
	assert.equal(value.items[0].directories, 1)
	assert.equal(value.items[0].live, false)
	assert.ok(existsSync(join(project, 'session-aaaa')), 'GET deleted nothing')
	assert.equal(global.value.path, '/archived-ui')
	assert.equal(typeof global.value.token, 'string')
	await rm(home, { recursive: true, force: true })
})

test('POST with a bad token is refused and deletes nothing', async () => {
	const { home, project } = await fixture()
	const { handler, global } = boot(home, registryDouble(['session-aaaa'], [workspaceDouble()]), { get: () => undefined })
	const { out, res } = responseDouble()
	await handler(postRequest({ token: 'nope', action: 'purge' }), res)
	assert.equal(out.status, 403)
	assert.ok(existsSync(join(project, 'session-aaaa')))
	assert.deepEqual(global.value.token === 'nope', false)
	await rm(home, { recursive: true, force: true })
})

test('purge removes transcripts, cache files, workspace slots and archive entries', async () => {
	const { home, project } = await fixture()
	const workspace = workspaceDouble()
	const registry = registryDouble(['session-aaaa', 'session-bbbb'], [workspace])
	const { handler, global } = boot(home, registry, { get: () => undefined })
	const { out, res } = responseDouble()
	await handler(postRequest({ token: global.value.token, action: 'purge' }), res)
	assert.equal(out.status, 200)
	const value = JSON.parse(out.body)
	assert.equal(value.ok, true)
	assert.deepEqual(value.deleted, ['session-aaaa', 'session-bbbb'])
	assert.deepEqual(value.skipped, [])
	assert.equal(value.freedBytes, 5120)
	assert.equal(existsSync(join(project, 'session-aaaa')), false, 'transcript directory removed')
	assert.equal(existsSync(join(project, 'session-bbbb')), false, 'second transcript directory removed')
	assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-aaaa.json')), false, 'cache removed')
	assert.deepEqual(workspace.detached, ['session-aaaa', 'session-bbbb'], 'workspace slots released')
	assert.deepEqual(registry.archivedSessionIds, [], 'archive set cleared')
	await rm(home, { recursive: true, force: true })
})

test('a session live in this process is skipped, not deleted', async () => {
	const { home, project } = await fixture()
	const registry = registryDouble(['session-aaaa', 'session-bbbb'], [workspaceDouble()])
	const { handler, global } = boot(home, registry, { get: (id) => (id === 'session-aaaa' ? { id } : undefined) })
	const { out, res } = responseDouble()
	await handler(postRequest({ token: global.value.token, action: 'purge' }), res)
	const value = JSON.parse(out.body)
	assert.deepEqual(value.deleted, ['session-bbbb'])
	assert.equal(value.skipped.length, 1)
	assert.equal(value.skipped[0].id, 'session-aaaa')
	assert.match(value.skipped[0].reason, /open in a window/)
	assert.ok(existsSync(join(project, 'session-aaaa')), 'the live transcript survives')
	assert.equal(existsSync(join(project, 'session-bbbb')), false)
	assert.deepEqual(registry.archivedSessionIds, ['session-aaaa'], 'the skipped id stays archived')
	await rm(home, { recursive: true, force: true })
})

test('a path-escaping id is skipped and never reaches the filesystem', async () => {
	const { home } = await fixture()
	const sentinel = join(home, 'sentinel.txt')
	await writeFile(sentinel, 'do not delete')
	const registry = registryDouble(['../../sentinel', 'session-aaaa'], [workspaceDouble()])
	const { handler, global } = boot(home, registry, { get: () => undefined })
	const { out, res } = responseDouble()
	await handler(postRequest({ token: global.value.token, action: 'purge' }), res)
	const value = JSON.parse(out.body)
	assert.deepEqual(value.deleted, ['session-aaaa'])
	assert.equal(value.skipped.length, 1)
	assert.match(value.skipped[0].reason, /not a valid session id/)
	assert.equal(await readFile(sentinel, 'utf8'), 'do not delete')
	await rm(home, { recursive: true, force: true })
})

test('a second purge is idempotent and frees nothing', async () => {
	const { home } = await fixture()
	const registry = registryDouble(['session-aaaa', 'session-bbbb'], [workspaceDouble()])
	const { handler, global } = boot(home, registry, { get: () => undefined })
	const first = responseDouble()
	await handler(postRequest({ token: global.value.token, action: 'purge' }), first.res)
	const second = responseDouble()
	await handler(postRequest({ token: global.value.token, action: 'purge' }), second.res)
	const value = JSON.parse(second.out.body)
	assert.deepEqual(value.deleted, [], 'nothing left to delete')
	assert.equal(value.freedBytes, 0)
	const listed = responseDouble()
	await handler(getRequest(), listed.res)
	assert.deepEqual(JSON.parse(listed.out.body).items, [], 'the archive set is empty')
	await rm(home, { recursive: true, force: true })
})

test('an id restricted purge leaves the rest archived', async () => {
	const { home, project } = await fixture()
	const registry = registryDouble(['session-aaaa', 'session-bbbb'], [workspaceDouble()])
	const { handler, global } = boot(home, registry, { get: () => undefined })
	const { out, res } = responseDouble()
	await handler(postRequest({ token: global.value.token, action: 'purge', ids: ['session-aaaa'] }), res)
	const value = JSON.parse(out.body)
	assert.deepEqual(value.deleted, ['session-aaaa'])
	assert.equal(existsSync(join(project, 'session-aaaa')), false)
	assert.ok(existsSync(join(project, 'session-bbbb')))
	assert.deepEqual(registry.archivedSessionIds, ['session-bbbb'])
	await rm(home, { recursive: true, force: true })
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
