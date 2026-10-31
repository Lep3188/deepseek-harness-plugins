/**
 * Reading and writing the profile's `cordis.patch.yml` for MCP server rows.
 *
 * This is the part of the plugin that can break a machine, so it is built around
 * three rules:
 *
 *  1. **The file is text, not data.** It carries comments and `!!js` expressions
 *     (`process.env.GITHUB_TOKEN`); a parse-and-re-serialize round trip would
 *     silently destroy both. Every mutation is therefore surgical text surgery
 *     on the exact entry blocks, and the rest of the document is preserved
 *     byte-for-byte.
 *  2. **Never leave an unloadable file behind.** The write path validates the
 *     edited text by parsing it, writes a timestamped backup first, writes
 *     atomically (temp file + rename in the same directory), and restores the
 *     backup if any step fails. A parse that fails after an edit is treated as
 *     a bug and rolled back rather than left on disk.
 *  3. **Own only what we recognize.** Removal refuses to touch a block that does
 *     not parse to exactly one entry naming `@deepseek-ai/dsh-mcp-client` with
 *     the requested id, so a hand-edited file is never damaged by a delete.
 *
 * The composer tolerates a patch file that is missing, empty, or a `null`
 * document, because that is what a fresh or hand-cleared profile looks like.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from './yaml-subset.js'

/** The loader module every managed row names. */
export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
/** Suffix of the timestamped backups this module keeps beside the patch file. */
const BACKUP_SUFFIX = '.dsh-mcp-ui.bak'
/** Bound on the backups kept, newest first. */
const KEEP_BACKUPS = 5
/** Base64url or environment-expression references are rejected as literal values. */
const ENV_REFERENCE = /^!!js\b/

/** A parsed mcp-client row from the patch file. */
export function isMcpRow(entry) {
	return (
		entry !== null &&
		typeof entry === 'object' &&
		!Array.isArray(entry) &&
		typeof entry.name === 'string' &&
		entry.name === MCP_MODULE &&
		entry.config !== null &&
		typeof entry.config === 'object'
	)
}

/**
 * Split a loader patch document into its top-level textual entries.
 *
 * A YAML sequence entry begins at a line whose first non-space character is `-`;
 * every following line that is not a new entry (blank, comment, or further
 * indented) belongs to the entry above it. Comment and blank runs *between*
 * entries attach to the entry that follows — that is how a row's own
 * documentation travels with it — and a run at the very end of the document is
 * returned as trailing text so it survives an edit that empties the list.
 * @param content - the whole patch file.
 * @returns the leading text, one raw block per entry, and trailing text.
 */
function splitEntries(content) {
	const lines = content.split('\n')
	const blocks = []
	let leading = null
	let pending = []
	let trailing = []
	let current = null

	const flush = () => {
		if (current !== null) {
			blocks.push({ leading: current.leading, lines: current.lines })
			trailing = pending
			pending = []
		}
		current = null
	}

	for (const line of lines) {
		const indentation = line.length - line.trimStart().length
		const body = line.trimStart()
		const isEntryStart = indentation === 0 && body.startsWith('-')

		if (isEntryStart) {
			flush()
			current = { leading: pending, lines: [line] }
			pending = []
			continue
		}
		if (current === null) {
			// Before the first entry: the document preamble. `[]` counts as
			// content, so it ends the preamble rather than joining it.
			if (/^\s*\[\s*\]\s*$/.test(line)) {
				flush()
				current = { leading: pending, lines: [line] }
				pending = []
				continue
			}
			if (leading === null) leading = []
			leading.push(...pending)
			pending = []
			leading.push(line)
			continue
		}
		if (indentation === 0 && (body.startsWith('#') || body === '')) pending.push(line)
		else current.lines.push(line)
	}
	flush()
	return { leading: leading ?? [], blocks, trailing }
}

/**
 * Render the leading text plus blocks back into a patch document.
 *
 * A trailing placeholder `[]` is dropped whenever real blocks are added, and a
 * trailing empty leading section is dropped always. Leaving either behind
 * produces a document that claims to be an empty sequence and then carries
 * entries below it — which YAML reads as an empty list plus garbage, and which
 * would silently discard every row the UI just added.
 * @param leading - lines before the first entry.
 * @param blocks - raw entry blocks with their attached leading comments.
 * @param trailing - comment lines that followed the last entry.
 * @returns the composed file text.
 */
