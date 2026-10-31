/**
 * A deliberately small YAML reader for loader patch documents.
 *
 * Why not js-yaml: this plugin is linked into a profile from outside it, so a
 * real YAML dependency would have to be injected into the user's profile
 * (`node_modules` plus a `dependencies` entry) just to run. The grammar this
 * plugin actually meets is tiny — the rows it writes are a JSON subset, and the
 * rows a user hand-writes are plain block or flow YAML — so it carries its own
 * reader instead.
 *
 * Why "strict" matters: this parser is the safety gate in front of a file whose
 * corruption would stop dsh from booting. It must never guess. Any line it does
 * not fully understand — a block scalar, an anchor, a merge key, a `!!js`
 * expression, an unquoted value it cannot type confidently — throws, and the
 * caller refuses the edit. A false rejection costs an error message; a false
 * acceptance could cost a bootable profile.
 *
 * Supported: top-level flow sequences, block sequences of block mappings,
 * nested block mappings, comments, quoted and plain scalars, and `---`/`...`
 * markers. Not supported (rejected loudly): tags, anchors, aliases, flow maps
 * inside sequences, block scalars, multi-document streams.
 */

/** A parsed scalar value from the supported subset. */
const NULLS = new Set(['null', 'Null', 'NULL', '~', ''])
const TRUE = new Set(['true', 'True', 'TRUE'])
const FALSE = new Set(['false', 'False', 'FALSE'])

export function parseYaml(text) {
	const lines = stripComments(text)
	if (lines.length === 0) return null
	const { value } = parseBlock(lines, 0, 0)
	return value
}

/**
 * Drop comment-only lines, `---` markers, and trailing `...` terminators; keep
 * blank lines out of the indentation analysis while preserving line identity.
 * @param text - the raw document.
 * @returns significant lines with their indentation.
 */
function stripComments(text) {
	const raw = text.split('\n')
	const significant = []
	for (const line of raw) {
		const trimmed = line.trim()
		if (trimmed === '' || trimmed === '---' || trimmed === '...') continue
		if (trimmed.startsWith('#')) continue
		const withoutComment = removeTrailingComment(line)
		if (withoutComment.trim() === '') continue
		significant.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trimEnd() })
	}
	return significant
}

/** Remove a trailing `# …` comment that is not inside quotes. */
function removeTrailingComment(line) {
	let quote = null
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]
		if (quote !== null) {
			if (char === '\\') index += 1
			else if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
	}
	return line
}

/**
 * Parse one block at an exact indentation.
 * @param lines - significant lines.
 * @param start - index to begin at.
 * @param indent - the exact indentation this block owns.
 * @returns the parsed value and the next unread index.
 */
function parseBlock(lines, start, indent) {
	const first = lines[start]
	if (first === undefined) return { value: null, next: start }
	if (first.indent !== indent) throw new Error(`unexpected indentation at line "${first.text.trim()}"`)
	if (first.text.trimStart().startsWith('- insert:')) return parseTopSequence(lines, start, indent)
	if (first.text.trimStart().startsWith('-')) return parseTopSequence(lines, start, indent)
	if (first.text.trimStart().startsWith('[')) {
		const value = parseFlowSequence(first.text.trim())
		return { value, next: start + 1 }
	}
	if (first.text.trimStart() === '[]') return { value: [], next: start + 1 }
	return parseMappingBlock(lines, start, indent)
}

/**
 * A top-level sequence whose items may be mappings (the `- insert:` shape) or
 * scalars. Items sit at exactly `indent`; their content is indented beyond it.
 *
 * A line at this level that is not a sequence item is an error rather than an
 * end-of-block: a document cannot be part-way a sequence, and silently stopping
 * here is how a malformed patch file would pass validation and then fail at
 * boot. Comments and blank lines were removed before parsing, so anything left
 * at this indentation really is content.
 */
function parseTopSequence(lines, start, indent) {
	const items = []
	let index = start
	while (index < lines.length) {
		const line = lines[index]
		if (line.indent < indent) break
		if (line.indent > indent) throw new Error(`unexpected indentation at line "${line.text.trim()}"`)
		const body = line.text.trimStart()
		if (!body.startsWith('-')) {
			throw new Error(`expected a sequence item at "${body}", which would make the patch list unreadable`)
		}
		const rest = body.slice(1)
		if (rest.trim() === '') {
			// A bare dash introduces a nested block on the following lines.
			const child = parseBlock(lines, index + 1, indent + 2)
			items.push(child.value)
			index = child.next
			continue
		}
		// Inline content after the dash: treat it as the first line of a block
		// whose indentation is where that content starts.
		const contentIndent = indent + 2
		const contentLine = { indent: contentIndent, text: ' '.repeat(contentIndent) + rest.trimStart() }
		const nested = [contentLine, ...lines.slice(index + 1)]
		const child = parseBlock(nested, 0, contentIndent)
		items.push(child.value)
		index += child.next
	}
	return { value: items, next: index }
}

