# Archived conversations — a Settings section that actually frees the space

**Package:** `@local/dsh-client-ui-archived` · **Row id:** `ui-archived` ·
Part of [deepseek-harness-plugins](../README.md)

Archiving a conversation in DSH is a hide flag. `$DSH_HOME/storages/workspace.json`
keeps the id in `archivedSessionIds`, the transcript stays in
`$DSH_HOME/sessions`, and nothing in the harness ever deletes either — there is
no unarchive in the shipped UI and no delete-session API at all. So archived
conversations accumulate silently and invisibly.

This plugin adds the missing page: **Settings → Archived**, showing how many
archived conversations exist, what each one costs on disk, and one red button
that removes them for good.

## What the section shows

- the live count of archived conversations — archive one from a sidebar row's
  menu while the page is open and the number moves
- each conversation's title, its size on disk, and whether it is currently open
  in a window (an open one is never deleted)
- the total space they occupy and the session root on disk
- **Delete all N archived** → **Yes — delete N permanently**, a second click
  because there is no undo
- after deleting: `Deleted 3 archived conversations, freeing 625 KB`

## What deleting removes

Four things per conversation, in this order:

1. its artifact directory under the session root (`sessions/<project>/<id>/`)
2. its projection-cache file (`storages/session_projcache/sessions/<id>.json`)
3. its `sessionIds` slot in the owning workspace record
4. its entry in the registry's `archivedSessionIds`

That order is the safety property. The archive entry is what hides a row, so it
is cleared **last**: an interrupted delete leaves the conversation still
archived and still hidden, never un-hidden with its files gone.

The section then calls `sessions.refresh()`, so deleted rows leave the sidebar
immediately instead of lingering until a reload.

Conversations that are **open in a window are skipped**, never deleted — their
transcript is open for appends. The result line names each one and says why.

### What it does not touch

DSH archives *conversations*, not workspace folders. A workspace whose
conversations are all archived simply has no visible rows left, which reads as
an "archived workspace". This plugin deletes archived conversations only: your
workspace registrations, project directories and attachments are untouched.

## Install

Requires a DSH build whose web profile declares `"patchReload": "live"`
(so the patch layer hot-reloads).

```powershell
# 1. make the package resolvable from the profile — pnpm-managed ...
dsh plugin --profile web add link:C:\path\to\deepseek-harness-plugins\dsh-client-ui-archived

#    ... or, without pnpm, a junction (no admin needed):
$dst  = 'C:\path\to\deepseek-harness-plugins\dsh-client-ui-archived'
$link = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@local\dsh-client-ui-archived"
New-Item -ItemType Junction -Path $link -Target $dst
```

```yaml
# 2. add the row to $DSH_HOME\profiles\web\cordis.patch.yml
- insert:
    - id: ui-archived
      name: '@local/dsh-client-ui-archived'
```

Saving the patch file applies the plugin to the running GUI — no restart. The
row is persistent, so it survives the next boot too.

## Verify

```powershell
curl.exe -s http://127.0.0.1:3080/archived-ui
```

That route is the host half; a JSON body with `items` means it is composed, and
`HTTP 404` means the row did not apply. The section itself is **Settings →
Archived** (the label is required: the Settings shell builds its navigation from
the registered label, and a section without one is composed but unreachable).

## Tests

```powershell
node test/harness.mjs   # host half, 7 cases
node test/client.mjs    # browser half, 6 cases
```

`test/harness.mjs` runs the real route handler against a throwaway temp home —
never a real `$DSH_HOME` — covering sizes, token refusal, transcript and cache
removal, workspace detach, archive-set clearing, the live-session skip, a
path-escaping id, idempotency and a selective purge.

`test/client.mjs` loads the shipped browser bundle under a minimal React stub
(six hooks, explicit render passes) and drives it the way a person would:
count and names, the confirm step, the cancel path, the POST payload, the list
refresh, the success notice, a host error, and the "host half not composed"
state.

## API

```
GET  /archived-ui
  -> { sessionsRoot, totalBytes, items: [{ id, bytes, directories, live }] }

POST /archived-ui   { token, action: 'purge', ids? }
  -> { ok, deleted: [id], skipped: [{ id, reason }], freedBytes }
```

The token is generated per boot, injected into the page as
`window.__DSH_ARCHIVED_UI__`, and required for the POST only. The GET reports
sizes and never mutates; `ids` restricts a purge to a subset.

One purge runs at a time (a concurrent request gets `409`), ids must match
`[A-Za-z0-9._-]+` so a crafted id can never escape the session root, and only
ids present in the archive set can be deleted through the route.

## Notes

- No dependencies, no build step: the browser bundle is hand-authored and
  `require`s only `react` and `react/jsx-runtime` from the host.
- The section is styled with the GUI's own theme alias tokens
  (`--dsw-alias-*`), so it follows light and dark mode.
- Deletion is real and irreversible. That is the point of the page — the same
  disk, minus the bytes.
