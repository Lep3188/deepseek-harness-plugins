/**
 * The host half: it owns the profile's MCP rows and serves one small JSON API.
 *
 *   GET  /mcp-ui   -> { path, servers: [...] }   each with a live probe result
 *   POST /mcp-ui   -> { action: 'add' | 'remove' | 'test', ... }
 *
 * Why a self-registered route plus a boot token, rather than the Cordis Remote
 * registry: the Dynamic Cordis surface is the agent-driven plugin runtime, built
 * around per-agent approved runs and session-scoped plugin records. A settings
 * page that reads and writes one config file does not want approvals, an agent,
 * or a session — it wants one authenticated endpoint. Riding `ctx.webServer`
 * reuses the GUI's own origin and the module graph's existing bundle serving,
 * and the per-boot token keeps the endpoint from becoming a second, open way to
 * reach the host from any local page.
 *
 * Every mutation signals success only after the edit is on disk and validated,
 * so the next read reports what the loader will actually see.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { addRow, loadPatch, normalizeServer, patchFileFor, readMcpRows, removeRow, resolveProfileDir, writePatch } from './patch-store.js'
import { probeServer } from './probe.js'

/** Exact route this plugin owns. */
const ROUTE_PATH = '/mcp-ui'
/** `globalThis` key the page reads the token from. */
const TOKEN_GLOBAL = '__DSH_MCP_UI__'
/** Cap on a request body; every valid command is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024
/**
 * How long a probe result is reused by `list`.
 *
 * Listing probes every configured server, and each probe spawns a process. Doing
 * that on every list render would mean a process per page open and per refresh,
 * which is both slow and a way to accumulate processes (the shipped mcp-client
 * does not guarantee a removed row's process is reaped). Caching keeps a page
 * open cheap; the explicit `test` action always probes live, so the user can
 * still demand fresh truth for one row.
 */
const PROBE_CACHE_MS = 30_000

/**
 * Parse the booted profile's name out of `process.argv`, since neither the
 * launcher nor the app hands a plugin the profile it composed.
 * @param argv - the process argument list.
 * @returns the profile name, or undefined when the flags name none.
 */
function profileFromArgv(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]
		if (value === '--profile') return argv[index + 1]
		if (typeof value === 'string' && value.startsWith('--profile=')) return value.slice('--profile='.length)
	}
	return undefined
}

/** A filesystem-safe loader id derived from a server name. */
function idFor(serverName) {
	const slug = serverName
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
	return `mcp-${slug === '' ? 'server' : slug}`
}

