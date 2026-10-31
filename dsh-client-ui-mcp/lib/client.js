window.__ModuleLoader__.load({
	id: "@local/dsh-client-ui-mcp",
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
		const css = ".dsh-mcp_root{display:flex;flex-direction:column;gap:14px;font-size:14px}.dsh-mcp_header{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.dsh-mcp_title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:500}.dsh-mcp_path{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-family:var(--dsw-font-mono);overflow-wrap:anywhere}.dsh-mcp_empty{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dsh-mcp_card{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}.dsh-mcp_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-mcp_name{color:var(--dsw-alias-label-primary);font-weight:500}.dsh-mcp_badge{border-radius:5px;padding:0 6px;font-size:11px;line-height:18px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary)}.dsh-mcp_status{border-radius:5px;padding:0 6px;font-size:11px;line-height:18px}.dsh-mcp_ok{background:var(--dsw-alias-state-success-primary);color:#fff}.dsh-mcp_bad{background:var(--dsw-alias-state-error-primary);color:#fff}.dsh-mcp_detail{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:var(--dsw-font-mono);overflow-wrap:anywhere}.dsh-mcp_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}.dsh-mcp_tools{display:flex;flex-direction:column;gap:2px;margin:2px 0 0;padding:0;list-style:none}.dsh-mcp_tool{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}.dsh-mcp_toolName{font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-primary)}.dsh-mcp_actions{display:flex;gap:8px;margin-top:2px}.dsh-mcp_button{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:2px 10px;cursor:pointer}.dsh-mcp_button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-mcp_button:disabled{opacity:.5;cursor:default}.dsh-mcp_danger{color:var(--dsw-alias-state-error-primary)}.dsh-mcp_form{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}.dsh-mcp_field{display:flex;flex-direction:column;gap:4px}.dsh-mcp_label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dsh-mcp_input,.dsh-mcp_select,.dsh-mcp_textarea{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:6px 8px;box-sizing:border-box;width:100%}.dsh-mcp_textarea{min-height:56px;font-family:var(--dsw-font-mono);resize:vertical}.dsh-mcp_hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}.dsh-mcp_foot{display:flex;gap:8px;align-items:center}.dsh-mcp_spacer{flex:1}";
		const tagId = "@local/dsh-client-ui-mcp/McpServers.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-client-ui-mcp";
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
		* composed: the section then reports that instead of silently showing zero
		* servers, because "not installed" and "nothing configured" are different
		* facts and only one of them is worth the user's attention.
		*/
		function channel() {
			const injected = globalThis.__DSH_MCP_UI__;
			if (injected === null || typeof injected !== "object") return undefined;
			const { token, path } = injected;
			if (typeof token !== "string" || token === "" || typeof path !== "string" || !path.startsWith("/")) return undefined;
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
			} catch {
				/* fall through to the status line */
			}
			return `the host answered HTTP ${response.status}`;
		}
		/**
		* Build the API surface.
		* @returns list/add/remove/test, or undefined when the host half is absent.
		*/
		function createApi() {
			const at = channel();
			if (at === undefined || typeof fetch !== "function") return undefined;
			const post = async (body) => {
				const response = await fetch(at.path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						token: at.token,
						...body
					})
				});
				if (!response.ok) throw new Error(await failure(response));
				return response.json();
			};
			return {
				async list() {
					const response = await fetch(at.path, { headers: { accept: "application/json" } });
					if (!response.ok) throw new Error(await failure(response));
					return response.json();
				},
				async add(server) {
					return post({
						action: "add",
						server
					});
				},
				async remove(id) {
					return post({
						action: "remove",
						id
					});
				},
				async test(id) {
					return post({
						action: "test",
						id
					});
				}
			};
		}
		//#endregion
		//#region lib/types/client/McpServers.js
		/** The empty transport draft. */
		const BLANK = {
			serverName: "",
			transport: "stdio",
			command: "",
			args: "",
			env: "",
			url: "",
			headers: ""
		};
		/**
		* Render one server: identity, connection status, its discovered tools, and
		* the row's own actions. A row whose configured values are yaml expressions is
		* shown read-only, because re-serializing it as a literal would destroy the
		* expression the user wrote.
		*/
		function ServerCard({ server, busy, onRemove, onTest }) {
			const statusClass = server.ok ? "dsh-mcp_status dsh-mcp_ok" : "dsh-mcp_status dsh-mcp_bad";
			const detail = server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url;
			return jsx.jsxs("div", {
				className: "dsh-mcp_card",
				children: [
					jsx.jsxs("div", {
						className: "dsh-mcp_row",
						children: [
							jsx.jsx("span", {
								className: "dsh-mcp_name",
								children: server.serverName || server.id
							}),
							jsx.jsx("span", {
								className: "dsh-mcp_badge",
								children: server.transport
							}),
							jsx.jsx("span", {
								className: statusClass,
								children: server.ok ? "connected" : "not connected"
							}),
							server.ok ? jsx.jsx("span", {
								className: "dsh-mcp_badge",
								children: (server.tools ?? []).length === 1 ? "1 tool" : `${(server.tools ?? []).length} tools`
							}) : null,
							server.readOnly ? jsx.jsx("span", {
								className: "dsh-mcp_badge",
								children: "expression"
							}) : null
						]
					}),
					detail ? jsx.jsx("div", {
						className: "dsh-mcp_detail",
						children: detail
					}) : null,
					!server.ok && server.error ? jsx.jsx("div", {
						className: "dsh-mcp_error",
						children: server.error
					}) : null,
					server.ok && (server.tools ?? []).length > 0 ? jsx.jsx("ul", {
						className: "dsh-mcp_tools",
						children: server.tools.map((tool) => jsx.jsxs("li", {
							className: "dsh-mcp_tool",
							children: [
								jsx.jsx("span", {
									className: "dsh-mcp_toolName",
									children: `mcp__${server.serverName}__${tool.name}`
								}),
								tool.parameters !== undefined && tool.parameters.length > 0 ? jsx.jsx("span", {
									children: ` (${tool.parameters.join(", ")})`
								}) : null,
								tool.description ? jsx.jsx("span", {
									children: ` — ${tool.description}`
								}) : null
							]
						}, tool.name))
					}) : null,
					server.ok && (server.tools ?? []).length === 0 ? jsx.jsx("div", {
						className: "dsh-mcp_detail",
						children: "this server advertises no tools"
					}) : null,
					jsx.jsxs("div", {
						className: "dsh-mcp_actions",
						children: [
							jsx.jsx("button", {
								type: "button",
								className: "dsh-mcp_button",
								disabled: busy,
								onClick: () => onTest(server.id),
								children: "Test connection"
							}),
							jsx.jsx("button", {
								type: "button",
								className: "dsh-mcp_button dsh-mcp_danger",
								disabled: busy,
								onClick: () => onRemove(server),
								children: "Remove"
							})
						]
					})
				]
			});
		}
		/** The add form. Fields follow the chosen transport. */
		function AddForm({ busy, error, onCancel, onSubmit }) {
			const [draft, setDraft] = react.useState(BLANK);
			const update = (key) => (event) => setDraft((current) => ({
				...current,
				[key]: event.target.value
			}));
			const stdio = draft.transport === "stdio";
			return jsx.jsxs("form", {
				className: "dsh-mcp_form",
				onSubmit: (event) => {
					event.preventDefault();
					onSubmit({
						serverName: draft.serverName,
						transport: draft.transport,
						command: draft.command.trim(),
						args: draft.args.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
						env: draft.env,
						url: draft.url.trim(),
						headers: draft.headers
					});
				},
				children: [
					jsx.jsxs("div", {
						className: "dsh-mcp_field",
						children: [
							jsx.jsx("label", {
								className: "dsh-mcp_label",
								children: "Server name (becomes the mcp__<name>__ tool prefix)"
							}),
							jsx.jsx("input", {
								className: "dsh-mcp_input",
								value: draft.serverName,
								onChange: update("serverName"),
								placeholder: "github",
								autoComplete: "off"
							}),
							jsx.jsx("span", {
								className: "dsh-mcp_hint",
								children: "1-32 characters: letters, digits, underscore, dash."
							})
						]
					}),
					jsx.jsxs("div", {
						className: "dsh-mcp_field",
						children: [
							jsx.jsx("label", {
								className: "dsh-mcp_label",
								children: "Transport"
							}),
							jsx.jsxs("select", {
								className: "dsh-mcp_select",
								value: draft.transport,
								onChange: update("transport"),
								children: [
									jsx.jsx("option", {
										value: "stdio",
										children: "stdio (a local program)"
									}),
									jsx.jsx("option", {
										value: "streamable-http",
										children: "streamable-http (a service)"
									})
								]
							})
						]
					}),
					stdio ? jsx.jsxs(jsx.Fragment, {
						children: [
							jsx.jsxs("div", {
								className: "dsh-mcp_field",
								children: [
									jsx.jsx("label", {
										className: "dsh-mcp_label",
										children: "Command"
									}),
									jsx.jsx("input", {
										className: "dsh-mcp_input",
										value: draft.command,
										onChange: update("command"),
										placeholder: "npx",
										autoComplete: "off"
									})
								]
							}),
							jsx.jsxs("div", {
								className: "dsh-mcp_field",
								children: [
									jsx.jsx("label", {
										className: "dsh-mcp_label",
										children: "Arguments (one per line)"
									}),
									jsx.jsx("textarea", {
										className: "dsh-mcp_textarea",
										value: draft.args,
										onChange: update("args"),
										placeholder: "-y\n@modelcontextprotocol/server-github"
									})
								]
							}),
							jsx.jsxs("div", {
								className: "dsh-mcp_field",
								children: [
									jsx.jsx("label", {
										className: "dsh-mcp_label",
										children: "Environment (KEY=value, one per line)"
									}),
									jsx.jsx("textarea", {
										className: "dsh-mcp_textarea",
										value: draft.env,
										onChange: update("env"),
										placeholder: "GITHUB_TOKEN=ghp_..."
									}),
									jsx.jsx("span", {
										className: "dsh-mcp_hint",
										children: "Ambient variables whose names look like secrets are scrubbed before the server starts, so anything it needs must be listed here. Stored in plain text in cordis.patch.yml."
									})
								]
							})
						]
					}) : jsx.jsxs(jsx.Fragment, {
						children: [
							jsx.jsxs("div", {
								className: "dsh-mcp_field",
								children: [
									jsx.jsx("label", {
										className: "dsh-mcp_label",
										children: "URL"
									}),
									jsx.jsx("input", {
										className: "dsh-mcp_input",
										value: draft.url,
										onChange: update("url"),
										placeholder: "http://localhost:3000/mcp",
										autoComplete: "off"
									})
								]
							}),
							jsx.jsxs("div", {
								className: "dsh-mcp_field",
								children: [
									jsx.jsx("label", {
										className: "dsh-mcp_label",
										children: "Headers (KEY=value, one per line)"
									}),
									jsx.jsx("textarea", {
										className: "dsh-mcp_textarea",
										value: draft.headers,
										onChange: update("headers"),
										placeholder: "Authorization=Bearer ..."
									})
								]
							})
						]
					}),
					error ? jsx.jsx("div", {
						className: "dsh-mcp_error",
						children: error
					}) : null,
					jsx.jsxs("div", {
						className: "dsh-mcp_foot",
						children: [
							jsx.jsx("button", {
								type: "submit",
								className: "dsh-mcp_button",
								disabled: busy,
								children: busy ? "Adding…" : "Add server"
							}),
							jsx.jsx("button", {
								type: "button",
								className: "dsh-mcp_button",
								disabled: busy,
								onClick: onCancel,
								children: "Cancel"
							}),
							jsx.jsx("span", {
								className: "dsh-mcp_spacer"
							})
						]
					})
				]
			});
		}
		/**
		* The settings section.
		*
		* Loading, failure, empty, and populated are four distinct states, and the
		* empty state says *why* it is empty — because "no servers configured" and
		* "the host half is not composed" look identical if you only count rows.
		*/
		function McpServers() {
			const api = react.useMemo(createApi, []);
			const [state, setState] = react.useState({
				phase: "loading",
				servers: [],
				path: "",
				error: ""
			});
			const [adding, setAdding] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [formError, setFormError] = react.useState("");
			const [notice, setNotice] = react.useState("");
			const load = react.useCallback(async () => {
				if (api === undefined) {
					setState({
						phase: "unavailable",
						servers: [],
						path: "",
						error: ""
					});
					return;
				}
				try {
					const value = await api.list();
					setState({
						phase: "ready",
						servers: Array.isArray(value?.servers) ? value.servers : [],
						path: typeof value?.path === "string" ? value.path : "",
						error: ""
					});
				} catch (error) {
					setState({
						phase: "failed",
						servers: [],
						path: "",
						error: String(error?.message ?? error)
					});
				}
			}, [api]);
			react.useEffect(() => {
				void load();
			}, [load]);
			/** Run one mutation, then re-read so the view reflects the loader's truth. */
			const run = react.useCallback(async (work, success) => {
				if (api === undefined) return;
				setBusy(true);
				setNotice("");
				try {
					const detail = await work(api);
					setNotice(typeof detail === "string" && detail !== "" ? detail : success);
					setFormError("");
					setAdding(false);
				} catch (error) {
					const message = String(error?.message ?? error);
					if (adding) setFormError(message);
					else setNotice(message);
				} finally {
					setBusy(false);
					await load();
				}
			}, [api, load, adding]);
			const header = jsx.jsxs("div", {
				className: "dsh-mcp_header",
				children: [
					jsx.jsx("span", {
						className: "dsh-mcp_title",
						children: "MCP servers"
					}),
					jsx.jsx("button", {
						type: "button",
						className: "dsh-mcp_button",
						disabled: busy || api === undefined,
						onClick: () => {
							setFormError("");
							setAdding((current) => !current);
						},
						children: adding ? "Close" : "Add server"
					})
				]
			});
			const body = [];
			if (state.phase === "loading") body.push(jsx.jsx("div", {
				className: "dsh-mcp_empty",
				children: "Reading cordis.patch.yml…"
			}, "loading"));
			else if (state.phase === "unavailable") body.push(jsx.jsx("div", {
				className: "dsh-mcp_empty",
				children: "The mcp-ui host half is not composed in this profile, so there is nothing to list or edit. Add it to the profile's bundles to manage MCP servers here."
			}, "unavailable"));
			else if (state.phase === "failed") body.push(jsx.jsxs("div", {
				className: "dsh-mcp_empty",
				children: [
					"Could not read the MCP configuration: ",
					state.error
				]
			}, "failed"));
			else if (state.servers.length === 0) body.push(jsx.jsxs("div", {
				className: "dsh-mcp_empty",
				children: [
					"No MCP servers are configured.",
					" ",
					jsx.jsx("strong", {
						children: "Add server"
					}),
					" writes one row to ",
					jsx.jsx("span", {
						className: "dsh-mcp_path",
						children: state.path || "cordis.patch.yml"
					}),
					"; the server connects without restarting this one."
				]
			}, "empty"));
			else for (const server of state.servers) body.push(jsx.jsx(ServerCard, {
				server,
				busy,
				onRemove: (target) => run((client) => client.remove(target.id), `Removed ${target.serverName || target.id}.`),
				onTest: (id) => run(async (client) => {
					const value = await client.test(id);
					const result = value?.result;
					return result?.ok ? "The server answered; the tools below are current." : `The server did not answer: ${result?.error ?? "unknown error"}`;
				}, "The server answered; the tools below are current.")
			}, server.id));
			return jsx.jsxs("div", {
				className: "dsh-mcp_root",
				children: [
					header,
					state.path ? jsx.jsx("div", {
						className: "dsh-mcp_path",
						children: state.path
					}) : null,
					adding ? jsx.jsx(AddForm, {
						busy,
						error: formError,
						onCancel: () => {
							setAdding(false);
							setFormError("");
						},
						onSubmit: (server) => run((client) => client.add(server), `Added ${server.serverName}. It connects now; its tools appear in the model's tool list.`)
					}) : null,
					notice ? jsx.jsx("div", {
						className: "dsh-mcp_detail",
						children: notice
					}) : null,
					...body
				]
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the slot registry this section registers into. */
		const inject = ["slots"];
		/** The Settings navigation label for this section. */
		const SECTION_LABEL = "MCP servers";
		/**
		* Client plugin body: claim a Settings section for MCP servers.
		*
		* The `label` is not decoration. The Settings shell builds its section
		* navigation from `resolveSlotLabel(entry.options.label)`, so a section
		* registered without one is composed and unreachable — present in the tree,
		* absent from the list a person clicks.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mcp-servers",
				order: 60,
				label: () => SECTION_LABEL
			}, McpServers));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
