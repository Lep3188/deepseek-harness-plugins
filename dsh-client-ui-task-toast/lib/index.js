/**
 * Task-toast plugin, node half.
 *
 * A browser cannot raise a Windows notification, so the browser half posts to
 * this half and this half runs the OS call. The split is exactly one route:
 *
 *   POST /task-toast  { token, title, meta }  ->  powershell.exe show-toast.ps1
 *
 * Two host facts make it work:
 *
 *  - Route registration. `ctx.webServer.register` claims an exact pathname on
 *    the GUI's own HTTP server, so the page reaches it same-origin with no
 *    port, CORS, or transport work of its own.
 *  - App identity. Windows drops a toast silently unless the sender carries a
 *    registered AppUserModelID. `scripts/ensure-shortcut.ps1` installs a Start
 *    Menu shortcut that registers one; `scripts/show-toast.ps1` sends under it.
 *
 * A random per-boot token rides the index HTML and is required on every POST:
 * the server binds loopback but enforces no origin policy of its own, so
 * without the token any local page could push notifications onto the desktop.
 *
 * Every failure path is silent by design: no toast is a missing notification,
 * never a broken turn. Failures are logged once per distinct cause so a broken
 * install stays diagnosable without spamming the log on every finished turn.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exact route the browser half posts to. */
const ROUTE_PATH = '/task-toast'
/** The identity Windows attributes the toast to; must match both scripts. */
const APP_USER_MODEL_ID = 'DeepSeek.Harness.Toast'
/** Start Menu entry name that carries the identity. */
const SHORTCUT_NAME = 'DeepSeek Harness'
/** Request-body cap; the payload is two short strings. */
const MAX_BODY_BYTES = 8 * 1024
/** Ceiling on one toast subprocess so a hung PowerShell cannot accumulate. */
const TOAST_TIMEOUT_MS = 15_000
/** `globalThis` key the page reads the boot token from. */
const TOKEN_GLOBAL = '__DSH_TASK_TOAST__'

/** This package's directory, so the scripts resolve beside the package. */
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = join(HERE, '..', 'scripts')

/**
 * Resolve the scripts, or undefined when this host cannot raise a toast.
 * @param platform - `process.platform`.
 * @returns the script paths, or undefined.
 */
function scriptsFor(platform) {
	if (platform !== 'win32') return undefined
	const ensure = join(SCRIPTS_DIR, 'ensure-shortcut.ps1')
	const show = join(SCRIPTS_DIR, 'show-toast.ps1')
	if (!existsSync(ensure) || !existsSync(show)) return undefined
	return { ensure, show }
}

/**
 * Run one PowerShell script to completion, capturing both streams.
 * @param file - absolute path of the `.ps1` to run.
 * @param args - validated arguments, passed as an argv array and never a shell string.
 * @param timeoutMs - kill the child after this long.
 * @returns exit code plus trimmed stdout/stderr.
 */