/** A block mapping at one indentation: `key: value`, `key:` + nested block, or `- ` handled above. */
function parseMappingBlock(lines, start, indent) {
	const map = {}
	let index = start
	while (index < lines.length) {
		const line = lines[index]
		if (line.indent < indent) break
		if (line.indent > indent) throw new Error(`unexpected indentation at line "${line.text.trim()}"`)
		const body = line.text.trimStart()
		if (body.startsWith('-')) break
		const separator = keySeparator(body)
		if (separator === -1) throw new Error(`expected a "key: value" line, found "${body}"`)
		const key = parseScalar(body.slice(0, separator))
		if (typeof key !== 'string' || key === '') throw new Error(`invalid key in "${body}"`)
		const rest = body.slice(separator + 1).trim()
		index += 1
		if (rest === '') {
			const next = lines[index]
			if (next !== undefined && next.indent > indent) {
				const child = parseBlock(lines, index, next.indent)
				map[key] = child.value
				index = child.next
			} else {
				map[key] = null
			}
			continue
		}
		map[key] = parseScalar(rest)
	}
	return { value: map, next: index }
}

/** Index of the `:` that separates a mapping key from its value, ignoring quoted keys. */
function keySeparator(body) {
	let quote = null
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index]
		if (quote !== null) {
			if (char === '\\') index += 1
			else if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === ':' && (index + 1 === body.length || body[index + 1] === ' ')) return index
	}
	return -1
}

/**
 * Parse one scalar, a flow sequence, or tagged expression value.
 *
 * A `!!js` expression — how a real profile injects `process.env.X` — is accepted
 * and kept as opaque text. It is never executed, never re-serialized, and never
 * offered to the UI as an editable field: it exists so that a hand-written row
 * carrying one is still *recognized* (and left byte-for-byte untouched), rather
 * than being invisible to the reader and silently unmanageable.
 * @param text - the raw value text.
 */
function parseScalar(text) {
	const value = text.trim()
	if (value === '') return null
	if (value.startsWith('[')) return parseFlowSequence(value)
	if (value.startsWith('{')) throw new Error(`flow mappings are not supported (${value})`)
	if (value.startsWith('!!')) {
		const expression = value.replace(/^!!\S*\s*/, '')
		return expression === '' ? null : { __yamlExpression: expression }
	}
	if (value.startsWith('&') || value.startsWith('*') || value.startsWith('|') || value.startsWith('>')) {
		throw new Error(`unsupported yaml construct (${value.split(/\s/, 1)[0]})`)
	}
	if (value.startsWith('"')) {
		if (!value.endsWith('"') || value.length === 1) throw new Error(`unterminated quoted value (${value})`)
		return JSON.parse(value)
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'") || value.length === 1) throw new Error(`unterminated quoted value (${value})`)
		return value.slice(1, -1).replaceAll("''", "'")
	}
	if (NULLS.has(value)) return null
	if (TRUE.has(value)) return true
	if (FALSE.has(value)) return false
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
	if (/(^|\s)[!&*]/.test(value)) throw new Error(`unsupported yaml construct (${value})`)
	return value
}

/** Parse a single-line flow sequence of scalars or flow sequences. */
function parseFlowSequence(value) {
	if (!value.endsWith(']')) throw new Error(`unterminated flow sequence (${value})`)
	const inner = value.slice(1, -1).trim()
	if (inner === '') return []
	const items = []
	let depth = 0
	let quote = null
	let start = 0
	for (let index = 0; index < inner.length; index += 1) {
		const char = inner[index]
		if (quote !== null) {
			if (char === '\\') index += 1
			else if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === '[') depth += 1
		else if (char === ']') depth -= 1
		else if (char === ',' && depth === 0) {
			items.push(parseScalar(inner.slice(start, index)))
			start = index + 1
		}
	}
	items.push(parseScalar(inner.slice(start)))
	return items
}
