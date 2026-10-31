# @local/dsh-client-ui-task-toast

**Package:** `@local/dsh-client-ui-task-toast` · **Row id:** `ui-task-toast` ·
Part of [deepseek-harness-plugins](../README.md)

**Native Windows notifications** when the DeepSeek Harness Web GUI finishes an
agent turn. One toast per finished turn, in the Action Center, visible on any
screen even when the GUI is not in front.

```
┌──────────────────────────────┐
│ chat my-project              │   ← the session's display title
│ 1m 4s                        │   ← how long the turn took
└──────────────────────────────┘
```

There is no in-page notification: the toast replaces it. The browser half renders
nothing at all — no DOM, no CSS, no elements — so a finished turn produces
exactly one surface, the system one.

## What counts as "a task finished"

One notification per **agent turn that ends in the session you are looking at**
(`running: true → false` on the Session list row). That covers both a normal
answer and a stopped/cancelled turn, because the visible signal is the agent
leaving its running state.

Deliberately out of scope:

- **Background sessions** — a session finishing while you are looking at another
  one stays silent; the sidebar's own "done" marker already reports it.
- **Background jobs** (`pwsh`, subagents, terminal) — the session-header job list
  owns those. Add them later by also reconciling `state.jobsBySession`.
- **Individual tool calls** — that would notify several times per turn.

## Why there is a host half

A browser cannot raise a Windows notification. Windows also drops a toast
silently unless the sending process carries a registered application identity.
So the browser's only job is to notice the turn and POST:

```
browser half                                host half (inside dsh web)
  turn ends ──► POST /task-toast ─────────► verify token
               {token, title, meta}         ensure app identity (once, at boot)
                                            powershell.exe show-toast.ps1
                                                     │
                                                     ▼
                                            Windows Action Center
```

Three host facts make it work:

- **Route.** `ctx.webServer.register` claims the exact path `/task-toast` on the
  GUI's own server, so the page reaches it same-origin with no port or CORS work.
- **App identity.** `scripts/ensure-shortcut.ps1` installs a Start Menu shortcut
  (`DeepSeek Harness`, targeting `dsh.cmd web`) whose `System.AppUserModel.ID` is
  `DeepSeek.Harness.Toast`. That is the documented route for a non-packaged
  desktop app to earn a toast identity. It runs once at server boot and is
  idempotent afterwards.
- **Token.** The server binds loopback but enforces no origin policy of its own,
  so the host injects a random per-boot token into the index HTML
  (`globalThis.__DSH_TASK_TOAST__`) and requires it on every POST. Without it,
  any local page could push notifications onto the desktop. A missing or wrong
  token is answered `403`.

Payload text reaches PowerShell base64-encoded as UTF-8 and is passed with
`-File`, never `-Command`, so a session title containing quotes or PowerShell
metacharacters is inert. Each call is hard-capped at 15s.

## Lifecycle

Nothing here starts with the machine. There is no service, no startup entry, and
no scheduled task; while DSH is closed, none of this exists.

| Piece | When it runs |
|---|---|
| Host half | Inside the `dsh web` process, per server boot. Registers the route, injects the token, installs the identity once. |
| Browser half | In the GUI page, per page load. Notices finished turns and POSTs. |
| Toast sender | A short-lived `powershell.exe` child, ~300 ms per finished turn, then gone. |
| Start Menu shortcut | A 2 KB `.lnk` file. Never executes; Windows reads its identity when a toast needs one. It also doubles as a `dsh web` launcher. |

**The browser tab must be open for a toast to fire**, because turn detection
lives there. Closing the GUI window stops notifications even though the server
keeps running.

## Failure behavior

With no in-page fallback, a missing toast would otherwise look identical to "no
turns finished", so both halves report:

- **Browser console**, once per page: `task-toast: the host refused the
  notification (HTTP …)` or `… the route is unreachable`.
- **Host log**, once per distinct cause: `task-toast: <cause> — <detail>`.

| Response | Meaning |
|---|---|
| `200 {ok:true}` | Toast handed to Windows |
| `400` | Bad JSON, or an empty title |
| `403` | Missing or wrong boot token |
| `405` | Not a POST |
| `413` | Body over 8 KiB |
| `502` | PowerShell ran but the toast failed |
| `503` | No app identity, or not a Windows host |

Quick check from a shell, using the token from the page source:

```powershell
$boot = '<token from window.__DSH_TASK_TOAST__ in the served index>'
Invoke-WebRequest -Uri 'http://127.0.0.1:3080/task-toast' -Method POST `
  -ContentType 'application/json' `
  -Body (@{ token = $boot; title = 'probe'; meta = 'manual' } | ConvertTo-Json -Compress)
```

## Files

| File | Role |
|---|---|
| `package.json` | Declares `dsh.bundle.patch` (a profile layer) and `dsh.client.platform: web` (a browser bundle) |
| `cordis.patch.yml` | The bundle's patch: one `insert` row |
| `lib/index.js` | Host half — route, boot token, identity install, toast subprocess |
| `lib/client.js` | Browser half — watches the Session list, POSTs; renders nothing |
| `scripts/show-toast.ps1` | Sends one toast under the AppUserModelID |
| `scripts/ensure-shortcut.ps1` | Installs/repairs the Start Menu identity shortcut |
| `test/harness.mjs` | Headless checks for the bundle and the delivery contract |
| `test/probe-aumid.ps1` | Manual probe for the AUMID mechanism on a new machine |

The browser half is a hand-authored `window.__ModuleLoader__.load({ id, factory })`
bundle, exactly the shape a `tsdown` build emits — baseline `require` only, no
externals. It observes `ctx.sessions.list`, the Session-list snapshot the GUI
already maintains, so it issues no session RPC and subscribes to no wire frames
of its own.

## Install / uninstall

Installed into the `web` profile by hand (pnpm was not on `PATH`), which is
exactly what `dsh plugin --profile web add <path>` would do:

1. A profile-local link:
   `$DSH_HOME/profiles/web/node_modules/@local/dsh-client-ui-task-toast` →
   this directory.
2. Two entries in `$DSH_HOME/profiles/web/package.json`: the `dependencies`
   entry, and `@local/dsh-client-ui-task-toast` last in `dsh.profile.bundles`.
3. One Start Menu shortcut, `DeepSeek Harness`, created at first boot and
   carrying the notification identity.

Because the link is live, editing `lib/client.js` or `lib/index.js` here changes
what the next server boot serves — no reinstall. Host-half edits need a server
restart; client-half edits also need a page reload (or `pnpm run dev:web` running
so client-HMR reloads the bundle).

To remove it: delete the link directory, drop both entries from that
`package.json`, and delete the `DeepSeek Harness` Start Menu shortcut.

## Tests

```sh
node test/harness.mjs
```

Covers the bundle contract (`inject`, `apply`, and that it touches no DOM),
idle/running transitions, the elapsed label, background-session silence, a page
load that lands mid-turn, the POST shape (route, JSON, token echo), inertness
without the injection, the once-per-page delivery warning, and teardown.
