/**
 * A small MCP client used to ask one configured server what it offers.
 *
 * Why not the MCP SDK: this plugin is linked into a profile from outside it, and
 * the SDK lives inside the dsh installation's dependency closure, so importing
 * it would make the plugin fail to resolve for reasons that have nothing to do
 * with the user's config. The probe needs exactly three messages — `initialize`,
 * the `initialized` notification, and `tools/list` — so it speaks them directly
 * and carries no dependency at all.
 *
 * The probe is read-only by construction: `tools/call` is never sent, so listing
 * a server can never cause a side effect on it.
 *
 * Every failure is reported as data (`{ ok: false, error }`) rather than thrown,
 * because one unreachable server must not fail a whole list: the UI shows that
 * row as failed and keeps rendering the others.
 */
import { spawn } from 'node:child_process'

/** MCP revision this client offers; a server may answer with one it supports instead. */
const PROTOCOL_VERSION = '2025-06-18'
/** Bound on the whole probe, so a hung server cannot hold a request open. */
const PROBE_TIMEOUT_MS = 12_000
/** Cap on a response line, to bound a server that streams without newlines. */
const MAX_LINE_BYTES = 4 * 1024 * 1024

/** Build a JSON-RPC request or notification envelope. */
function envelope(method, id, params) {
	return id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
}

/**
 * Project one untrusted tool entry into the shape the UI renders.
 * @param value - one item of a `tools/list` result.
 * @returns the projected tool, or undefined when it is not a usable entry.
 */
function projectTool(value) {
	if (value === null || typeof value !== 'object' || typeof value.name !== 'string' || value.name === '') return undefined
	const description = typeof value.description === 'string' ? value.description.slice(0, 300) : ''
	const schema = value.inputSchema
	const properties = schema !== null && typeof schema === 'object' && schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : undefined
	const required = Array.isArray(schema?.required) ? schema.required.filter((item) => typeof item === 'string') : []
	return {
		name: value.name.slice(0, 200),
		description,
		parameters: properties === undefined ? [] : Object.keys(properties).slice(0, 40),
		required
	}
}

/** Project a `tools/list` result's tools array. */
function projectTools(result) {
	const list = Array.isArray(result?.tools) ? result.tools : []
	return list.map(projectTool).filter((tool) => tool !== undefined)
}

/**
 * Probe a stdio server: spawn it, handshake, list tools, then terminate it.
 *
 * The child is killed on every path — success included — because the probe owns
 * this process and leaving it running would leak one process per list refresh.
 * A server that exits on its own after stdin closes is awaited briefly first, so
 * a well-behaved server is never force-killed.
 * @param config - the mcp-client stdio config.
 * @returns the probe outcome.
 */
function probeStdio(config) {
	return new Promise((resolve) => {
		const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
			cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : undefined,
			env: { ...process.env, ...(config.env ?? {}) },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		})

		let buffer = ''
		let stderr = ''
		let settled = false
		let initializeId
		let listId
		let serverInfo

		const finish = (outcome) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.removeAllListeners('exit')
			child.removeAllListeners('close')
			child.removeAllListeners('error')
			try {
				child.kill()
			} catch {
				/* already gone */
			}
			resolve(outcome)
		}

		const timer = setTimeout(() => {
			finish({
				ok: false,
				error: `no response within ${PROBE_TIMEOUT_MS / 1000}s${stderr === '' ? '' : ` — ${stderr.trim().slice(0, 300)}`}`
			})
		}, PROBE_TIMEOUT_MS)

		child.on('error', (error) => {
			finish({ ok: false, error: `could not start the server: ${String(error?.message ?? error)}` })
		})
		child.on('exit', (code) => {
			if (code !== 0 && code !== null) finish({ ok: false, error: `the server exited with code ${code}${stderr === '' ? '' : ` — ${stderr.trim().slice(0, 300)}`}` })
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk
			if (stderr.length > 4000) stderr = stderr.slice(-2000)
		})

		child.stdout.on('data', (chunk) => {
			buffer += chunk
			if (buffer.length > MAX_LINE_BYTES) {
				finish({ ok: false, error: 'the server sent an oversized response' })
				return
			}
			let newline = buffer.indexOf('\n')
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim()
				buffer = buffer.slice(newline + 1)
				if (line !== '') {
					let message
					try {
						message = JSON.parse(line)
					} catch {
						return finish({ ok: false, error: 'the server wrote a non-JSON line; it may not be an MCP stdio server' })
					}
					handle(message)
				}
				newline = buffer.indexOf('\n')
			}
		})

		/** Route one server message. */
		function handle(message) {
			if (message?.id === initializeId) {
				if (message.error !== undefined) return finish({ ok: false, error: `initialize failed: ${message.error?.message ?? 'unknown error'}` })
				serverInfo = message.result?.serverInfo
				child.stdin.write(`${JSON.stringify(envelope('notifications/initialized'))}\n`)
				child.stdin.write(`${JSON.stringify(envelope('tools/list', listId, {}))}\n`)
				return
			}
			if (message?.id === listId) {
				if (message.error !== undefined) return finish({ ok: false, error: `tools/list failed: ${message.error?.message ?? 'unknown error'}` })
				return finish({
					ok: true,
					serverInfo: typeof serverInfo?.name === 'string' ? { name: serverInfo.name, version: typeof serverInfo.version === 'string' ? serverInfo.version : '' } : undefined,
					tools: projectTools(message.result)
				})
			}
		}

		initializeId = 1
		listId = 2
		child.stdin.write(
			`${JSON.stringify(
				envelope('initialize', initializeId, {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'dsh-mcp-ui', version: '0.1.0' }
				})
			)}\n`
		)
	})
}