function joinBlocks(leading, blocks, trailing = []) {
	// Trim trailing blank lines without collapsing the last content line.
	const trimTail = (text) => text.replace(/(\n\s*)+$/, '')
	let head = trimTail(leading.join('\n'))
	if (blocks.length > 0) head = trimTail(head.replace(/(^|\n)\s*\[\s*\]\s*$/, ''))
	const parts = []
	if (head.trim() !== '') parts.push(head)
	for (const block of blocks) {
		const text = trimTail([...block.leading, ...block.lines].join('\n'))
		if (text.trim() !== '') parts.push(text)
	}
	const tail = trimTail(trailing.join('\n'))
	if (tail.trim() !== '') parts.push(tail)
	if (parts.length === 0) return '[]\n'
	return `${parts.join('\n')}\n`
}

/**
 * Find every mcp-client row in a patch document.
 *
 * A parse failure propagates rather than being skipped: a document the reader
 * cannot understand is one the loader cannot load either, and silently dropping
 * the unreadable part is how a UI would report "no servers" for a profile that
 * actually fails at boot.
 * @param content - the whole patch file.
 * @returns one record per row: its loader id and parsed config.
 * @throws when the document is not readable as a patch list.
 */
export function readMcpRows(content) {
	const { blocks } = splitEntries(content)
	const rows = []
	for (const block of blocks) {
		const text = block.lines.join('\n')
		const parsed = parseYaml(text)
		for (const entry of entryList(parsed)) {
			if (!isMcpRow(entry)) continue
			rows.push({ entry, text })
		}
	}
	return rows
}

/** Every entry a patch block declares, whether bare or behind an `insert:` list. */
function entryList(parsed) {
	if (parsed === null || typeof parsed !== 'object') return []
	const candidates = []
	const push = (value) => {
		if (Array.isArray(value)) candidates.push(...value)
		else if (value !== null && typeof value === 'object') candidates.push(value)
	}
	// A block is either one loader entry or one patch directive such as `insert`.
	for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
		if (value === null || typeof value !== 'object') continue
		const directive = value
		if ('insert' in directive) push(directive.insert)
		else candidates.push(directive)
	}
	return candidates
}

/**
 * Add one mcp-client row.
 *
 * Insertion prefers appending to an existing `insert:` list whose entries are
 * all mcp-client rows, so a profile that already groups its MCP servers stays
 * grouped; otherwise it appends a new block at the end of the document. An
 * empty `[]` document is rewritten into a real sequence.
 * @param content - the whole patch file.
 * @param id - loader id for the new row.
 * @param config - the mcp-client config object.
 * @returns the new file text.
 * @throws when the id already exists.
 */
export function addRow(content, id, config) {
	const existing = readMcpRows(content)
	if (existing.some((row) => row.entry.id === id)) throw new Error(`a server with id "${id}" already exists`)

	const block = renderInsert([{ id, config }])
	const { leading, blocks } = splitEntries(content)

	// Drop the empty-placeholder block: `[]` parses as a sequence holding one
	// scalar, and leaving it in place would compose a document whose first item is
	// `[]` followed by entries — which YAML reads as an empty list and then
	// ignores the rest, silently discarding the row just added.
	const real = blocks.filter((candidate) => !isPlaceholderBlock(candidate))

	// Prefer extending an insert list that is already MCP-only, so a profile that
	// groups its MCP servers stays grouped.
	for (const candidate of real) {
		const text = candidate.lines.join('\n')
		const directive = /^(\s*)-\s*insert:/m.exec(text)
		if (directive === null) continue
		let parsed
		try {
			parsed = parseYaml(text)
		} catch {
			continue
		}
		const entries = entryListForInsert(parsed)
		if (entries.length === 0) continue
		if (!entries.every((entry) => isMcpRow(entry))) continue
		// The inserted items sit one list level below the `insert:` key: this
		// appends a sibling item, never a second directive nested inside the first.
		const itemIndent = directive[1].length + 4
		candidate.lines.push(...renderItem({ id, config }, itemIndent).split('\n'))
		return joinBlocks(leading, real)
	}

	// Otherwise append a fresh top-level insert directive.
	real.push({ leading: [], lines: block.split('\n') })
	return joinBlocks(leading, real)
}

/** Whether a block is only the empty-sequence placeholder `[]`. */
function isPlaceholderBlock(block) {
	return block.lines.every((line) => /^\s*\[\s*\]\s*$/.test(line) || line.trim() === '')
}

/** The `insert:` entries declared by one parsed patch block. */
function entryListForInsert(parsed) {
	const values = Array.isArray(parsed) ? parsed : [parsed]
	for (const value of values) {
		if (value !== null && typeof value === 'object' && 'insert' in value) {
			const inserted = value.insert
			if (Array.isArray(inserted)) return inserted
			return inserted === null || inserted === undefined ? [] : [inserted]
		}
	}
	return []
}

