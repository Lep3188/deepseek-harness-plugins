# deepseek-harness-plugins

Plugins for the **DeepSeek Harness Web GUI** (`dsh web`). One directory per
plugin; each directory is a self-contained package with no build step and no
npm dependencies — only Node's standard library and the modules the host already
shares.

| Plugin | What it does |
| --- | --- |
| [dsh-client-ui-archived](./dsh-client-ui-archived) | Adds a **Settings → Archived** section that counts archived conversations and deletes them from disk for good. |
| [dsh-client-ui-mcp](./dsh-client-ui-mcp) | Adds a **Settings → MCP servers** section: list, add and remove MCP servers, with live connection status and the tools each one advertises. |
| [dsh-client-ui-task-toast](./dsh-client-ui-task-toast) | Native Windows toast notifications (Action Center) when an agent turn finishes, so a long turn can notify you with the browser in the background. Requires Windows PowerShell; nothing renders in the page. |

## What a plugin is

DSH boots a *profile*: an ordered stack of plugin bundles plus your own patch
layer at `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A plugin is a small
package that can contribute up to two halves:

- **host half** — `main` (`lib/index.js`), running inside the `dsh web` process.
  It can register HTTP routes on the GUI's own origin, read the composed
  services, and touch files the GUI cannot.
- **browser half** — `exports["./client"]` (`lib/client.js`) plus
  `dsh.client.platform: "web"`. It is a hand-authored module in the form
  `window.__ModuleLoader__.load({ id, factory })`, `require`-ing the host's own
  shared modules (`react`, `react/jsx-runtime`). The modules service scans the
  loader entries for packages declaring `dsh.client` and serves their bundle
  automatically.

`cordis.patch.yml` in each plugin is that plugin's own row, so the package can
also be installed as a bundle.

## Installing one of these

The web profile's manifest sets `"patchReload": "live"`, so its patch layer is
watched — an edit applies to the running GUI without a restart.

1. **Put the package where the profile can resolve it.** Either pnpm-managed:

   ```powershell
   dsh plugin --profile web add link:<absolute path to the plugin directory>
   ```

   or, without pnpm, a junction/symlink in the profile's `node_modules`:

   ```powershell
   $dst = '<absolute path to the plugin directory>'
   $link = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@local\<package-name>"
   New-Item -ItemType Junction -Path $link -Target $dst
   ```

2. **Insert its row** into `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: <row id from the plugin's README>
         name: '<package name>'
   ```

3. **Verify** using the check in the plugin's own README (each one exposes a
   host route or a Settings section you can confirm).

Uninstalling is the reverse: delete the row, restart, then remove the link.

## Conventions in this repo

- A directory's name is its package name without the scope.
- Every plugin carries `lib/index.js` (host), `lib/client.js` (browser),
  `cordis.patch.yml` (its row), `README.md`, and `test/`.
- No bundler and no dependencies: the browser bundle is written by hand, `require`-ing
  only what the host already shares.
- Tests are plain `node` scripts (`node --test` is not used); anything that
  deletes or writes only ever touches a throwaway temporary directory, never a
  real `$DSH_HOME`. `npm test` inside a plugin directory runs its suite.
- Test scripts that need the `dsh` launcher take it from `DSH_BIN`, defaulting to
  the standard npm global prefix on Windows (`%APPDATA%\npm`).

## License

MIT — see [LICENSE](./LICENSE).
