#!/usr/bin/env node
/**
 * Diagnostic: boot the probe profile and dump whether the plugin's boot token
 * reaches the shell, with and without the browser cookie. Not part of the test
 * suite; kept beside it because "the injection did not happen" has several
 * causes (listener order, a swallowed apply error, the wrong request) and this
 * separates them.
 *
 * Run with: node test/dump-shell.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const ROOT = join(tmpdir(), 'dsh-mcp-ui-dump')
const PROBE_HOME = join(ROOT, 'home')
const PROFILE_DIR = join(PROBE_HOME, 'profiles', 'mcpdump')
const WORKSPACE = join(ROOT, 'workspace')
const PORT = 3094
// The launcher under test: DSH_BIN wins, else the standard npm global prefix on
// Windows (`%APPDATA%\npm`), where `npm i -g @deepseek-ai/dsh` installs it.
const DSH_BIN = process.env.DSH_BIN ?? join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(join(PROFILE_DIR, 'node_modules', '@local'), { recursive: true })
writeFileSync(join(WORKSPACE, 'package.json'), '{"name":"dump-workspace","private":true}\n')
writeFileSync(
  join(PROFILE_DIR, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-mcpdump',
      private: true,
      dependencies: { '@local/dsh-client-ui-mcp': `link:${PACKAGE_DIR}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-client-ui-mcp'], patchReload: 'live' } }
    },
    void 0,
    2
  )}\n`
)
const link = join(PROFILE_DIR, 'node_modules', '@local', 'dsh-client-ui-mcp')
if (existsSync(link)) rmSync(link, { recursive: true, force: true })
await new Promise((resolve) => {
  const made = spawn('cmd', ['/c', 'mklink', '/J', link, PACKAGE_DIR], { stdio: 'ignore' })
  made.on('close', resolve)
  made.on('error', resolve)
})
writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), '# probe\n[]\n')

const child = spawn(process.execPath, [DSH_BIN, '--profile', 'mcpdump', '--port', String(PORT), '--no-open'], {
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

const deadline = Date.now() + 90_000
let url
while (Date.now() < deadline) {
  url = /dsh web: (http:\/\/\S+)/.exec(output)?.[1]
  if (url) break
  await new Promise((resolve) => setTimeout(resolve, 400))
}
if (!url) {
  console.log('boot failed:\n' + output)
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  process.exit(1)
}
const origin = new URL(url).origin
const token = new URL(url).searchParams.get('token') ?? ''

const first = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).find((entry) => entry.includes('='))?.split(';', 1)[0] ?? ''
const firstBody = await first.text()
const clean = await (await fetch(`${origin}/`, { headers: cookie === '' ? {} : { cookie } })).text()

for (const [label, body] of [['?token= response', firstBody], ['cookie response', clean]]) {
  const at = body.indexOf('__DSH_MCP_UI__')
  console.log(`${label}: length=${body.length} key=${at === -1 ? 'ABSENT' : `present at ${at}`}`)
  if (at !== -1) console.log('   ', JSON.stringify(body.slice(Math.max(0, at - 60), at + 160)))
}
const toastAt = clean.indexOf('__DSH_TASK_TOAST__')
console.log(`reference (toast plugin injection) in cookie response: ${toastAt === -1 ? 'ABSENT' : `present at ${toastAt}`}`)
console.log(`host log mentions mcp-ui: ${/mcp-ui/.test(output)}`)
const warn = output.split('\n').filter((line) => /mcp-ui|warn|error/i.test(line)).slice(0, 10)
console.log('host log lines of interest:\n' + warn.join('\n'))

spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 1_200))
rmSync(ROOT, { recursive: true, force: true })