/**
 * Render one loader row as a top-level `insert` directive.
 * @param items - the items to insert.
 * @returns the YAML block, unindented.
 */
export function renderInsert(items) {
	return ['- insert:', ...items.flatMap((item) => renderItem(item, 4).split('\n'))].join('\n')
}

/**
 * Render one loader item at an exact indentation.
 *
 * The item's `- ` costs two columns, so its keys start at `indent + 2` and its
 * config values at `indent + 4`. Values are JSON, which is valid YAML and needs
 * no quoting decisions — and is why a submitted value can never introduce a
 * YAML expression.
 * @param item - loader id plus config.
 * @param indent - column the item's dash sits at.
 * @returns the item's lines.
 */
export function renderItem(item, indent) {
	const pad = ' '.repeat(indent)
	const keyPad = ' '.repeat(indent + 2)
	const valuePad = ' '.repeat(indent + 4)
	const lines = [`${pad}- id: ${JSON.stringify(item.id)}`, `${keyPad}name: ${JSON.stringify(MCP_MODULE)}`, `${keyPad}config:`]
	for (const [key, value] of Object.entries(item.config)) {
		if (value === undefined) continue
		lines.push(`${valuePad}${key}: ${JSON.stringify(value)}`)
	}
	return lines.join('\n')
}

/**
 * Render one loader row.
 * @param id - loader id.
 * @param config - mcp-client config.
 * @returns the YAML block, unindented.
 */
export function renderRow(id, config) {
	return renderInsert([{ id, config }])
}

/**
 * Remove one mcp-client row by loader id, taking its comments with it.
 * @param content - the whole patch file.
 * @param id - the loader id to remove.
 * @returns the new file text and whether anything was removed.
 * @throws when the file contains no such manageable row.
 */
export function removeRow(content, id) {
	const { leading, blocks, trailing } = splitEntries(content)
	const kept = []
	let removed = 0

	for (const block of blocks) {
		const text = block.lines.join('\n')
		if (!text.includes(MCP_MODULE)) {
			kept.push(block)
			continue
		}		let parsed
		try {
			parsed = parseYaml(text)
		} catch {
			kept.push(block)
			continue
		}
		const entries = entryList(parsed)
		const matches = entries.filter((entry) => isMcpRow(entry) && entry.id === id)
		if (matches.length === 0) {
			kept.push(block)
			continue
		}
		// Refuse to rewrite a block we do not fully understand: if the block holds
		// anything besides the row being removed, leave it alone rather than risk
		// dropping a neighbouring row.
		const others = entries.filter((entry) => !(isMcpRow(entry) && entry.id === id))
		if (others.length > 0) {
			kept.push(block)
			removed = -1
			continue
		}
		removed += 1
	}

	if (removed === -1) {
		throw new Error(
			`the row "${id}" shares a patch block with other entries, so it cannot be removed safely from the UI; edit cordis.patch.yml by hand`
		)
	}
	if (removed === 0) throw new Error(`no managed MCP server with id "${id}" was found`)
	return { content: joinBlocks(leading, kept, trailing), removed }
}

