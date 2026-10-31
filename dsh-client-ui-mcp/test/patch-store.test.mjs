#!/usr/bin/env node
/**
 * Checks for the config editor: the part of this plugin that can corrupt a
 * profile. The properties that matter are preservation (comments and `!!js`
 * expressions survive an edit), round-tripping (add then remove restores the
 * original text), and refusal (anything the reader does not fully understand is
 * rejected rather than rewritten).
 *
 * Run with: node test/patch-store.test.mjs
 */
import { addRow, assertPatchDocument, normalizeServer, readMcpRows, removeRow, renderRow } from '../lib/patch-store.js'
import { parseYaml } from '../lib/yaml-subset.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const GITHUB_ROW = `- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
`

console.log('the yaml subset reader')
check('reads a flow sequence', JSON.stringify(parseYaml("args: ['-y', 'x']")) === '{"args":["-y","x"]}', JSON.stringify(parseYaml("args: ['-y', 'x']")))
check('reads an empty document marker', JSON.stringify(parseYaml('[]')) === '[]')
check('reads nulls, booleans, and numbers', JSON.stringify(parseYaml('a: null\nb: true\nc: 42')) === '{"a":null,"b":true,"c":42}')
check('strips trailing comments', parseYaml('a: 1 # note').a === 1)
check('keeps a yaml expression as opaque text rather than executing it', (() => {
  const parsed = parseYaml('a: !!js process.env.X')
  return parsed?.a?.__yamlExpression === 'process.env.X'
})())
check('rejects an anchor', (() => {
  try {
    parseYaml('a: &anchor value')
    return false
  } catch {
    return true
  }
})())
check('rejects a flow mapping', (() => {
  try {
    parseYaml('a: {b: 1}')
    return false
  } catch {
    return true
  }
})())
check('rejects a block scalar', (() => {
  try {
    parseYaml('a: |\n  text')
    return false
  } catch {
    return true
  }
})())

/** The template's comments, with the empty placeholder replaced by real rows. */
function withRows(...rows) {
	const comments = TEMPLATE.split('\n').filter((line) => !/^\s*\[\s*\]\s*$/.test(line) && line.trim() !== '')
	return `${comments.join('\n')}\n${rows.join('\n')}\n`
}

console.log('reading rows out of a patch document')
const withGithub = withRows(GITHUB_ROW)
{
  console.log('DEBUG withGithub =', JSON.stringify(withGithub))
  const rows = readMcpRows(withGithub)
  check('finds the hand-written row', rows.length === 1, `${rows.length} rows`)
  check('reads its id', rows[0]?.entry.id === 'mcp-github', rows[0]?.entry.id)
  check('reads its config', rows[0]?.entry.config?.serverName === 'github', JSON.stringify(rows[0]?.entry.config))
  // The `!!js` value is text to the reader; what matters is that the entry is
  // still recognized as an mcp-client row so the UI can show it.
  check('still recognizes a row carrying a yaml expression', rows[0]?.entry.name === '@deepseek-ai/dsh-mcp-client')
}

console.log('adding a row')
{
  const added = addRow(TEMPLATE, 'mcp-first', { serverName: 'first', transport: 'stdio', command: 'node', args: ['server.js'] })
  check('preserves every original comment', added.includes('# Your patch layer for this dsh profile') && added.includes('`!!js` expressions allowed'))
  check('the result is a valid patch list', (() => {
    try {
      assertPatchDocument(added)
      return true
    } catch {
      return false
    }
  })())
  const parsed = parseYaml(added)
  check('the list now has one entry', Array.isArray(parsed) && parsed.length === 1, JSON.stringify(parsed))
  check('the entry inserts one row', parsed[0]?.insert?.[0]?.id === 'mcp-first', JSON.stringify(parsed[0]))
  check('the row names the mcp client', parsed[0]?.insert?.[0]?.name === '@deepseek-ai/dsh-mcp-client')
  check('the row carries the transport', parsed[0]?.insert?.[0]?.config?.transport === 'stdio')
  check('the row carries the args', JSON.stringify(parsed[0]?.insert?.[0]?.config?.args) === '["server.js"]')
  check('reading it back finds the row', readMcpRows(added).length === 1)
}

console.log('adding a second row keeps the first')
{
  const once = addRow(TEMPLATE, 'mcp-one', { serverName: 'one', transport: 'stdio', command: 'a', args: [] })
  const twice = addRow(once, 'mcp-two', { serverName: 'two', transport: 'streamable-http', url: 'http://localhost:3000/mcp' })
  const rows = readMcpRows(twice)
  check('both rows are present', rows.length === 2, `${rows.length} rows`)
  check('the first survives', rows.some((row) => row.entry.id === 'mcp-one'))
  check('the second is added', rows.some((row) => row.entry.id === 'mcp-two'))
  check('a duplicate id is refused', (() => {
    try {
      addRow(twice, 'mcp-two', { serverName: 'two', transport: 'stdio', command: 'x', args: [] })
      return false
    } catch {
      return true
    }
  })())
}

console.log('an existing hand-written row is not disturbed')
{
  const added = addRow(withGithub, 'mcp-new', { serverName: 'new', transport: 'stdio', command: 'node', args: [] })
  check('the expression row still parses', (() => {
    try {
      assertPatchDocument(added)
      return true
    } catch {
      return false
    }
  })())
  check('its text is untouched', added.includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'))
  check('both rows are readable', readMcpRows(added).length === 2, `${readMcpRows(added).length} rows`)
  check('the original comments survive', added.includes('# overrides, disables, and insert lists'))
}

console.log('removing a row')
{
  const added = addRow(TEMPLATE, 'mcp-x', { serverName: 'x', transport: 'stdio', command: 'node', args: [] })
  const { content, removed } = removeRow(added, 'mcp-x')
  check('reports one removal', removed === 1, String(removed))
  check('the row is gone', readMcpRows(content).length === 0)
  const reparsed = parseYaml(content) ?? []
  check('the document is empty again', Array.isArray(reparsed) && reparsed.length === 0, JSON.stringify(reparsed))
  check('the header comments survive the round trip', content.includes('# Your patch layer for this dsh profile'), JSON.stringify(content))
  check('the result is exactly the template comments and nothing else', content === `${TEMPLATE.split('\n').filter((line) => !/^\s*\[\s*\]\s*$/.test(line) && line.trim() !== '').join('\n')}\n`, JSON.stringify(content))
  check('removing an unknown id is refused', (() => {
    try {
      removeRow(added, 'mcp-absent')
      return false
    } catch {
      return true
    }
  })())
}

console.log('removal refuses what it cannot do safely')
{
  // One block holding two rows cannot lose just one of them.
  const shared = `- insert:
    - id: mcp-a
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: a
        transport: stdio
        command: node
        args: []
    - id: mcp-b
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: b
        transport: stdio
        command: node
        args: []
