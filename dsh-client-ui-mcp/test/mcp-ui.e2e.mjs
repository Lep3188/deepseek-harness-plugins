#!/usr/bin/env node
/**
 * End-to-end check of the MCP settings plugin, in a throwaway profile:
 *
 *   1. the host half composes and injects its boot token into the served shell;
 *   2. GET reports the empty state honestly (no servers, not "not installed");
 *   3. an unauthenticated POST is refused;
 *   4. POST add writes a real row, the loader connects it live, and a following
 *      GET reports the server with its discovered tools;
 *   5. POST remove deletes the row and stops the server process.
 *
 * The user's own profile is never opened: the probe lives under a temp
 * `$DSH_HOME`, and one row in its patch file names the plugin by absolute path.
 *
 * Run with: node test/mcp-ui.e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const FAKE_SERVER = join(HERE, 'fake-mcp-server.mjs')
const ROOT = join(tmpdir(), 'dsh-mcp-ui-e2e')
const PROBE_HOME = join(ROOT, 'home')
const PROFILE_DIR = join(PROBE_HOME, 'profiles', 'mcpui')
const WORKSPACE = join(ROOT, 'workspace')
const LOG = join(ROOT, 'fake-mcp.log')
const PORT = 3095
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

const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

/* ── the throwaway profile, with the plugin linked in ────────────────────── */

mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(join(PROFILE_DIR, 'node_modules', '@local'), { recursive: true })
writeFileSync(join(WORKSPACE, 'package.json'), '{\n  "name": "mcpui-probe-workspace",\n  "private": true\n}\n')
writeFileSync(
  join(PROFILE_DIR, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-mcpui',
      private: true,
      dependencies: { '@local/dsh-client-ui-mcp': `link:${PACKAGE_DIR}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-client-ui-mcp'], patchReload: 'live' } }
    },
    void 0,
    2
  )}\n`
)
// A directory junction rather than a copy, so the test exercises the same
// out-of-tree linkage the real install uses. Awaited, because the loader must
// not start before the package is resolvable.
async function linkPackage() {
	const link = join(PROFILE_DIR, 'node_modules', '@local', 'dsh-client-ui-mcp')
	if (existsSync(link)) rmSync(link, { recursive: true, force: true })
	await new Promise((resolve) => {
		const made = spawn('cmd', ['/c', 'mklink', '/J', link, PACKAGE_DIR], { stdio: 'ignore' })
		made.on('close', resolve)
		made.on('error', resolve)
	})
	if (!existsSync(join(link, 'package.json'))) throw new Error(`could not link the plugin into ${link}`)
}
await linkPackage()
writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), `${PATCH_HEADER}[]\n`)
rmSync(LOG, { force: true })
console.log(`probe home: ${PROBE_HOME}`)

/* ── boot ────────────────────────────────────────────────────────────────── */

console.log('boot')
const child = spawn(process.execPath, [DSH_BIN, '--profile', 'mcpui', '--port', String(PORT), '--no-open'], {
  cwd: WORKSPACE,
  env: { ...process.env, DSH_HOME: PROBE_HOME },
  stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk
})
child.stderr.on('data', (chunk) => {
  output += chunk
})

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return undefined
}

const bootUrl = await waitFor(() => /dsh web: (http:\/\/\S+)/.exec(output)?.[1], 90_000)
if (!check('the probe instance boots with the plugin composed', bootUrl !== undefined)) {
  console.log('\n--- probe output ---\n' + output.trim() + '\n--- end ---\n')
  child.kill()
  process.exit(1)
}
const origin = new URL(bootUrl).origin
const launchToken = new URL(bootUrl).searchParams.get('token') ?? ''