/** Make `id` unique against the ids already present. */
function uniqueId(base, taken) {
	if (!taken.has(base)) return base
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${base}-${suffix}`
		if (!taken.has(candidate)) return candidate
	}
	return `${base}-${Date.now()}`
}

/** One row's config as the read API exposes it, with yaml expressions kept opaque. */
function publicRow(entry) {
	const config = entry.config
	const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
	const read = (value) => (value !== null && typeof value === 'object' && '__yamlExpression' in value ? String(value.__yamlExpression) : value)
	return {
		id: typeof entry.id === 'string' ? entry.id : '',
		serverName: typeof config.serverName === 'string' ? config.serverName : '',
		transport,
		command: transport === 'stdio' ? (typeof config.command === 'string' ? config.command : '') : '',
		args: Array.isArray(config.args) ? config.args.map(read).filter((item) => typeof item === 'string') : [],
		url: transport === 'streamable-http' && typeof config.url === 'string' ? config.url : '',
		envKeys: config.env !== null && typeof config.env === 'object' ? Object.keys(config.env) : [],
		headerKeys: config.headers !== null && typeof config.headers === 'object' ? Object.keys(config.headers) : [],
		// A yaml expression cannot be re-serialized as a literal, so the UI must
		// know that this row is display-only.
		readOnly: [config.command, config.url, ...(Array.isArray(config.args) ? config.args : [])].some(
			(value) => value !== null && typeof value === 'object' && '__yamlExpression' in value
		)
	}
}

/** Required host services: the web server whose route table this plugin claims. */
export const inject = ['webServer']

/** Mount the settings API. */
export function apply(ctx) {
	const profileDir = resolveProfileDir(profileFromArgv(process.argv))
	const patchFile = patchFileFor(profileDir)
	const token = randomBytes(24).toString('base64url')
	/** Probe results keyed by the config they describe, bounded by a short TTL. */
	const probeCache = new Map()
	ctx.logger?.info?.(`mcp-ui: managing ${patchFile}`)

	/**
	 * Probe one configured row, reusing a recent result.
	 *
	 * A config-keyed cache means an edit invalidates its own entry without any
	 * bookkeeping, and two rows that happen to be identical share one probe.
	 * @param config - the row's mcp-client config.
	 * @param fresh - bypass the cache (the explicit test action).
	 */
	async function probe(config, fresh = false) {
		const key = JSON.stringify(config)
		const cached = probeCache.get(key)
		if (!fresh && cached !== undefined && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value
		const value = await probeServer(config)
		probeCache.set(key, { at: Date.now(), value })
		return value
	}

	/** Read every configured server and probe each one. */
	async function listServers() {
		const rows = readMcpRows(loadPatch(patchFile))
		const servers = []
		for (const row of rows) {
			const result = await probe(row.entry.config)
			servers.push({ ...publicRow(row.entry), ...result })
		}
		return { path: patchFile, servers }
	}

	/** One command. Errors become a 400 with a message the UI can show verbatim. */
	async function command(body) {
		const action = typeof body?.action === 'string' ? body.action : ''
		if (action === 'add') {
			const config = normalizeServer(body?.server)
			const content = loadPatch(patchFile)
			const taken = new Set(readMcpRows(content).map((row) => row.entry.id))
			const id = uniqueId(idFor(config.serverName), taken)
			writePatch(patchFile, addRow(content, id, config))
			return { ok: true, id }
		}
		if (action === 'remove') {
			const id = typeof body?.id === 'string' ? body.id : ''
			if (id === '') throw new Error('an id is required')
			writePatch(patchFile, removeRow(loadPatch(patchFile), id).content)
			return { ok: true, id }
		}
		if (action === 'test') {
			const id = typeof body?.id === 'string' ? body.id : ''
			if (id === '') throw new Error('an id is required')
			const row = readMcpRows(loadPatch(patchFile)).find((candidate) => candidate.entry.id === id)
			if (row === undefined) throw new Error(`no MCP server with id "${id}"`)
			// Explicitly fresh: the user asked to test this one right now.
			return { ok: true, result: await probe(row.entry.config, true) }
		}
		throw new Error(`unknown action ${JSON.stringify(action)}`)
	}

	/** Read a bounded JSON body. */
	function readBody(req) {
		return new Promise((resolve, reject) => {
			let body = ''
			let overflowed = false
			req.setEncoding('utf8')
			req.on('data', (chunk) => {
				if (overflowed) return
				body += chunk
				if (body.length > MAX_BODY_BYTES) {
					overflowed = true
					reject(new Error('the request body is too large'))
				}
			})
			req.on('error', reject)
			req.on('end', () => {
				if (overflowed) return
				try {
					resolve(body === '' ? {} : JSON.parse(body))
				} catch {
					reject(new Error('the request body is not JSON'))
				}
			})
		})
	}

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_PATH,
				handler: async (req, res) => {
					const reply = (status, payload) => {
						if (res.headersSent) return
						res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
						res.end(JSON.stringify(payload))
					}
					try {
						if (req.method === 'GET') return reply(200, await listServers())
						if (req.method !== 'POST') return reply(405, { ok: false, error: 'only GET and POST are supported' })
						const body = await readBody(req)
						if (body?.token !== token) return reply(403, { ok: false, error: 'this page is not authorized to change the MCP configuration' })
						return reply(200, await command(body))
					} catch (error) {
						ctx.logger?.warn?.(`mcp-ui: ${String(error?.message ?? error)}`)
						return reply(400, { ok: false, error: String(error?.message ?? error) })
					}
				}
			}),
		'mcp-ui: settings route'
	)

	ctx.effect(
		() =>
			ctx.on('webserver/index-inject', (table) => {
				table.push({ kind: 'global', name: TOKEN_GLOBAL, value: { token, path: ROUTE_PATH } })
			}),
		'mcp-ui: boot token'
	)
}
