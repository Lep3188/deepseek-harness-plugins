window.__ModuleLoader__.load({
	id: "@local/dsh-client-ui-archived",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsx = require("react/jsx-runtime");
		//#region lib/types/client/styles.css
		/**
		* Section styling only. Every class is namespaced and every rule uses the
		* theme alias tokens the rest of the GUI uses, so the page follows the
		* active light/dark palette instead of hard-coding colors.
		*/
		const css = ".dsh-arch_root{display:flex;flex-direction:column;gap:14px;font-size:14px}.dsh-arch_header{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-arch_title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:500}.dsh-arch_count{border-radius:5px;padding:0 6px;font-size:11px;line-height:18px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono)}.dsh-arch_note{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dsh-arch_path{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-family:var(--dsw-font-mono);overflow-wrap:anywhere}.dsh-arch_list{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;margin:0;padding:0;list-style:none;overflow:hidden}.dsh-arch_item{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l2)}.dsh-arch_item:first-child{border-top:0}.dsh-arch_name{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-arch_meta{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-family:var(--dsw-font-mono);flex:none}.dsh-arch_empty{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dsh-arch_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-arch_button{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:4px 12px;cursor:pointer}.dsh-arch_button:disabled{opacity:.5;cursor:default}.dsh-arch_danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}.dsh-arch_danger:not(:disabled):hover{filter:brightness(1.08)}.dsh-arch_warn{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.dsh-arch_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}.dsh-arch_ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}";
		const tagId = "@local/dsh-client-ui-archived/Archived.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-client-ui-archived";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region lib/types/client/api.js
		/**
		* The host API client.
		*
		* The route path and the per-boot token arrive as the global the host half
		* injects into the index. An absent global means the host half is not
		* composed: the section then says so instead of offering a button that
		* could only fail, because "not installed" and "nothing archived" are
		* different facts and only one of them is worth the user's attention.
		*/
		function channel() {
			const injected = globalThis.__DSH_ARCHIVED_UI__;
			if (injected === null || typeof injected !== "object") return void 0;
			const { token, path } = injected;
			if (typeof token !== "string" || token === "" || typeof path !== "string" || !path.startsWith("/")) return void 0;
			return {
				token,
				path
			};
		}
		/** Read the error message out of a response, falling back to the status. */
		async function failure(response) {
			try {
				const body = await response.json();
				if (typeof body?.error === "string" && body.error !== "") return body.error;
			} catch {}
			return `the host answered HTTP ${response.status}`;
		}
		/**
		* Build the API surface.
		* @returns list/purge, or undefined when the host half is absent.
		*/
		function createApi() {
			const at = channel();
			if (at === void 0 || typeof fetch !== "function") return void 0;
			return {
				async list() {
					const response = await fetch(at.path, { headers: { accept: "application/json" } });
					if (!response.ok) throw new Error(await failure(response));
					return response.json();
				},
				async purge(ids) {
					const response = await fetch(at.path, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							token: at.token,
							action: "purge",
							...ids === void 0 ? {} : { ids }
						})
					});
					if (!response.ok) throw new Error(await failure(response));
					return response.json();
				}
			};
		}
		//#endregion
		//#region lib/types/client/format.js
		/** A short human byte count; an empty string for nothing worth reporting. */
		function formatBytes(bytes) {
			if (!(bytes > 0)) return "";
			const units = ["B", "KB", "MB", "GB"];
			let value = bytes;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
		}
		//#endregion
		//#region lib/types/client/Archived.js
		/**
		* Stable selectors for `useSyncExternalStore`: a selector that built a new
		* array on every read would loop forever, so each one returns a value the
		* store already holds by reference.
		*/
		const selectArchived = (state) => state.archivedSessionIds;
		const selectById = (state) => state.byId;
		/**
		* Subscribe one store read to a client service's snapshot store.
		* @param store - the client service (`sessions` or `workspaces`), if composed.
		* @param select - stable selector.
		* @returns the selected snapshot value.
		*/
		function useSnapshot(store, select) {
			const subscribe = react.useCallback((notify) => {
				const list = store?.list;
				return list === void 0 ? () => {} : list.subscribe(notify);
			}, [store]);
			const read = react.useCallback(() => {
				const list = store?.list;
				return list === void 0 ? void 0 : select(list.getSnapshot());
			}, [store, select]);
			return react.useSyncExternalStore(subscribe, read);
		}
		/**
		* The settings section.
		*
		* The count and the names are read from the GUI's own mirrors, so the
		* section is correct the instant it opens and follows an archive taken in
		* the sidebar without a reload. The host is asked only for sizes, and for
		* the delete itself — the one thing the browser cannot do.
		*
		* Deleting is a two-step button instead of a modal: the section already
		* names every conversation that will go, so the confirmation adds the one
		* fact the list cannot show — that it is permanent.
		*/
		function ArchivedConversations({ stores }) {
			const api = react.useMemo(createApi, []);
			const sessions = stores?.sessions;
			const workspaces = stores?.workspaces;
			const archived = useSnapshot(workspaces, selectArchived);
			const byId = useSnapshot(sessions, selectById);
			const [remote, setRemote] = react.useState(void 0);
			const [phase, setPhase] = react.useState("idle");
			const [notice, setNotice] = react.useState({ kind: "", text: "" });
			const ids = Array.isArray(archived) ? archived : [];
			const count = ids.length;
			const key = ids.join("\n");
			react.useEffect(() => {
				if (api === void 0) return void 0;
				let live = true;
				api.list().then((value) => {
					if (!live) return;
					const map = {};
					for (const item of value?.items ?? []) map[item.id] = item;
					setRemote({
						byId: map,
						totalBytes: typeof value?.totalBytes === "number" ? value.totalBytes : 0,
						sessionsRoot: typeof value?.sessionsRoot === "string" ? value.sessionsRoot : ""
					});
				}, () => {
					// A failed size report must not turn the section into an error
					// page: the count is still true and the delete still works.
					if (live) setRemote(void 0);
				});
				return () => {
					live = false;
				};
			}, [api, key]);
			const run = react.useCallback(async () => {
				if (api === void 0) return;
				setPhase("busy");
				setNotice({
					kind: "",
					text: ""
				});
				try {
					const value = await api.purge();
					const deleted = Array.isArray(value?.deleted) ? value.deleted : [];
					const skipped = Array.isArray(value?.skipped) ? value.skipped : [];
					const freed = formatBytes(value?.freedBytes ?? 0);
					let text = deleted.length === 0 ? "Nothing was deleted." : `Deleted ${deleted.length} archived ${deleted.length === 1 ? "conversation" : "conversations"}${freed === "" ? "" : `, freeing ${freed}`}.`;
					if (skipped.length > 0) text += ` Skipped ${skipped.length}: ${skipped.map((item) => `${item.id} (${item.reason})`).join("; ")}.`;
					setNotice({
						kind: deleted.length === 0 ? "error" : "ok",
						text
					});
					// The deleted ids are no longer archived, so the sidebar would show
					// them as rows until the list is re-pulled. Pull it now.
					try {
						await sessions?.refresh?.();
					} catch {}
				} catch (error) {
					setNotice({
						kind: "error",
						text: String(error?.message ?? error)
					});
				} finally {
					setPhase("idle");
				}
			}, [api, sessions]);
			const header = jsx.jsxs("div", {
				className: "dsh-arch_header",
				children: [jsx.jsx("span", {
					className: "dsh-arch_title",
					children: "Archived conversations"
				}), jsx.jsx("span", {
					className: "dsh-arch_count",
					children: count === 1 ? "1 archived" : `${count} archived`
				})]
			});
			const body = [];
			if (api === void 0) body.push(jsx.jsx("div", {
				className: "dsh-arch_empty",
				children: "The archived-ui host half is not composed in this profile, so there is nothing to count or delete. Add its insert row to the profile's cordis.patch.yml."
			}, "unavailable"));
			else if (workspaces === void 0 || sessions === void 0) body.push(jsx.jsx("div", {
				className: "dsh-arch_empty",
				children: "The session and workspace lists are not available in this window, so the archive set cannot be read here."
			}, "nolists"));
			else if (count === 0) body.push(jsx.jsx("div", {
				className: "dsh-arch_empty",
				children: "No archived conversations. Archive one from a sidebar row's menu and the count here updates immediately."
			}, "empty"));
			else {
				body.push(jsx.jsx("ul", {
					className: "dsh-arch_list",
					children: ids.map((id) => {
						const summary = byId?.[id];
						const size = remote?.byId?.[id]?.bytes;
						const open = remote?.byId?.[id]?.live === true;
						const meta = [size === void 0 ? "" : formatBytes(size), open ? "open" : ""].filter((part) => part !== "").join(" · ");
						return jsx.jsxs("li", {
							className: "dsh-arch_item",
							children: [jsx.jsx("span", {
								className: "dsh-arch_name",
								title: summary?.cwd ?? id,
								children: summary?.displayTitle ?? id
							}), jsx.jsx("span", {
								className: "dsh-arch_meta",
								children: meta
							})]
						}, id);
					})
				}, "list"));
				const total = remote?.totalBytes ?? 0;
				body.push(jsx.jsxs("div", {
					className: "dsh-arch_note",
					children: [
						"Archived conversations stay on this machine, hidden from the sidebar until something deletes them.",
						total > 0 ? ` These occupy ${formatBytes(total)}.` : ""
					]
				}, "note"));
				if (remote?.sessionsRoot) body.push(jsx.jsx("div", {
					className: "dsh-arch_path",
					children: remote.sessionsRoot
				}, "path"));
				body.push(jsx.jsxs("div", {
					className: "dsh-arch_actions",
					children: [jsx.jsx("button", {
						type: "button",
						className: "dsh-arch_button dsh-arch_danger",
						disabled: phase === "busy",
						onClick: () => {
							if (phase === "confirm") void run();
							else {
								setNotice({
									kind: "",
									text: ""
								});
								setPhase("confirm");
							}
						},
						children: phase === "busy" ? "Deleting…" : phase === "confirm" ? `Yes — delete ${count} permanently` : `Delete all ${count} archived`
					}), phase === "confirm" ? jsx.jsx("button", {
						type: "button",
						className: "dsh-arch_button",
						onClick: () => setPhase("idle"),
						children: "Cancel"
					}) : null]
				}, "actions"));
				if (phase === "confirm") body.push(jsx.jsx("div", {
					className: "dsh-arch_warn",
					children: `This removes their transcript files from ${remote?.sessionsRoot || "the session folder"}. It cannot be undone.`
				}, "warn"));
			}
			if (notice.text !== "") body.push(jsx.jsx("div", {
				className: notice.kind === "error" ? "dsh-arch_error" : "dsh-arch_ok",
				children: notice.text
			}, "notice"));
			return jsx.jsxs("div", {
				className: "dsh-arch_root",
				children: [header, ...body]
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the slot registry plus the two mirrors this section reads. */
		const inject = ["slots", "sessions", "workspaces"];
		/** The Settings navigation label for this section. */
		const SECTION_LABEL = "Archived";
		/**
		* Client plugin body: claim a Settings section that counts and deletes
		* archived conversations.
		*
		* The `label` is not decoration: the Settings shell builds its section
		* navigation from it, so a section registered without one is composed and
		* unreachable — present in the tree, absent from the list a person clicks.
		*
		* The services are resolved here rather than inside the component so the
		* component stays a pure function of its props, and a missing service
		* surfaces as one honest message instead of a render crash.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const stores = {
				sessions: ctx.get("sessions"),
				workspaces: ctx.get("workspaces")
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archived",
				order: 61,
				label: () => SECTION_LABEL
			}, () => jsx.jsx(ArchivedConversations, { stores })));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
