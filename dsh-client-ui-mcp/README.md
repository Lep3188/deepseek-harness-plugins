# @local/dsh-client-ui-mcp

**Package:** `@local/dsh-client-ui-mcp` · **Row id:** `mcp-ui` ·
Part of [deepseek-harness-plugins](../README.md)

An **MCP servers section in the DeepSeek Harness Web GUI**: it lists the MCP
servers configured in your profile, shows whether each one connects and which
tools it offers, and lets you add or remove servers from the page.

```
Settings → MCP servers

  MCP servers                                    [ Add server ]
  ~/.dsh/profiles/web/cordis.patch.yml

  ┌────────────────────────────────────────────────────────────┐
  │ github   stdio   [connected]   [12 tools]                  │
  │ npx -y @modelcontextprotocol/server-github                 │
  │   mcp__github__create_issue (title, body) — Open an issue  │
  │   mcp__github__search_code (query) — Search code           │
  │   …                                                        │
  │                          [ Test connection ]  [ Remove ]   │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ web   streamable-http   [not connected]                    │
  │ http://localhost:3000/mcp                                  │
  │ initialize returned HTTP 404                               │
  └────────────────────────────────────────────────────────────┘
```

With nothing configured it says so, and names the file it would edit — "no
servers configured" and "the host half is not composed" are reported as different
states, because only one of them is something you can act on.

## What it does

| Action | Effect |
|---|---|
| Open the section | Reads your profile's `cordis.patch.yml` and probes every MCP row |
| **Add server** | Validates the form, appends one loader row, and the server connects **without restarting dsh** |
| **Test connection** | Re-probes that one server live and re-renders its tools |
| **Remove** | Deletes that one loader row |

Each row shows its transport, connection status, discovered tools with their
parameters, and the failure reason when it cannot connect. Tool names are shown
fully qualified (`mcp__<serverName>__<tool>`), which is exactly how the model
sees them.

## How it works

```
browser half (Settings section)              host half (inside dsh web)
  GET  /mcp-ui  ──────────────────────────►  read cordis.patch.yml
                                             probe each row (MCP handshake)
  POST /mcp-ui  {action, token} ──────────►  validate, edit the file atomically
                                             report the loader id
```

Two facts make it work:

- **The host owns the file.** A browser cannot edit `cordis.patch.yml` or spawn
  an MCP server, so the host half does both and the browser only asks.
- **The loader reloads live.** The profile uses `patchReload: live`, so the
  launcher re-applies the patch list on change. Adding a row composes a real
  mcp-client entry, which connects immediately; removing it disposes the entry.
  No restart, as the end-to-end test demonstrates.

Riding `ctx.webServer` with a per-boot token (injected into the index as
`globalThis.__DSH_MCP_UI__`) rather than the Cordis Remote registry keeps this
small: the Dynamic Cordis surface is the *agent* plugin runtime, built around
approvals and session-scoped records, none of which a settings page wants. GET is
open (it only reads); every POST must echo the token, or it is refused with 403.

### Safety of the config edit

`cordis.patch.yml` is authoritative: a malformed edit would stop dsh from
booting. So the editor:

- **Preserves the file's text.** It carries comments and `!!js` expressions such
  as `process.env.GITHUB_TOKEN`, so it is edited by surgical text surgery, never
  by a parse-and-reserialize round trip. Comments survive an edit; an add
  followed by a remove restores the original document.
- **Validates before and after.** The candidate document is parsed by a strict
  reader that *refuses* anything it does not fully understand — tags, anchors,
  block scalars, flow mappings. A false rejection costs an error message; a false
  acceptance could cost a bootable profile. For the same reason, a row that
  shares a patch block with other entries is refused rather than half-removed.
- **Cannot inject expressions.** Submitted values are validated as literals and
  written as JSON (a YAML subset), so a value like `!!js process.exit(1)` is
  rejected, not executed.
- **Backs up and writes atomically.** Each edit writes a timestamped backup
  (five kept) and renames a temp file into place.

## Lifecycle

Nothing here runs at machine startup. The host half lives inside the `dsh web`
process (per server boot); the browser half lives in the page. A probe spawns one
short-lived process per server and reaps it. Probe results are cached for 30
seconds so an open page does not spawn a process per render; **Test connection**
always probes live.

## Known limitation: orphaned server processes on removal

Removing a row unregisters its tools and takes it out of the tree immediately —
but the spawned server process may survive. This is **not** this plugin's bug and
this plugin cannot fix it: the process belongs to the shipped
`@deepseek-ai/dsh-mcp-client`, and its disposal path does not signal the child
(no close of stdin, no SIGTERM). The end-to-end test observes the leak and prints
it rather than failing, and reclaims the process during teardown.

Practical effect: removing a server stops the model from using its tools right
away, but its process may linger until dsh exits. If that matters to you, kill it
manually or restart dsh. Worth reporting upstream.

## Install / uninstall

Installed into the `web` profile the same way as any out-of-tree plugin: a
profile-local link plus two entries in `$DSH_HOME/profiles/web/package.json`
(the `dependencies` entry, and the package last in `dsh.profile.bundles`).

Restart `dsh web` and reload the page to pick it up. Host-half edits need the
restart; client-half edits also need a page reload.

To remove it: delete the link directory and drop both entries from that
`package.json`. The MCP rows it wrote are ordinary rows — delete them from the
section first, or leave them.

## Tests

```sh
npm test          # patch-store + probe + client harness
node test/mcp-ui.e2e.mjs   # boots a throwaway profile and drives the real API
```

| File | Covers |
|---|---|
| `test/patch-store.test.mjs` | The YAML reader and the config editor: preservation, round-trip, refusal |
| `test/probe.test.mjs` | Tool discovery, unreachable servers, timeouts, read-only probes |
| `test/harness.mjs` | The browser half: the section registration and every UI state |
| `test/mcp-ui.e2e.mjs` | The real thing: boot, empty state, auth, add, tools, remove |
| `test/fake-mcp-server.mjs` | A dependency-free MCP stdio server used by the tests |
| `test/dump-shell.mjs` | Diagnostic: does the boot token reach the served shell? |
| `test/kill-check.mjs` | Diagnostic: is a spawned stdio server reaped by `kill()`? |

Every test runs in a throwaway `$DSH_HOME` under the temp directory and cleans up
after itself; your own profile is never opened.