/** Reject a value that is not a usable literal, so no expression can be injected. */
export function assertLiteralString(value, field, { required = true, maximum = 200 } = {}) {	if (value === undefined || value === null || value === '') {
		if (required) throw new Error(`${field} is required`)
		return undefined
	}
	if (typeof value !== 'string') throw new Error(`${field} must be text`)
	if (value.length > maximum) throw new Error(`${field} is longer than ${maximum} characters`)
	if (ENV_REFERENCE.test(value.trim())) throw new Error(`${field} must be a literal value, not a yaml expression`)
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${field} contains control characters`)
	return value
}

/** Validate and normalize one submitted server definition. */
export function normalizeServer(input) {
	if (input === null || typeof input !== 'object') throw new Error('the request body carries no server definition')
	const serverName = assertLiteralString(input.serverName, 'serverName', { maximum: 32 })
	if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
		throw new Error('serverName must be 1-32 characters of letters, digits, underscore, or dash')
	}
	const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
	if (transport === 'stdio') {
		const command = assertLiteralString(input.command, 'command', { maximum: 500 })
		const args = normalizeStringList(input.args, 'args')
		const env = normalizeStringMap(input.env, 'env')
		const cwd = assertLiteralString(input.cwd, 'cwd', { required: false, maximum: 1000 })
		const config = { serverName, transport, command, args }
		if (env !== undefined && Object.keys(env).length > 0) config.env = env
		if (cwd !== undefined) config.cwd = cwd
		return config
	}
	const url = assertLiteralString(input.url, 'url', { maximum: 1000 })
	if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
	const headers = normalizeStringMap(input.headers, 'headers')
	const config = { serverName, transport, url }
	if (headers !== undefined && Object.keys(headers).length > 0) config.headers = headers
	return config
}

/** A list of literal strings, trimmed of blanks. */
function normalizeStringList(value, field) {
	if (value === undefined || value === null) return []
	const items = Array.isArray(value) ? value : String(value).split('\n')
	return items
		.filter((item) => typeof item === 'string' && item.trim() !== '')
		.map((item) => assertLiteralString(item, `${field} entries`, { maximum: 500 }))
}

/** A map of literal strings; `KEY=value` lines are accepted from a textarea. */
function normalizeStringMap(value, field) {
	if (value === undefined || value === null || value === '') return undefined
	const entries = []
	if (Array.isArray(value)) {
		for (const item of value) entries.push(String(item))
	} else if (typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) entries.push(`${key}=${String(item)}`)
	} else {
		for (const line of String(value).split('\n')) entries.push(line)
	}
	const map = {}
	for (const entry of entries) {
		if (entry.trim() === '') continue
		const separator = entry.indexOf('=')
		if (separator <= 0) throw new Error(`${field} entries must be KEY=value lines`)
		const key = entry.slice(0, separator).trim()
		const item = entry.slice(separator + 1)
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${field} name "${key}" is not a valid name`)
		map[key] = assertLiteralString(item, `${field}.${key}`, { maximum: 2000 })
	}
	return map
}

/**
 * The profile directory whose patch file this plugin manages.
 * @param profileName - the booted profile name, when the host knows it.
 * @returns the absolute profile directory.
 */
export function resolveProfileDir(profileName, env = process.env) {
	const override = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(env.USERPROFILE ?? env.HOME ?? '.', '.dsh')
	const name = profileName !== undefined && profileName !== '' ? profileName : 'web'
	return join(override, 'profiles', name)
}

/** The patch file this plugin manages. */
export function patchFileFor(profileDir) {
	return join(profileDir, 'cordis.patch.yml')
}

/**
 * Load the patch document, treating absence as an empty list.
 * @param file - absolute patch-file path.
 * @returns the file text.
 */
export function loadPatch(file) {
	if (!existsSync(file)) return '[]\n'
	const content = readFileSync(file, 'utf8')
	if (content.trim() === '') return '[]\n'
	return content
}

/**
 * Parse a candidate patch document and reject it when it is not a loader patch
 * list. This is the gate that keeps a bad edit from reaching the next boot.
 * @param content - candidate file text.
 * @throws when the text is not a patch list.
 */
export function assertPatchDocument(content) {
	const parsed = parseYaml(content)
	if (parsed === null || parsed === undefined) return
	if (!Array.isArray(parsed)) throw new Error('the patch document must be a top-level YAML list')
}
/**
 * Write the patch document atomically, with a backup and a rollback.
 * @param file - absolute patch-file path.
 * @param content - the validated file text.
 */
export function writePatch(file, content) {
	assertPatchDocument(content)
	mkdirSync(join(file, '..'), { recursive: true })
	if (existsSync(file)) backup(file)
	const temporary = `${file}.${process.pid}.tmp`
	try {
		writeFileSync(temporary, content, 'utf8')
		renameSync(temporary, file)
	} catch (error) {
		try {
			if (existsSync(temporary)) unlinkSync(temporary)
		} catch {
			/* the rename failure is the error worth reporting */
		}
		throw error
	}
}

/** Keep a bounded set of timestamped backups beside the patch file. */
function backup(file) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const target = `${file}${BACKUP_SUFFIX}.${stamp}`
	try {
		writeFileSync(target, readFileSync(file, 'utf8'), 'utf8')
	} catch {
		throw new Error('could not write a backup of cordis.patch.yml; refusing to edit it')
	}
	pruneBackups(file)
}

/** Drop the oldest backups beyond {@link KEEP_BACKUPS}. */
function pruneBackups(file) {
	try {
		const directory = join(file, '..')
		const prefix = `${file.split(/[\\/]/).pop()}${BACKUP_SUFFIX}.`
		const olds = readdirSync(directory)
			.filter((name) => name.startsWith(prefix))
			.sort()
			.reverse()
		for (const name of olds.slice(KEEP_BACKUPS)) unlinkSync(join(directory, name))
	} catch {
		/* pruning is housekeeping; never fail an edit over it */
	}
}
