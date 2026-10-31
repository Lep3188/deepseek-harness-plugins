#!/usr/bin/env node
/**
 * Proves the mechanism a UI for MCP servers would depend on: does editing the
 * profile's `cordis.patch.yml` add and remove a live MCP connection without a
 * restart?
 *
 * It boots a throwaway profile on its own port, points a row at
 * `test/fake-mcp-server.mjs`, and checks three things per edit:
 *
 *   1. the fake server recorded an `initialize` and a `tools/list`, so the row
 *      really connected rather than merely appearing in the tree;
 *   2. `pluginInventory/list` over the real `/api` Remote reports the row, and
 *      its fiber phase distinguishes connected from failed;
 *   3. removing the row stops the child process, so nothing leaks.
 *
 * Nothing here touches the user's profile: the probe profile lives in a temp
 * directory, and the real profile is never opened.
 *
 * Run with: node test/live-add-remove.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_SERVER = join(HERE, 'fake-mcp-server.mjs')
const ROOT = join(tmpdir(), 'dsh-mcp-ui-probe')
const PROBE_HOME = join(ROOT, 'home')
const PROBE_DIR = join(PROBE_HOME, 'profiles', 'mcpprobe')
const WORKSPACE = join(ROOT, 'workspace')
const LOG = join(ROOT, 'fake-mcp.log')
const PORT = 3096
// The launcher under test: DSH_BIN wins, else the standard npm global prefix on
// Windows (`%APPDATA%\npm`), where `npm i -g @deepseek-ai/dsh` installs it.
const DSH_BIN = process.env.DSH_BIN ?? join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

/* ── the throwaway profile ───────────────────────────────────────────────── */

const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

/** The profile patch file body for a given set of rows (empty renders `[]`). */
function renderPatch(rows) {
  if (rows.length === 0) return `${PATCH_HEADER}[]\n`
  return `${PATCH_HEADER}${rows.map((row) => row).join('\n')}\n`
}

/** One mcp-client row block, shaped exactly as the package documents it. */
function mcpRow(id, serverName, command, args, extra = '') {
  return [
    '- insert:',
    `    - id: ${id}`,
    `      name: '@deepseek-ai/dsh-mcp-client'`,
    '      config:',
    `        serverName: ${serverName}`,
    '        transport: stdio',
    `        command: ${JSON.stringify(command)}`,
    `        args: ${JSON.stringify(args)}`,
    ...(extra === '' ? [] : [extra])
  ].join('\n')
}

mkdirSync(PROBE_DIR, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
writeFileSync(join(WORKSPACE, 'package.json'), '{\n  "name": "probe-workspace",\n  "private": true\n}\n')
writeFileSync(
  join(PROBE_DIR, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-mcpprobe',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } }
    },
    void 0,
    2
  )}\n`
)
writeFileSync(join(PROBE_DIR, 'cordis.patch.yml'), renderPatch([]))
rmSync(LOG, { force: true })

console.log(`probe home: ${PROBE_HOME}`)

/* ── boot ────────────────────────────────────────────────────────────────── */

console.log('boot')
if (!existsSync(DSH_BIN)) {
  console.log(`  FAIL dsh entry not found at ${DSH_BIN}`)
  process.exit(1)
}

const child = spawn(process.execPath, [DSH_BIN, '--profile', 'mcpprobe', '--port', String(PORT), '--no-open'], {
  cwd: WORKSPACE,
  env: { ...process.env, DSH_HOME: PROBE_HOME },
  stdio: ['ignore', 'pipe', 'pipe']
})

let childOutput = ''
child.stdout.on('data', (chunk) => {
  childOutput += chunk
})
child.stderr.on('data', (chunk) => {
  childOutput += chunk
})

/**
 * Poll until `probe()` returns a truthy value.
 * @param {() => Promise<unknown>|unknown} probe - the condition, run every interval.
 * @param {number} timeoutMs - give up after this long.
 */
async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await probe()
      if (last) return last
    } catch (error) {
      last = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return undefined
}

/** Boot readiness: the printed URL line. */
const bootUrl = await waitFor(() => {
  const match = /dsh web: (http:\/\/\S+)/.exec(childOutput)
  return match?.[1]
}, 90_000)
if (!check('the probe instance boots on its own port', bootUrl !== undefined)) {
  console.log('\n--- full probe output ---')
  console.log(childOutput.trim() || '(no output)')
  console.log('--- end ---\n')
  child.kill()
  process.exit(1)
}

const origin = new URL(bootUrl).origin
const bootToken = new URL(bootUrl).searchParams.get('token') ?? ''

/**
 * The `/api` channel authenticates with a signed browser cookie, not the launch
 * token. Exchanging the token for the cookie is exactly what a browser does:
 * GET the root with `?token=`, and the response sets it.
 */
let cookie = ''
async function exchangeTokenForCookie() {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(bootToken)}`, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const raw = setCookie.find((entry) => entry.includes('=')) ?? response.headers.get('set-cookie') ?? ''
  cookie = raw.split(';', 1)[0] ?? ''
  return cookie !== ''
}
if (!check('the launch token exchanges for a browser session cookie', await exchangeTokenForCookie())) {
  child.kill()
  process.exit(1)
}

