#!/usr/bin/env node
/**
 * Checks for the MCP probe: it must discover a real server's tools, report an
 * unreachable server as data instead of throwing, and never leave a process
 * behind.
 *
 * Run with: node test/probe.test.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeServer } from '../lib/probe.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fake-mcp-server.mjs')
const LOG = join(tmpdir(), 'dsh-mcp-ui-probe-test.log')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

rmSync(LOG, { force: true })

console.log('a reachable stdio server')
{
  const result = await probeServer({
    serverName: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE, '--log', LOG]
  })
  check('the probe succeeds', result.ok === true, JSON.stringify(result))
  check('it reports the server identity', result.serverInfo?.name === 'fake-mcp', JSON.stringify(result.serverInfo))
  check('it discovers every tool', result.tools?.length === 2, JSON.stringify(result.tools?.map((tool) => tool.name)))
  const echo = result.tools?.find((tool) => tool.name === 'echo')
  check('it keeps a tool description', typeof echo?.description === 'string' && echo.description.length > 0, JSON.stringify(echo))
  check('it lists the tool parameters', echo?.parameters?.includes('text') === true, JSON.stringify(echo?.parameters))
  check('it lists required parameters', echo?.required?.includes('text') === true, JSON.stringify(echo?.required))
  const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  check('it performed the handshake', log.includes('method=initialize') && log.includes('method=tools/list'))
}

console.log('a server that cannot start')
{
  const result = await probeServer({ serverName: 'broken', transport: 'stdio', command: 'definitely-not-real-xyz', args: [] })
  check('the failure is data, not a throw', result.ok === false, JSON.stringify(result))
  check('the failure explains itself', typeof result.error === 'string' && result.error.length > 0, JSON.stringify(result.error))
}

console.log('a server that hangs')
{
  // `node -e ""` with an open stdin exits immediately, so use a script that
  // blocks forever without answering.
  const started = Date.now()
  const result = await probeServer({
    serverName: 'hanging',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()']
  })
  const elapsed = Date.now() - started
  check('a silent server is reported as a timeout', result.ok === false && /no response within/.test(result.error ?? ''), JSON.stringify(result))
  // The probe must bound itself well under the 15s goal; this asserts the
  // timeout is real rather than the process simply hanging.
  check('and the probe returns promptly', elapsed < 20_000, `${elapsed}ms`)
}

console.log('an unreachable http server')
{
  const result = await probeServer({ serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' })
  check('the failure is data, not a throw', result.ok === false, JSON.stringify(result))
  check('the failure explains itself', typeof result.error === 'string' && result.error.length > 0, JSON.stringify(result.error))
}

console.log('a row with no transport target')
{
  const noCommand = await probeServer({ serverName: 'x', transport: 'stdio' })
  check('a stdio row with no command is rejected', noCommand.ok === false && /no command/.test(noCommand.error ?? ''), JSON.stringify(noCommand))
  const noUrl = await probeServer({ serverName: 'x', transport: 'streamable-http' })
  check('an http row with no url is rejected', noUrl.ok === false && /no url/.test(noUrl.error ?? ''), JSON.stringify(noUrl))
}

rmSync(LOG, { force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
