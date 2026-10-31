/**
 * The host half: the only half that can turn an archived conversation into
 * freed disk space.
 *
 *   GET  /archived-ui  -> { sessionsRoot, totalBytes, items: [{ id, bytes, directories, live }] }
 *   POST /archived-ui  -> { action: 'purge', token, ids? } -> { deleted, skipped, freedBytes }
 *
 * Why a self-registered route plus a per-boot token, rather than the Cordis
 * Remote registry (the same reasoning the mcp-ui plugin documents): a settings
 * page that reads the archive set and deletes files wants one authenticated
 * endpoint, not the agent-driven plugin runtime. Riding `ctx.webServer` reuses
 * the GUI's origin, and the token keeps the destructive verb from becoming a
 * second, unauthenticated way to delete a user's data from any local page.
 *
 * Why this deletes files itself: the harness ships no delete-session API at
 * all — `SessionPersistence` is append-only and the workspace registry only
 * grows the archive set. Archiving is a hide flag; nothing below the UI layer
 * has ever had to remove a transcript, so there is no seam to call. This module
 * therefore performs the four removals an archived conversation actually
 * occupies, in an order chosen so that an interrupted run leaves the
 * conversation still archived and still hidden rather than un-hidden and
 * un-openable:
 *
 *   1. the session's artifact directory under the session root,
 *   2. its projection-cache file,
 *   3. its `sessionIds` slot in the owning workspace record,
 *   4. its entry in the registry's archive set (what hides the row).
 *
 * Deleting the files without step 4 would resurrect the row in the sidebar the
 * moment the client refreshes, so the archive set is cleared last, after the
 * bytes are gone.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Exact route this plugin owns. */
const ROUTE_PATH = '/archived-ui'
/** `globalThis` key the page reads the token from. */
const TOKEN_GLOBAL = '__DSH_ARCHIVED_UI__'
/** Cap on a request body; every valid command is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024
/**
 * A path-safe session id. Real ids are `session-<uuid>`; this guard exists so a
 * crafted id can never escape the session root even if the archive set were
 * somehow poisoned, and it matches the alphabet `encodeSegment` leaves alone.
 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

/**
 * The harness home: `DSH_HOME` when set (tilde-expanded, as the loader does),
 * otherwise `~/.dsh`.
 * @returns the absolute harness home directory.
 */
function dshHome() {
	const configured = process.env.DSH_HOME
	if (typeof configured === 'string' && configured.trim() !== '') {
		const raw = configured.trim()
		const expanded =
			raw === '~' ? homedir() : raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw
		return resolve(expanded)
	}
	return join(homedir(), '.dsh')
}

/**
 * The session artifact root. Read from the live persistence backend so a
 * configured root is honoured; the conventional `<home>/sessions` is only the
 * fallback for a profile that composed no jsonl backend.
 * @param ctx - the plugin context.
 * @returns the absolute root every transcript lives under.
 */
function sessionsRoot(ctx) {
	const root = ctx.get('sessionPersistence')?.root
	return typeof root === 'string' && root !== '' ? resolve(root) : join(dshHome(), 'sessions')
}

/** The projection cache file for one session, which mirrors its transcript. */
function projectionCacheFile(home, id) {
	return join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

/**
 * The home directory that actually owns this host's storages.
 *
 * `DSH_HOME` is the authority when it points at a real harness home, but the
 * session root can also be configured independently of it. Deriving the parent
 * of a conventional `<home>/sessions` root as a second candidate — and choosing
 * whichever one carries a `storages` directory — keeps the projection cache
 * reachable without guessing.
 * @param ctx - the plugin context.
 * @returns the absolute harness home directory.
 */
function harnessHome(ctx) {
	const configured = dshHome()
	const candidates = [configured]
	const root = sessionsRoot(ctx)
	if (basename(root).toLowerCase() === 'sessions') candidates.push(dirname(root))
	for (const candidate of candidates) {
		if (existsSync(join(candidate, 'storages'))) return candidate
	}
	return configured
}

/**
 * Total bytes of a directory tree. Unreadable entries count as zero rather than
 * failing the whole report: this number is informational, never a decision.
 * @param directory - the directory to measure.
 * @returns the summed file bytes below it.
 */
async function measure(directory) {
	let total = 0
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch {
		return 0
	}
	for (const entry of entries) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) total += await measure(path)
		else if (entry.isFile()) {
			try {
				total += (await stat(path)).size
			} catch {
				/* a file that vanished mid-walk has no size left to report */
			}
		}
	}
	return total
}

/**
 * Every directory one session owns. The layout is `<root>/<project-key>/<id>`,
 * and a session can only ever be in one project key, but the scan does not
 * assume which one: the project key is derived from the cwd and may have been
 * renamed by a migration.
 * @param root - the session artifact root.
 * @param id - the session id (already validated by {@link SAFE_ID}).
 * @returns the existing artifact directories.
 */
async function artifactDirectories(root, id) {
	const found = []
	let projects
	try {
		projects = await readdir(root, { withFileTypes: true })
	} catch {
		return found
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue
		const directory = join(root, project.name, id)
		if (existsSync(directory)) found.push(directory)
	}
	return found
}

/** The archive set, or undefined when the registry service is not composed. */
function archivedIds(ctx) {
	try {
		return [...(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])]
	} catch {
		return undefined
	}
}

