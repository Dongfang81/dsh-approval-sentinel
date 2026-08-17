// client.js — browser half of dsh-approval-sentinel: a settings card for the
// `approval-sentinel` namespace, shown under Settings → 插件 → 可配置.
//
// Hand-written in the browser module format (`window.__ModuleLoader__.load`),
// matching the compiled client-plugin convention; the host serves this file at
// /plugins/approval-sentinel/client.js and the browser loads it at runtime —
// no web-bundle rebuild needed. Fields write immediately through the settings
// scope (`set`/`unset`), the same transport the built-in cards use.

window.__ModuleLoader__.load({
	id: "approval-sentinel",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
		const react = require("react");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

		/** Settings namespace owned by the host plugin. */
		const NS = "approval-sentinel";

		/**
		 * Field catalog rendered by the card. `type`:
		 *   boolean → checkbox (set true/false on toggle)
		 *   number  → number input (commit on blur; empty = unset)
		 *   string  → text input (commit on blur; empty = unset)
		 *   json    → textarea (commit on blur after JSON.parse; invalid = blocked)
		 */
		const FIELDS = [
			{ group: "general", field: "enabled", type: "boolean", label: "总开关", hint: "false 时所有审批按原样转交人工" },
			{ group: "general", field: "graceMs", type: "number", label: "人工宽限期 (ms)", hint: "默认 120000（120 秒）" },
			{ group: "general", field: "headlessGraceMs", type: "number", label: "Headless 额外等待 (ms)", hint: "无人工通道时审查前的等待" },
			{ group: "general", field: "assessTimeoutMs", type: "number", label: "评审超时 (ms)", hint: "单次评审 agent 的截止时间" },
			{ group: "general", field: "maxConcurrentAssessments", type: "number", label: "并发评审上限", hint: "超出排队" },
			{ group: "general", field: "assessorModel", type: "string", label: "评审模型", hint: "留空继承请求 agent 的模型" },
			{ group: "general", field: "assessorProvider", type: "string", label: "评审 Provider", hint: "留空继承请求 agent 的 Provider" },
			{ group: "rules", field: "allowRules", type: "json", label: "始终允许规则 (JSON 数组)", hint: "[{tool,mode,pattern,note,enabled}] 命中即直接放行" },
			{ group: "rules", field: "denyPatterns", type: "json", label: "拒绝正则 (JSON 数组)", hint: "命中转交你本人决定，不自动拒绝" },
			{ group: "rules", field: "allowPatterns", type: "json", label: "放行正则 (JSON 数组)", hint: "确定性放行" },
			{ group: "notify", field: "notifyUser", type: "boolean", label: "会话内决策通知", hint: "自动决定时向会话注入可见消息" },
			{ group: "notify", field: "notifyTurnComplete", type: "boolean", label: "轮次完成通知", hint: "agent 完成一轮时发系统通知" },
			{ group: "notify", field: "notifyPermissionRequest", type: "boolean", label: "权限审批通知", hint: "有待审批请求时发系统通知" },
			{ group: "notify", field: "notifyQuestion", type: "boolean", label: "提问通知", hint: "agent 需要你输入时发系统通知" },
			{ group: "notify", field: "notifyMinIntervalMs", type: "number", label: "通知最小间隔 (ms)", hint: "同一会话同类通知防刷屏" },
			{ group: "notify", field: "notifyBackend", type: "string", label: "通知后端", hint: "auto / osascript / terminal-notifier" },
			{ group: "notify", field: "notifySound", type: "boolean", label: "通知提示音", hint: "通知附带默认提示音" },
			{ group: "general", field: "verbose", type: "boolean", label: "详细日志", hint: "额外 info 级日志" }
		];

		const GROUP_LABELS = {
			general: "基本",
			rules: "审批规则",
			notify: "系统通知"
		};

		/** Bridges the approval-sentinel scope onto a snapshot store + actions. */
		class SentinelCardController {
			constructor(scope) {
				this.scope = scope;
				this.store = createSnapshotStore(() => this.projection());
				scope.subscribe(() => this.publish());
				this.publish();
			}
			projection() {
				const snapshot = this.scope.getSnapshot();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					value: snapshot.value ?? {},
					base: snapshot.base ?? {}
				};
			}
			publish() {
				this.store.set(this.projection());
			}
			inject() {
				return {
					hooks: { sentinelCard: this.store },
					set: (field, value) => this.scope.set(field, value),
					unset: (field) => this.scope.unset(field)
				};
			}
		}

		/** A boolean toggle committing on change. */
		function ToggleField({ label, hint, checked, disabled, onChange, onReset }) {
			return jsxs("label", {
				style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-2, rgba(128,128,128,.15))" },
				children: [
					jsxs("span", {
						style: { display: "flex", flexDirection: "column", gap: 2 },
						children: [
							jsx("span", { style: { fontSize: 14, color: "var(--dsw-alias-label-primary, #222)" }, children: label }),
							hint ? jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)" }, children: hint }) : null
						]
					}),
					jsxs("span", {
						style: { display: "flex", alignItems: "center", gap: 8 },
						children: [
							jsx("input", {
								type: "checkbox",
								checked: Boolean(checked),
								disabled,
								onChange: (event) => onChange(event.target.checked)
							}),
							jsx("button", {
								type: "button",
								title: "恢复默认",
								disabled: disabled || !checked,
								onClick: onReset,
								style: { background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 12 },
								children: "重置"
							})
						]
					})
				]
			});
		}

		/** A committed-on-blur text control (number / string / json). */
		function TextField({ label, hint, type, initial, disabled, onCommit, onReset }) {
			const [draft, setDraft] = react.useState(initial);
			const [invalid, setInvalid] = react.useState(false);
			react.useEffect(() => {
				setDraft(initial);
				setInvalid(false);
			}, [initial]);
			const commit = () => {
				if (type === "json") {
					if (draft.trim() === "") {
						onReset();
						setInvalid(false);
						return;
					}
					try {
						JSON.parse(draft);
						setInvalid(false);
						onCommit(JSON.parse(draft));
					} catch {
						setInvalid(true);
					}
					return;
				}
				const trimmed = draft.trim();
				if (trimmed === "") {
					onReset();
					return;
				}
				if (type === "number") {
					const parsed = Number(trimmed);
					if (!Number.isFinite(parsed)) {
						setInvalid(true);
						return;
					}
					onCommit(parsed);
				} else {
					onCommit(trimmed);
				}
			};
			const common = {
				style: {
					width: 220,
					padding: "5px 8px",
					fontSize: 13,
					fontFamily: type === "json" ? "ui-monospace, monospace" : "inherit",
					border: invalid ? "1px solid #e5484d" : "1px solid var(--dsw-alias-border-2, rgba(128,128,128,.35))",
					borderRadius: 8,
					background: "var(--dsw-alias-bg-input, transparent)",
					color: "var(--dsw-alias-label-primary, #222)"
				},
				disabled,
				value: draft,
				onChange: (event) => {
					setDraft(event.target.value);
					setInvalid(false);
				},
				onBlur: commit,
				onKeyDown: (event) => {
					if (event.key === "Enter") commit();
				}
			};
			return jsxs("label", {
				style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-2, rgba(128,128,128,.15))" },
				children: [
					jsxs("span", {
						style: { display: "flex", flexDirection: "column", gap: 2 },
						children: [
							jsx("span", { style: { fontSize: 14, color: "var(--dsw-alias-label-primary, #222)" }, children: label }),
							hint ? jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)" }, children: hint }) : null,
							invalid ? jsx("span", { style: { fontSize: 12, color: "#e5484d" }, children: "格式无效，未保存" }) : null
						]
					}),
					jsxs("span", {
						style: { display: "flex", alignItems: "center", gap: 8 },
						children: [
							jsx(type === "json" ? "textarea" : "input", {
								...(type === "json" ? { rows: 4 } : { type: type === "number" ? "number" : "text" }),
								...common
							}),
							jsx("button", {
								type: "button",
								title: "恢复默认",
								disabled: disabled || draft.trim() === "",
								onClick: onReset,
								style: { background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 12 },
								children: "重置"
							})
						]
					})
				]
			});
		}

		/** Render one plugin card: header + grouped fields. */
		function SentinelCard(props) {
			const state = props.useSentinelCard((snapshot) => snapshot);
			const [open, setOpen] = react.useState(false);
			if (!state.available) return null;
			const disabled = !state.writable;
			const value = state.value;
			const groups = [];
			for (const def of FIELDS) {
				const fieldValue = value[def.field];
				let last = groups[groups.length - 1];
				if (last === void 0 || last.group !== def.group) {
					last = { group: def.group, defs: [] };
					groups.push(last);
				}
				last.defs.push(def);
			}
			const reset = (field) => props.unset(field);
			return jsxs("li", {
				style: { border: "1px solid var(--dsw-alias-border-2, rgba(128,128,128,.25))", borderRadius: 14, marginBottom: 12, background: "var(--dsw-alias-bg-layer-1, transparent)" },
				children: [
					jsx("button", {
						type: "button",
						style: { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "12px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" },
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						children: jsxs("span", {
							children: [
								jsx("span", { style: { display: "block", fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" }, children: "帮我批准 (approval-sentinel)" }),
								jsx("span", { style: { display: "block", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", marginTop: 2 }, children: "审批超时风险评估、始终允许规则、系统通知" })
							]
						})
					}),
					open ? jsxs("div", {
						style: { padding: "4px 16px 14px" },
						children: [
							!state.writable ? jsx("p", { style: { color: "#e5484d", fontSize: 13, margin: "4px 0 8px" }, children: "当前为只读（设置不可写）" }) : null,
							groups.map((group) => jsxs("div", {
								key: group.group,
								children: [
									jsx("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #666)", margin: "10px 0 2px" }, children: GROUP_LABELS[group.group] ?? group.group }),
									group.defs.map((def) => {
										const fieldValue = value[def.field];
										if (def.type === "boolean") {
											return jsx(ToggleField, {
												key: def.field,
												label: def.label,
												hint: def.hint,
												checked: Boolean(fieldValue),
												disabled,
												onChange: (next) => props.set(def.field, next),
												onReset: () => reset(def.field)
											});
										}
										return jsx(TextField, {
											key: def.field,
											label: def.label,
											hint: def.hint,
											type: def.type,
											initial: def.type === "json"
												? JSON.stringify(fieldValue ?? (def.field === "allowRules" || def.field === "allowPatterns" || def.field === "denyPatterns" ? [] : null), null, 2)
												: String(fieldValue ?? ""),
											disabled,
											onCommit: (next) => props.set(def.field, next),
											onReset: () => reset(def.field)
										});
									})
								]
							}))
						]
					}) : null
				]
			});
		}

		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"settingsScope"
		];

		/** Mount the settings card bound to the approval-sentinel namespace. */
		function apply(ctx) {
			ctx.effect(() => {
				const scope = ctx.settingsScope.bind({ namespace: NS });
				const controller = new SentinelCardController(scope);
				return ctx.slots.register({
					name: "settings.plugin.item",
					id: "approval-sentinel",
					order: 25,
					locale: NS,
					inject: () => controller.inject()
				}, SentinelCard);
			}, "approval-sentinel: settings card");
		}

		module.exports = { apply, inject };
		return module.exports;
	}
});
