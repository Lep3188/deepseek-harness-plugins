#!/usr/bin/env node
/**
 * Diagnostic: does killing a spawned stdio server actually reap it on Windows?
 * Run with: node test/kill-check.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-mcp-server.mjs')
const LOG = join(process.env.TEMP ?? '/tmp', 'dsh-mcp-ui-killcheck.log')

function running() {
  const out = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${FAKE}*' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`
  ], { encoding: 'utf8' })
  const text = (out.stdout ?? '').trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function scenario(label, close) {
  const child = spawn(process.execPath, [FAKE, '--log', LOG], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  const before = running().length
  await close(child)
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  const after = running()
  console.log(`${label}: running before=${before} after=${after.length}${after.length === 0 ? '' : ` pids=${JSON.stringify(after)}`}`)
  for (const pid of after) {
    spawnSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore' })
  }
}

await scenario('kill only', async (child) => {
  child.kill()
})

await scenario('kill after unref', async (child) => {
  child.unref()
  child.stdin.end()
  child.kill()
})

await scenario('stdin.end then kill', async (child) => {
  child.stdin.end()
  await new Promise((resolve) => setTimeout(resolve, 300))
  child.kill()
})