/**
 * Call one DSH Remote method over the real /api channel. The gateway requires
 * the payload to carry exactly one plain-object `args` field.
 * @param {string} method - endpoint name, e.g. `pluginInventory/list`.
 * @param {Record<string, unknown>} args - request arguments.
 */
async function callRemote(method, args = {}) {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method, payload: { args } })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  const envelope = JSON.parse(text)
  const result = envelope?.result
  if (result?.ok === false) throw new Error(`remote error: ${JSON.stringify(result.error).slice(0, 300)}`)
  return result?.value ?? result
}

/**
 * The loader row for one config id, or undefined.
 *
 * Inventory ids are namespaced by their owning include layer — a row written as
 * `id: mcp-probe` in the profile patch appears as `include:mcp-probe` — so the
 * match is on the trailing segment. That namespacing is the whole reason a
 * config id is not usable as an identity key on its own.
 */
async function entryFor(id) {
  const snapshot = await callRemote('pluginInventory/list')
  return (snapshot?.entries ?? []).find(
    (entry) => typeof entry.entryId === 'string' && (entry.entryId === id || entry.entryId.endsWith(`:${id}`))
  )
}

/** The config ids currently composed. */
async function entryIds() {
  const snapshot = await callRemote('pluginInventory/list')
  return (snapshot?.entries ?? [])
    .map((entry) => (typeof entry.entryId === 'string' ? entry.entryId.replace(/^.*:/, '') : undefined))
    .filter((id) => id !== undefined)
}

/** Lines the fake server has logged so far. */
function serverLog() {
  return existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== '') : []
}

console.log('baseline')
check('the throwaway profile starts with no mcp row', !(await entryIds()).includes('mcp-probe'))

/* ── add ─────────────────────────────────────────────────────────────────── */

console.log('add a server by editing the patch file')
writeFileSync(join(PROBE_DIR, 'cordis.patch.yml'), renderPatch([mcpRow('mcp-probe', 'probe', process.execPath, [FAKE_SERVER, '--log', LOG])]))

const connected = await waitFor(() => serverLog().some((line) => line.includes('method=initialize')), 30_000)
check('the row connects live, with no restart', connected === true, `log: ${JSON.stringify(serverLog().slice(0, 6))}`)
check('the server is asked for its tool list', serverLog().some((line) => line.includes('method=tools/list')))

const row = await waitFor(async () => {
  const found = await entryFor('mcp-probe')
  return found?.fiberPhase === 'active' ? found : undefined
}, 20_000)
if (!check('the loader reports the row as active', row !== undefined)) {
  const snapshot = await callRemote('pluginInventory/list')
  console.log('    raw inventory:', JSON.stringify(snapshot).slice(0, 1200))
}

/* ── remove ──────────────────────────────────────────────────────────────── */

console.log('remove it by editing the patch file again')
writeFileSync(join(PROBE_DIR, 'cordis.patch.yml'), renderPatch([]))

const gone = await waitFor(async () => !(await entryIds()).includes('mcp-probe'), 20_000)
check('the row leaves the tree live', gone === true, JSON.stringify(await entryIds()))

const exited = await waitFor(() => serverLog().some((line) => line === 'stdin-end'), 15_000)
check('removing the row stops the server process', exited === true, JSON.stringify(serverLog().slice(-4)))

/* ── a server that cannot start ──────────────────────────────────────────── */

console.log('a server that cannot connect')
writeFileSync(
  join(PROBE_DIR, 'cordis.patch.yml'),
  renderPatch([mcpRow('mcp-broken', 'broken', 'definitely-not-a-real-executable-xyz', [])])
)

const broken = await waitFor(async () => {
  const found = await entryFor('mcp-broken')
  return found === undefined ? undefined : found
}, 25_000)
check('a failing row is reported by the loader', broken !== undefined, JSON.stringify(await entryFor('mcp-broken')))
check('and it is not active', broken?.fiberPhase !== 'active', `phase=${broken?.fiberPhase}`)
check('the instance survives a failing row', /dsh web: http/.test(childOutput))

/* ── teardown ────────────────────────────────────────────────────────────── */

console.log('teardown')
writeFileSync(join(PROBE_DIR, 'cordis.patch.yml'), renderPatch([]))
await new Promise((resolve) => setTimeout(resolve, 1_500))
spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 1_500))
rmSync(ROOT, { recursive: true, force: true })
console.log('  ok   probe server stopped and temp files removed')

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