/** Headers a Streamable HTTP MCP endpoint requires, plus any the user configured. */
function httpHeaders(config) {
	return {
		'content-type': 'application/json',
		// The transport negotiates either framing; asking for both is what the
		// reference clients do.
		accept: 'application/json, text/event-stream',
		...(config.headers ?? {})
	}
}

/**
 * Read one MCP HTTP response, whether it is bare JSON or an SSE frame.
 * @param response - the fetch response.
 * @returns the parsed JSON-RPC message.
 */
async function readHttpMessage(response) {
	const text = await response.text()
	const contentType = response.headers.get('content-type') ?? ''
	if (!contentType.includes('text/event-stream')) return JSON.parse(text)
	// An SSE stream carries `data:` lines holding the JSON-RPC message.
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed.startsWith('data:')) continue
		const payload = trimmed.slice(5).trim()
		if (payload === '') continue
		return JSON.parse(payload)
	}
	throw new Error('the server sent an event stream with no data')
}

/**
 * Probe a Streamable HTTP server. Read-only, like the stdio path.
 * @param config - the mcp-client streamable-http config.
 * @returns the probe outcome.
 */
async function probeHttp(config) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
	try {
		const initialize = await fetch(config.url, {
			method: 'POST',
			headers: httpHeaders(config),
			body: JSON.stringify(
				envelope('initialize', 1, {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'dsh-mcp-ui', version: '0.1.0' }
				})
			),
			signal: controller.signal
		})
		if (!initialize.ok) return { ok: false, error: `initialize returned HTTP ${initialize.status}` }
		const sessionId = initialize.headers.get('mcp-session-id')
		const first = await readHttpMessage(initialize)
		if (first?.error !== undefined) return { ok: false, error: `initialize failed: ${first.error?.message ?? 'unknown error'}` }

		const headers = { ...httpHeaders(config), ...(sessionId === null ? {} : { 'mcp-session-id': sessionId }) }
		await fetch(config.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(envelope('notifications/initialized')),
			signal: controller.signal
		})

		const list = await fetch(config.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(envelope('tools/list', 2, {})),
			signal: controller.signal
		})
		if (!list.ok) return { ok: false, error: `tools/list returned HTTP ${list.status}` }
		const second = await readHttpMessage(list)
		if (second?.error !== undefined) return { ok: false, error: `tools/list failed: ${second.error?.message ?? 'unknown error'}` }

		const info = first?.result?.serverInfo
		return {
			ok: true,
			serverInfo: typeof info?.name === 'string' ? { name: info.name, version: typeof info.version === 'string' ? info.version : '' } : undefined,
			tools: projectTools(second?.result)
		}
	} catch (error) {
		const message = error?.name === 'AbortError' ? `no response within ${PROBE_TIMEOUT_MS / 1000}s` : String(error?.message ?? error)
		return { ok: false, error: message }
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Probe one configured server.
 * @param config - a normalized mcp-client config.
 * @returns whether it answered, its identity if it did, and its tools.
 */
export async function probeServer(config) {
	if (config?.transport === 'streamable-http') {
		if (typeof config.url !== 'string' || config.url === '') return { ok: false, error: 'the row has no url' }
		return probeHttp(config)
	}
	if (typeof config?.command !== 'string' || config.command === '') return { ok: false, error: 'the row has no command' }
	return probeStdio(config)
}