/**
 * One archived conversation, measured and described.
 * @param ctx - the plugin context.
 * @param id - the archived session id.
 */
async function describe(ctx, id) {
	const live = ctx.get('sessions')
	const directories = SAFE_ID.test(id) ? await artifactDirectories(sessionsRoot(ctx), id) : []
	let bytes = 0
	for (const directory of directories) bytes += await measure(directory)
	return { id, bytes, directories: directories.length, live: live?.get(id) !== undefined }
}

/** Read the archive set with each member's size, for the section's initial view. */
async function listing(ctx) {
	const ids = archivedIds(ctx)
	if (ids === undefined) throw new Error('the workspace registry is not composed, so the archive set cannot be read')
	const items = []
	let totalBytes = 0
	for (const id of ids) {
		const item = await describe(ctx, id)
		totalBytes += item.bytes
		items.push(item)
	}
	return { sessionsRoot: sessionsRoot(ctx), totalBytes, items }
}

/**
 * Delete archived conversations from disk and from every durable record that
 * still names them.
 *
 * A session that is live in this process is skipped, never deleted: its
 * transcript is open for appends, and deleting it out from under the agent
 * would turn a housekeeping action into data loss.
 *
 * @param ctx - the plugin context.
 * @param requested - ids to restrict the purge to; absent means the whole set.
 * @returns what was deleted, what was skipped and why, and the bytes freed.
 */
async function purge(ctx, requested) {
	const registry = ctx.get('workspaceRegistry')
	if (registry === undefined) throw new Error('the workspace registry is not composed, so nothing can be purged')
	const root = sessionsRoot(ctx)
	const home = harnessHome(ctx)
	const live = ctx.get('sessions')
	const archive = [...registry.archivedSessionIds]
	const wanted = Array.isArray(requested) && requested.length > 0 ? new Set(requested) : undefined
	const targets = wanted === undefined ? archive : archive.filter((id) => wanted.has(id))
	const deleted = []
	const skipped = []
	let freedBytes = 0
	for (const id of targets) {
		if (!SAFE_ID.test(id)) {
			skipped.push({ id, reason: 'this is not a valid session id' })
			continue
		}
		if (live?.get(id) !== undefined) {
			skipped.push({ id, reason: 'this conversation is open in a window; close it and delete again' })
			continue
		}
		const directories = await artifactDirectories(root, id)
		let bytes = 0
		for (const directory of directories) bytes += await measure(directory)
		for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 })
		const cache = projectionCacheFile(home, id)
		if (existsSync(cache)) await rm(cache, { force: true })
		// The workspace record still accounts for the archived id; a deleted
		// session must not keep a slot that nothing can ever unarchive.
		for (const workspace of registry.list()) {
			if (!workspace.sessionIds.includes(id)) continue
			await workspace.detachSession(id)
		}
		freedBytes += bytes
		deleted.push(id)
	}
	// The archive set is the durability barrier: clearing it last means an
	// interrupted purge leaves rows hidden rather than half-resurrected.
	await registry.enqueueOperation(async () => {
		const state = registry.requireState()
		const remove = new Set(deleted)
		const kept = state.archivedSessionIds.filter((id) => !remove.has(id))
		if (kept.length === state.archivedSessionIds.length) return
		await registry.setState({ ...state, archivedSessionIds: kept })
	})
	return { deleted, skipped, freedBytes }
}

/** Required host services: the web server whose route table this plugin claims. */
export const inject = ['webServer']

/** Mount the archived-conversation API. */
export function apply(ctx) {
	const token = randomBytes(24).toString('base64url')
	/** One purge at a time: two overlapping runs would race the archive set. */
	let purging = false

	/** Read a bounded JSON body. */
	function readBody(req) {
		return new Promise((resolvePromise, reject) => {
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
					resolvePromise(body === '' ? {} : JSON.parse(body))
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
						if (req.method === 'GET') return reply(200, await listing(ctx))
						if (req.method !== 'POST') return reply(405, { ok: false, error: 'only GET and POST are supported' })
						const body = await readBody(req)
						if (body?.token !== token) return reply(403, { ok: false, error: 'this page is not authorized to delete conversations' })
						if (body?.action !== 'purge') return reply(400, { ok: false, error: `unknown action ${JSON.stringify(body?.action ?? '')}` })
						if (purging) return reply(409, { ok: false, error: 'a delete is already running' })
						purging = true
						try {
							const value = await purge(ctx, body?.ids)
							ctx.logger?.info?.(
								`archived-ui: deleted ${value.deleted.length} archived conversation(s), freeing ${value.freedBytes} bytes`
							)
							return reply(200, { ok: true, ...value })
						} finally {
							purging = false
						}
					} catch (error) {
						ctx.logger?.warn?.(`archived-ui: ${String(error?.message ?? error)}`)
						return reply(400, { ok: false, error: String(error?.message ?? error) })
					}
				}
			}),
		'archived-ui: settings route'
	)

	ctx.effect(
		() =>
			ctx.on('webserver/index-inject', (table) => {
				table.push({ kind: 'global', name: TOKEN_GLOBAL, value: { token, path: ROUTE_PATH } })
			}),
		'archived-ui: boot token'
	)
}