function runPowerShell(file, args, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(
			'powershell.exe',
			['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
			{ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
		)
		let stdout = ''
		let stderr = ''
		let settled = false
		const finish = (result) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(result)
		}
		const timer = setTimeout(() => {
			child.kill()
			finish({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms`.trim() })
		}, timeoutMs)
		child.stdout.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('error', (error) => finish({ code: null, stdout, stderr: String(error?.message ?? error) }))
		child.on('close', (code) => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
	})
}

/**
 * The launcher a person would click: the `dsh` shim beside this Node binary
 * when it exists, otherwise an empty value that accepts the script's fallback.
 * @returns a shortcut target path, or an empty string.
 */
function launcherTarget() {
	const candidate = join(dirname(process.execPath), 'dsh.cmd')
	return existsSync(candidate) ? candidate : ''
}

/** One host-side notification channel: identity install, token check, toast subprocess. */
class WindowsNotifier {
	/** Random per-boot secret the page must echo back. */
	token = randomBytes(24).toString('base64url')
	/** The single in-flight identity installation, so concurrent turns share it. */
	identity
	/** Distinct causes already logged, so a broken install cannot spam the log. */
	logged = new Set()

	/**
	 * @param ctx - host context carrying the webserver service.
	 * @param scripts - resolved script paths, or undefined off Windows.
	 */
	constructor(ctx, scripts) {
		this.ctx = ctx
		this.scripts = scripts
	}

	/**
	 * Register the route and publish the token to the page.
	 * @returns nothing; registrations belong to the caller's fiber.
	 */
	install() {
		this.ctx.effect(
			() => this.ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: (req, res) => this.handle(req, res) }),
			'ui-task-toast: toast route'
		)
		this.ctx.effect(
			() =>
				this.ctx.on('webserver/index-inject', (table) => {
					table.push({ kind: 'global', name: TOKEN_GLOBAL, value: { token: this.token, path: ROUTE_PATH } })
				}),
			'ui-task-toast: boot token'
		)
		// Install the identity eagerly so the first finished turn is not what pays
		// for it; the promise is retained and shared by every later toast.
		void this.ensureIdentity()
	}

	/**
	 * Log one cause at most once per boot.
	 * @param cause - stable short cause key.
	 * @param detail - optional diagnostic detail.
	 */
	logOnce(cause, detail) {
		if (this.logged.has(cause)) return
		this.logged.add(cause)
		const suffix = detail === undefined || detail === '' ? '' : ` — ${detail}`
		this.ctx.logger?.warn?.(`task-toast: ${cause}${suffix}`)
	}

	/**
	 * Install the Start Menu shortcut that registers the AppUserModelID, at most
	 * once per boot. The script is idempotent and leaves a correct shortcut alone.
	 * @returns whether an identity should now be registered.
	 */
	async ensureIdentity() {
		if (this.scripts === undefined) {
			if (process.platform === 'win32') this.logOnce('windows notifications unavailable', 'scripts missing beside lib/')
			return false
		}
		this.identity ??= (async () => {
			const result = await runPowerShell(
				this.scripts.ensure,
				[
					'-AppId', APP_USER_MODEL_ID,
					'-ShortcutName', SHORTCUT_NAME,
					'-TargetPath', launcherTarget(),
					'-TargetArguments', 'web'
				],
				TOAST_TIMEOUT_MS
			)
			if (result.code !== 0) {
				this.logOnce('app identity unavailable', result.stderr || `exit ${result.code}`)
				return false
			}
			this.ctx.logger?.info?.(`task-toast: ${result.stdout || 'app identity ready'}`)
			return true
		})()
		return this.identity
	}

	/**
	 * Handle one POST. Answers JSON in every case, so the browser half can treat
	 * a non-2xx as "no desktop toast" and keep its in-page card.
	 * @param req - the HTTP request.
	 * @param res - the HTTP response, owned entirely by this handler.
	 */
	async handle(req, res) {
		const reply = (status, payload) => {
			if (res.headersSent) return
			res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
			res.end(JSON.stringify(payload))
		}
		if (req.method !== 'POST') return reply(405, { ok: false, reason: 'method' })

		let body = ''
		let overflowed = false
		req.setEncoding('utf8')
		req.on('data', (chunk) => {
			if (overflowed) return
			body += chunk
			if (body.length > MAX_BODY_BYTES) {
				overflowed = true
				reply(413, { ok: false, reason: 'too-large' })
			}
		})
		req.on('error', () => reply(400, { ok: false, reason: 'request-error' }))
		req.on('end', async () => {
			if (overflowed) return
			let payload
			try {
				payload = JSON.parse(body)
			} catch {
				return reply(400, { ok: false, reason: 'bad-json' })
			}
			if (typeof payload?.token !== 'string' || payload.token !== this.token) {
				return reply(403, { ok: false, reason: 'token' })
			}
			if (this.scripts === undefined) return reply(503, { ok: false, reason: 'unsupported-host' })

			const title = typeof payload.title === 'string' ? payload.title.slice(0, 200) : ''
			const meta = typeof payload.meta === 'string' ? payload.meta.slice(0, 200) : ''
			if (title.trim() === '') return reply(400, { ok: false, reason: 'title' })

			if (!(await this.ensureIdentity())) return reply(503, { ok: false, reason: 'identity' })

			const encode = (value) => Buffer.from(value, 'utf8').toString('base64')
			const result = await runPowerShell(
				this.scripts.show,
				['-TitleB64', encode(title), '-BodyB64', encode(meta), '-AppId', APP_USER_MODEL_ID],
				TOAST_TIMEOUT_MS
			)
			if (result.code !== 0) {
				this.logOnce('toast not delivered', result.stderr || `exit ${result.code}`)
				return reply(502, { ok: false, reason: 'toast-failed' })
			}
			reply(200, { ok: true })
		})
	}
}

/** Required host services: the web server that owns the route table. */
export const inject = ['webServer']

/**
 * Host plugin body: mount the notification channel once the webserver exists.
 * @param ctx - host context.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (scoped) => {
		new WindowsNotifier(scoped, scriptsFor(process.platform)).install()
	})
}
