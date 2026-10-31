#!/usr/bin/env node
/**
 * A minimal MCP stdio server, used only by test/live-add-remove.mjs.
 *
 * It speaks just enough of the protocol for `dsh-mcp-client` to connect and
 * discover tools: `initialize`, `notifications/initialized`, and `tools/list`.
 * Every request it receives is appended to the file named by
 * `--log <path>` (or FAKE_MCP_LOG), which is how the harness proves that a
 * config edit actually caused a live connection rather than being ignored.
 *
 * Dependency-free on purpose: it must run from a temp directory with no
 * node_modules, so the test needs no network and no install step.
 */
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const logIndex = argv.indexOf('--log')
const logPath = logIndex === -1 ? process.env.FAKE_MCP_LOG : argv[logIndex + 1]
const tagIndex = argv.indexOf('--tag')
const tag = tagIndex === -1 ? '' : ` tag=${argv[tagIndex + 1]}`

/** Append one line to the log file, if a log was requested. */
function log(line) {
  if (logPath === undefined || logPath === '') return
  try {
    appendFileSync(logPath, `${line}\n`)
  } catch {
    /* the test owns the file; a logging failure must not break the server */
  }
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text']
    }
  },
  {
    name: 'server_time',
    description: 'Report the current server time as text.',
    inputSchema: { type: 'object', properties: {} }
  }
]

log(`start pid=${process.pid}${tag}`)

/** Write one JSON-RPC message as a single line on stdout, which is the wire framing the SDK uses. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line !== '') handle(line)
    newline = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  log(`stdin-end pid=${process.pid}${tag}`)
  process.exit(0)
})
process.on('SIGTERM', () => {
  log(`sigterm pid=${process.pid}${tag}`)
  process.exit(0)
})

function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log(`bad-json ${line.slice(0, 80)}`)
    return
  }
  log(`request method=${String(message.method)} id=${String(message.id)}`)
  if (message.id === undefined) return // a notification needs no response

  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fake-mcp', version: '0.0.1' }
        }
      })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const name = message.params?.name
      const text = name === 'echo' ? String(message.params?.arguments?.text ?? '') : new Date().toISOString()
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })
      return
    }
    case 'ping':
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    default:
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not found: ${String(message.method)}` }
      })
  }
}