`
  check('a shared block is refused rather than half-removed', (() => {
    try {
      removeRow(shared, 'mcp-a')
      return false
    } catch (error) {
      return /shares a patch block/.test(String(error.message))
    }
  })())
  const untouched = readMcpRows(shared)
  check('and both rows stay readable', untouched.length === 2, `${untouched.length} rows`)
}

console.log('removal leaves unrelated rows alone')
{
  const mixed = withRows(
    `- id: system-prompt
  config:
    personaSuffix: keep me`,
    GITHUB_ROW
  )
  const { content } = removeRow(mixed, 'mcp-github')
  check('the unrelated entry survives', content.includes('personaSuffix: keep me'))
  check('the removed row is gone', readMcpRows(content).length === 0)
  check('and the result still parses', (() => {
    try {
      assertPatchDocument(content)
      return true
    } catch {
      return false
    }
  })())
}

console.log('validating submissions')
{
  check('accepts a stdio server', normalizeServer({ serverName: 'ok', transport: 'stdio', command: 'node', args: ['a'] }).transport === 'stdio')
  check('accepts an http server', normalizeServer({ serverName: 'ok', transport: 'streamable-http', url: 'http://x/mcp' }).url === 'http://x/mcp')
  check('rejects a bad serverName', (() => {
    try {
      normalizeServer({ serverName: 'has space', transport: 'stdio', command: 'node' })
      return false
    } catch {
      return true
    }
  })())
  check('rejects a missing command', (() => {
    try {
      normalizeServer({ serverName: 'ok', transport: 'stdio' })
      return false
    } catch {
      return true
    }
  })())
  check('rejects a non-http url', (() => {
    try {
      normalizeServer({ serverName: 'ok', transport: 'streamable-http', url: 'file:///etc/passwd' })
      return false
    } catch {
      return true
    }
  })())
  check('rejects a yaml expression smuggled as a value', (() => {
    try {
      normalizeServer({ serverName: 'ok', transport: 'stdio', command: '!!js process.exit(1)' })
      return false
    } catch {
      return true
    }
  })())
  check('parses env lines', JSON.stringify(normalizeServer({ serverName: 'ok', transport: 'stdio', command: 'n', env: 'A=1\nB=2' }).env) === '{"A":"1","B":"2"}')
  check('rejects a malformed env line', (() => {
    try {
      normalizeServer({ serverName: 'ok', transport: 'stdio', command: 'n', env: 'NOTAPAIR' })
      return false
    } catch {
      return true
    }
  })())
}

console.log('rendering')
{
  const rendered = renderRow('mcp-r', { serverName: 'r', transport: 'stdio', command: 'node', args: ['-e', 'x'] })
  check('renders a parseable block', (() => {
    try {
      return Array.isArray(parseYaml(rendered)) && parseYaml(rendered).length === 1
    } catch {
      return false
    }
  })(), rendered)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