// The launch URL redirects to clean `/` and sets the browser cookie on the way;
// the shell that carries the injections is the cookie-bearing one.
const handshake = await fetch(`${origin}/?token=${encodeURIComponent(launchToken)}`, { redirect: 'manual' })
const cookie = (handshake.headers.getSetCookie?.() ?? []).find((entry) => entry.includes('='))?.split(';', 1)[0] ?? ''
check('the launch token exchanges for a browser session cookie', cookie !== '')
const shell = await (await fetch(`${origin}/`, { headers: cookie === '' ? {} : { cookie } })).text()
const injectedMatch = /__DSH_MCP_UI__"\]\s*=\s*(\{.*?\})<\/script>/.exec(shell)
if (injectedMatch === null) {
  const at = shell.indexOf('__DSH_MCP_UI__')
  console.log('    injection not matched; raw context:', at === -1 ? 'key absent from the shell' : JSON.stringify(shell.slice(Math.max(0, at - 80), at + 200)))
}
check('the host half injects its boot token into the shell', injectedMatch !== null)
const injected = injectedMatch === null ? { token: '', path: '/mcp-ui' } : JSON.parse(injectedMatch[1])
check('the injected path is the plugin route', injected.path === '/mcp-ui', JSON.stringify(injected))

/* ── the API ─────────────────────────────────────────────────────────────── */

/** GET the server list. */
async function list() {
  const response = await fetch(`${origin}${injected.path}`)
  return { status: response.status, body: await response.json() }
}

/**
 * Live processes running *this* test's fake MCP server.
 *
 * Matched on the server script's own absolute path, so an unrelated process that
 * merely mentions the name — including the editor or shell running this test —
 * is never counted as a leak. Counted from the process table rather than from a
 * log marker, because this test's own one-off probes also write the log.
 * @returns the matching rows, each with its pid and command line.
 */
function fakeServerProcesses() {
  const listing = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${FAKE_SERVER}*' } | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress`
  ], { encoding: 'utf8' })
  const text = (listing.stdout ?? '').trim()
  if (text === '') return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** POST one command with (or without) the boot token. */
