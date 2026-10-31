window.__ModuleLoader__.load({
	id: "@local/dsh-client-ui-task-toast",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		* Test seam. The bundle is hand-authored, so a bundler cannot inject this:
		* the Node harness sets `globalThis.__DSH_TASK_TOAST_TEST__` before
		* materializing the module to freeze the clock and assert elapsed labels
		* exactly. In the browser the global is absent and the real clock is used.
		*
		* `__DSH_TASK_TOAST__` (without the suffix) is a different thing entirely:
		* the host's own boot-token injection, read at turn end.
		*/
		const testOverrides = globalThis.__DSH_TASK_TOAST_TEST__ ?? {};
		const now = testOverrides.now ?? Date.now;
		//#region lib/types/client/desktop.js
		/**
		* Desktop channel: hand each finished turn to the host, which owns the
		* Windows toast.
		*
		* The browser cannot raise a system notification, so this bundle renders
		* nothing and owns no DOM. It watches the Session list and posts; the host
		* half owns the route, the app identity, and the toast itself. There is no
		* in-page surface left in this plugin: on Windows the toast covers the other
		* monitor, which is the case that mattered.
		*
		* The route path and boot token arrive as the global the host half injects
		* into the index, so an absent global means no host half is wired and every
		* call is a no-op. Delivery is fire-and-forget but not silent: a failure
		* warns once per boot, because with no in-page fallback a broken route would
		* otherwise look exactly like "no turns finished".
		*/
		/**
		* Read the injected channel description.
		* @returns the token and path, or undefined when the host half is absent.
		*/
		function desktopChannel() {
			const injected = globalThis.__DSH_TASK_TOAST__;
			if (injected === null || typeof injected !== "object") return void 0;
			const { token, path } = injected;
			if (typeof token !== "string" || token === "" || typeof path !== "string" || !path.startsWith("/")) return void 0;
			return {
				token,
				path
			};
		}
		/**
		* Build the desktop notifier.
		*
		* The POST carries no credentials: the token in the body is the whole
		* authorization story, and the host rejects anything else with 403.
		* @returns a function that reports one finished turn, or a no-op without a channel.
		*/
		function createDesktopNotifier() {
			const channel = desktopChannel();
			if (channel === void 0 || typeof fetch !== "function") return () => {};
			let warned = false;
			return (title, meta) => {
				fetch(channel.path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						token: channel.token,
						title,
						meta
					})
				}).then((response) => {
					if (response.ok || warned) return;
					warned = true;
					console.warn(`task-toast: the host refused the notification (HTTP ${response.status}); desktop alerts are not being delivered`);
				}, (error) => {
					if (warned) return;
					warned = true;
					console.warn("task-toast: the host notification route is unreachable; desktop alerts are not being delivered", error);
				});
			};
		}
		//#endregion
		//#region lib/types/client/format.js
		/**
		* Elapsed time in at most two adjacent units. A background-free turn is
		* almost always minutes at most, so hours is the widest unit and the figure
		* stays in hours beyond that rather than growing a day vocabulary.
		* @param elapsedMs - milliseconds the finished turn took.
		* @returns the short elapsed label the toast body carries.
		*/
		function formatElapsed(elapsedMs) {
			if (!(elapsedMs > 0)) return "just now";
			const total = Math.floor(elapsedMs / 1e3);
			if (total < 60) return `${total}s`;
			const seconds = total % 60;
			const minutes = Math.floor(total / 60) % 60;
			const hours = Math.floor(total / 3600);
			if (hours > 0) return `${hours}h ${minutes}m`;
			return `${minutes}m ${seconds}s`;
		}
		//#endregion
		//#region lib/types/client/watcher.js
		/**
		* Turn-finished watcher: one notification per Session whose Agent stops
		* running — the observable meaning of "the answer/turn finished".
		*
		* The signal is the Session-list mirror the GUI already maintains, so this
		* plugin issues no session RPC and subscribes to no wire frames of its own.
		* A Session absent from `seen` has never been observed, so its first
		* appearance only records the state: a page load that lands mid-turn still
		* reports the end of that turn instead of treating it as news, and a
		* reconnect cannot replay one.
		*
		* Scope is the Session the user is looking at. The sidebar's own "done"
		* marker already reports background Sessions, and a desktop toast for every
		* background Session would be noise.
		* @param notify - receives each finished turn.
		* @returns the reconcile function to run on every list change.
		*/
		function createWatcher(notify) {
			/** Session id -> the running bit and start time this plugin last observed. */
			const seen = /* @__PURE__ */ new Map();
			return (state) => {
				const current = state.current;
				for (const [id, previous] of seen) {
					const summary = state.byId[id];
					if (summary === undefined || summary.removed === true) {
						seen.delete(id);
						continue;
					}
					if (summary.running) {
						previous.running = true;
						continue;
					}
					if (!previous.running) continue;
					seen.delete(id);
					if (id !== current) continue;
					notify(summary.displayTitle || "Session", formatElapsed(now() - previous.startedAt));
				}
				for (const id of state.ids) {
					if (seen.has(id)) continue;
					const summary = state.byId[id];
					if (summary === undefined || summary.removed === true) continue;
					seen.set(id, {
						running: summary.running,
						startedAt: summary.updatedAt
					});
				}
			};
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the Session-list mirror this plugin observes. */
		const inject = ["sessions"];
		/**
		* Client plugin body: subscribe the desktop notifier to the Session list.
		*
		* The subscription is one `ctx.effect`, so plugin teardown unsubscribes and
		* nothing of this plugin survives. The notifier is stateless beyond the
		* injected token, so teardown owes it nothing.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const notify = createDesktopNotifier();
			ctx.effect(() => {
				const reconcile = createWatcher(notify);
				const unsubscribe = ctx.sessions.list.subscribe(() => {
					reconcile(ctx.sessions.list.getSnapshot());
				});
				return () => {
					unsubscribe();
				};
			}, "ui-task-toast: session list subscription");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		/**
		* Test seam. The bundle is hand-authored, so a bundler cannot inject this:
		* the Node harness reads it to drive the internal reconcile directly with a
		* frozen clock and no browser at all. The browser never reads this export.
		*/
		exports.__internals = {
			createWatcher,
			formatElapsed,
			now
		};
		return module.exports;
	}
});