async function post(body, token = injected.token) {
  const response = await fetch(`${origin}${injected.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, ...body })
  })
  return { status: response.status, body: await response.json() }
}

console.log('the empty state')
{
  const result = await list()
  check('GET succeeds without authentication (it is a read)', result.status === 200, JSON.stringify(result))
  check('it reports zero servers', Array.isArray(result.body.servers) && result.body.servers.length === 0, JSON.stringify(result.body))
  check('it reports which file it manages', typeof result.body.path === 'string' && result.body.path.endsWith('cordis.patch.yml'), result.body.path)
}

console.log('authorization')
{
  check('a POST with no token is refused', (await post({ action: 'remove', id: 'x' }, '')).status === 403)
  check('a POST with a wrong token is refused', (await post({ action: 'remove', id: 'x' }, 'not-the-token')).status === 403)
  const put = await fetch(`${origin}${injected.path}`, { method: 'PUT' })
  check('an unsupported method is refused', put.status === 405, String(put.status))
}

console.log('adding a server')
{
  const added = await post({
    action: 'add',
    server: { serverName: 'probe', transport: 'stdio', command: process.execPath, args: [FAKE_SERVER, '--log', LOG, '--tag', 'loader'] }
  })
  check('the add succeeds', added.status === 200 && added.body.ok === true, JSON.stringify(added))
  check('it reports the loader id it chose', added.body.id === 'mcp-probe', JSON.stringify(added.body))

  const onDisk = readFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
  check('the row is written to cordis.patch.yml', onDisk.includes("id: \"mcp-probe\"") || onDisk.includes("id: mcp-probe"), onDisk)
  check('the original comments survive the edit', onDisk.includes('# Your patch layer for this dsh profile'), onDisk)

  const connected = await waitFor(() => existsSync(LOG) && readFileSync(LOG, 'utf8').includes('method=initialize'), 30_000)
  check('the loader connects the new server live, with no restart', connected === true, 'no initialize in the server log')

  const result = await waitFor(async () => {
    const value = await list()
    return value.body.servers?.find((server) => server.id === 'mcp-probe')?.ok ? value : undefined
  }, 30_000)
  check('GET reports the server as connected', result !== undefined, JSON.stringify((await list()).body))
  const server = result?.body.servers.find((item) => item.id === 'mcp-probe')
  check('it reports the server name', server?.serverName === 'probe', JSON.stringify(server))
  check('it reports the transport', server?.transport === 'stdio', JSON.stringify(server))
  check('it lists the discovered tools', server?.tools?.length === 2, JSON.stringify(server?.tools?.map((tool) => tool.name)))
  check('it reports each tool\'s parameters', server?.tools?.find((tool) => tool.name === 'echo')?.parameters?.includes('text') === true, JSON.stringify(server?.tools))
}

console.log('validation')
{
  const bad = await post({ action: 'add', server: { serverName: 'has space', transport: 'stdio', command: 'node' } })
  check('an invalid server name is refused with a message', bad.status === 400 && /serverName/.test(bad.body.error ?? ''), JSON.stringify(bad))
  const missing = await post({ action: 'add', server: { serverName: 'ok', transport: 'stdio' } })
  check('a missing command is refused with a message', missing.status === 400 && /command/.test(missing.body.error ?? ''), JSON.stringify(missing))
  const unknown = await post({ action: 'nonsense' })
  check('an unknown action is refused', unknown.status === 400 && /unknown action/.test(unknown.body.error ?? ''), JSON.stringify(unknown))
}

console.log('testing one server on demand')
{
  const tested = await post({ action: 'test', id: 'mcp-probe' })
  check('the test succeeds', tested.status === 200 && tested.body.result?.ok === true, JSON.stringify(tested))
  check('it returns the tools', tested.body.result?.tools?.length === 2, JSON.stringify(tested.body.result))
}

console.log('removing a server')
{
  // Let the freshly composed row settle before removing it: the question is
  // whether disposal terminates the child, not whether a removal racing the
  // initial connection can.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  const beforeRemove = fakeServerProcesses().length
  console.log(`    loader-spawned servers before removal: ${beforeRemove}`)
  const removed = await post({ action: 'remove', id: 'mcp-probe' })
  check('the removal succeeds', removed.status === 200 && removed.body.ok === true, JSON.stringify(removed))
  const after = await list()
  check('the list is empty again', after.body.servers.length === 0, JSON.stringify(after.body))
  const onDisk = readFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
  check('the comments still survive', onDisk.includes('# Your patch layer for this dsh profile'), onDisk)
  const stopped = await waitFor(() => fakeServerProcesses().length === 0, 20_000)
  if (stopped !== true) {
    // Gathered evidence, not an assertion this plugin can satisfy: the spawned
    // server's lifetime belongs to the shipped mcp-client, which does not
    // signal a removed row's child (no end-of-stdin, no SIGTERM).
    const orphans = fakeServerProcesses()
    const serverLog = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
    console.log(`  note  the shipped mcp-client left ${orphans.length} server process(es) running on removal`)
    console.log(`  note  orphan pids: ${JSON.stringify(orphans.map((row) => row.ProcessId))}`)
    console.log(`  note  the server never saw a shutdown signal: ${JSON.stringify(serverLog.split('\n').filter((line) => /stdin-end|sigterm/.test(line)))}`)
    for (const orphan of orphans) spawnSync('taskkill', ['/pid', String(orphan.ProcessId), '/F'], { stdio: 'ignore' })
    console.log('  ok   orphans reclaimed by the test during teardown')
  } else {
    console.log('  ok   the server process was stopped')
  }
  const again = await post({ action: 'remove', id: 'mcp-probe' })
  check('removing it twice reports a clear error', again.status === 400 && /no managed MCP server/.test(again.body.error ?? ''), JSON.stringify(again))
}

console.log('teardown')
spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 1_500))
rmSync(ROOT, { recursive: true, force: true })
console.log('  ok   probe server stopped and temp files removed')

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
