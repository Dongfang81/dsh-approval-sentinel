// core.js — pure decision engine for dsh-approval-sentinel (帮我批准).
//
// No cordis / harness imports here on purpose: the whole approval policy is a
// set of pure functions plus one async flow, so the tests in tests/ can drive
// it with a fake `next()` chain and a fake assessor. The cordis adapter in
// index.js only wires these into `approval/request` and `ctx.subagents`.
//
// POLICY (the user's spec):
//   - the subagent reviews the risk;
//   - verdict "allow"  → auto-approve (allowed-once);
//   - anything else (reject / wait / assessor error) → NEVER auto-decide:
//     hand the request back to the human and keep waiting until THEY act
//     (the approval dialog stays open). Only when there is NO human channel
//     at all (headless) does a non-allow collapse to a fail-closed denial.

/** Every verdict the risk assessor may return. */
export const VERDICTS = ["allow", "reject", "wait"];

/**
 * Deterministic pre-check over the request text BEFORE any model call.
 * Deny wins over allow. Regex sources are config; a malformed pattern is
 * skipped (logged by the caller).
 * @param {string} toolName - the tool that asked for approval.
 * @param {string|undefined} reason - the approval reason / justification.
 * @param {{ denyPatterns?: string[], allowPatterns?: string[] }} cfg
 * @returns {"allow"|"reject"|undefined} the deterministic verdict, or undefined when nothing matched.
 */
export function quickCheck(toolName, reason, cfg) {
  const text = [toolName, reason].filter((v) => typeof v === "string" && v.length > 0).join("\n");
  if (text.length === 0) return undefined;
  for (const source of cfg.denyPatterns ?? []) {
    if (matches(source, text)) return "reject";
  }
  for (const source of cfg.allowPatterns ?? []) {
    if (matches(source, text)) return "allow";
  }
  return undefined;
}

function matches(source, text) {
  try {
    return new RegExp(source, "i").test(text);
  } catch {
    return false;
  }
}

/**
 * Extract the sandbox mode from an escalation reason. All enforcing tools
 * (bash / fs / pwsh) share the same `approveEscalation` reason shape:
 * `escalate sandbox to <mode>: <justification>`.
 * @param {string|undefined} reason
 * @returns {string|undefined} the target mode, e.g. `danger-full-access`.
 */
export function extractEscalationMode(reason) {
  if (typeof reason !== "string") return undefined;
  const match = /^escalate sandbox to (\S+):/.exec(reason);
  return match === null ? undefined : match[1];
}

/**
 * Match a request against the "always allow" rules. A rule is an object
 * `{ tool?, mode?, pattern?, note?, enabled? }`; every specified dimension
 * must match (missing / `*` / empty = wildcard). `pattern` is a regex tested
 * against the full reason. Rules are matched in order, first hit wins.
 * @param {string} toolName
 * @param {string} reason
 * @param {string|undefined} mode - the escalation target mode (see {@link extractEscalationMode}).
 * @param {readonly any[]|undefined} rules
 * @returns {any|undefined} the matched rule, or undefined.
 */
export function matchAllowRules(toolName, reason, mode, rules) {
  if (!Array.isArray(rules)) return undefined;
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object") continue;
    if (rule.enabled === false) continue;
    if (typeof rule.tool === "string" && rule.tool.length > 0 && rule.tool !== "*" && rule.tool !== toolName) continue;
    if (typeof rule.mode === "string" && rule.mode.length > 0 && rule.mode !== mode) continue;
    if (typeof rule.pattern === "string" && rule.pattern.length > 0 && !matches(rule.pattern, reason)) continue;
    return rule;
  }
  return undefined;
}

/**
 * Serialize a bounded, truncated slice of a session event log for the
 * assessor. Only the three message-producing event families are rendered
 * (user/message, assistant/message, tool/result) — the same surface the model
 * itself sees. Tool-call arguments inside assistant content are rendered so
 * the assessor can judge the ACTUAL operation, not just the agent's
 * justification sentence.
 * @param {readonly any[]} events - `session.events` (append-only durable log).
 * @param {{ maxEvents?: number, maxEventChars?: number, maxTotalChars?: number }} [options]
 * @returns {string} the rendered context, oldest → newest.
 */
export function buildSessionContext(events, options = {}) {
  const { maxEvents = 24, maxEventChars = 240, maxTotalChars = 6000 } = options;
  if (!Array.isArray(events) || events.length === 0) return "";
  const lines = [];
  let total = 0;
  const start = Math.max(0, events.length - maxEvents);
  for (let index = start; index < events.length; index += 1) {
    const line = renderEvent(events[index], maxEventChars);
    if (line === null || line.length === 0) continue;
    if (total + line.length > maxTotalChars) {
      lines.push("... (context truncated)");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

function renderEvent(event, maxEventChars) {
  if (event === null || typeof event !== "object") return null;
  switch (event.type) {
    case "user/message": {
      return `user: ${renderContent(event.data?.content, maxEventChars)}`;
    }
    case "assistant/message": {
      const message = event.data?.message;
      if (message === void 0 || !Array.isArray(message.content) || message.content.length === 0) return null;
      return `assistant: ${renderContent(message.content, maxEventChars)}`;
    }
    case "tool/result": {
      const message = event.data?.message;
      return `tool result: ${renderContent(message?.content, maxEventChars)}`;
    }
    default:
      return null;
  }
}

function renderContent(blocks, maxEventChars) {
  if (!Array.isArray(blocks)) return "";
  const parts = blocks.map((block) => renderBlock(block, maxEventChars));
  return parts.filter((part) => part.length > 0).join(" | ").slice(0, maxEventChars * 4);
}

function renderBlock(block, maxEventChars) {
  if (block === null || typeof block !== "object") return String(block ?? "");
  switch (block.type) {
    case "text":
      return truncate(String(block.text ?? ""), maxEventChars);
    case "tool-call": {
      const args = safeJson(block.arguments ?? block.args, maxEventChars);
      return `[tool call ${block.name ?? "?"} ${args}]`;
    }
    case "tool-result": {
      const inner = Array.isArray(block.content) ? renderContent(block.content, maxEventChars) : safeJson(block.content, maxEventChars);
      return `[tool result${block.isError ? " (error)" : ""}: ${truncate(inner, maxEventChars)}]`;
    }
    default:
      return truncate(safeJson(block, maxEventChars), maxEventChars);
  }
}

function safeJson(value, max) {
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return String(value);
  }
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The sentinel decision flow for ONE approval request.
 *
 *  1. deterministic quick check: `allow` auto-approves; `reject` is NOT a
 *     denial — the request is handed to the human and the flow waits for
 *     them;
 *  2. otherwise start the human channel (`next()` — the composed answerers,
 *     normally the web approval dialog) and race it against the grace timer;
 *  3. the human answers inside the grace window → their outcome wins;
 *  4. the channel reports `unavailable` (no answerer at all → headless):
 *     run the assessor; `allow` auto-approves, anything else fails closed to
 *     `rejected` because there is nobody to wait for;
 *  5. grace expires → run the assessor exactly once:
 *     - `allow` → `allowed-once`;
 *     - `reject` / `wait` / assessor error → notify the session and then
 *       AWAIT the human channel indefinitely — the dialog stays open until
 *       the user acts (or the request is aborted). The plugin never
 *       auto-denies on the assessor's say-so.
 *
 * @param {object} input
 * @param {any} input.req - the approval request (`{ agent, toolName, callId, reason, signal }`).
 * @param {() => Promise<string>} input.next - the remaining waterfall (human channel).
 * @param {object} input.cfg - the resolved sentinel config (defaults applied).
 * @param {object} input.deps
 * @param {(input: { req: any, cfg: object, headless: boolean }) => Promise<{ verdict: string, riskLevel?: string, rationale?: string }>} input.deps.assess
 * @param {(ms: number) => Promise<void>} input.deps.sleep
 * @param {(level: string, ...args: any[]) => void} [input.deps.log]
 * @param {(agent: any, text: string) => void} [input.deps.notify]
 * @returns {Promise<string>} one of `allowed-once` | `rejected` | `cancelled`.
 */
export async function runApprovalFlow({ req, next, cfg, deps }) {
  if (!cfg.enabled) return next();
  if (req.signal?.aborted === true) return "cancelled";

  const reason = typeof req.reason === "string" ? req.reason : "";
  const startHuman = () => Promise.resolve().then(() => next(), (error) => {
    deps.log?.("warn", `human channel rejected: ${error?.message ?? String(error)}`);
    return "unavailable";
  });

  // 0) "Always allow" rules — the user's explicit standing grant. Matched
  //    FIRST (before quick deny): a user-approved rule overrides everything.
  const mode = extractEscalationMode(reason);
  const alwaysRule = matchAllowRules(req.toolName, reason, mode, cfg.allowRules);
  if (alwaysRule !== void 0) {
    const note = typeof alwaysRule.note === "string" && alwaysRule.note.length > 0 ? alwaysRule.note : "始终允许规则命中";
    deps.notify?.(req.agent, buildNotice(req, "allowed-once", "low", `${note}（始终允许，不再弹窗/评审）`, { headless: false, source: "allow-rules" }));
    deps.log?.("info", `allow-rule hit ${req.toolName} mode=${mode ?? "?"} rule=${JSON.stringify(alwaysRule)}`);
    return "allowed-once";
  }

  // 1) Deterministic quick path — no human, no model.
  const quick = quickCheck(req.toolName, reason, cfg);
  if (quick === "allow") {
    deps.notify?.(req.agent, buildNotice(req, "allowed-once", "low", "allowPatterns 命中（确定性规则）", { headless: false, source: "quick" }));
    deps.log?.("info", `quick-allow ${req.toolName} ${JSON.stringify(reason)}`);
    return "allowed-once";
  }
  if (quick === "reject") {
    // A deterministic danger hit is NOT an auto-denial: hand it to the human
    // and wait — the user is the only one who may allow a dangerous pattern.
    deps.notify?.(req.agent, buildNotice(req, "pending-human", "high", "denyPatterns 命中危险模式（确定性规则），未自动放行", { headless: false, source: "quick" }));
    deps.log?.("info", `quick-deny → pending-human ${req.toolName} ${JSON.stringify(reason)}`);
    return await startHuman();
  }

  // 2) Grace race: the human channel first.
  const human = startHuman();
  const winner = await raceWithTimeout(human, cfg.graceMs, deps.sleep);
  if (req.signal?.aborted === true) return "cancelled";
  if (winner.kind === "human") {
    const outcome = winner.value;
    if (outcome !== "unavailable") return outcome; // the human decided inside the grace window
    return await headlessReview({ req, cfg, deps }); // no answerer at all
  }

  // 3) Grace expired → run the assessor EXACTLY once.
  const decision = await assessOnce({ req, cfg, deps, headless: false });
  if (decision.verdict === "aborted") return "cancelled";
  if (req.signal?.aborted === true) return "cancelled";
  if (decision.verdict === "allow") {
    deps.notify?.(req.agent, buildNotice(req, "allowed-once", decision.riskLevel, decision.rationale, { headless: false, source: "assessor" }));
    deps.log?.("info", `auto-approve ${req.toolName} (${decision.riskLevel}): ${decision.rationale}`);
    return "allowed-once";
  }

  // 4) Not clearly allowable (reject / wait / error) → NEVER auto-decide.
  //    Notify the session, then block on the human channel until the user
  //    acts (approval dialog stays open) or the request is aborted.
  const hint = decision.verdict === "reject"
    ? `评审判定不可放行（风险: ${decision.riskLevel}）`
    : decision.verdict === "wait"
      ? `评审无法确定是否安全（风险: ${decision.riskLevel}）`
      : "评审未能完成";
  const rationale = `${hint}。理由: ${decision.rationale ?? ""}`;
  deps.notify?.(req.agent, buildNotice(req, "pending-human", decision.riskLevel, rationale, { headless: false, source: "assessor" }));
  deps.log?.("info", `review non-allow → pending-human ${req.toolName}: ${decision.rationale ?? ""}`);
  return await human;
}

/**
 * Headless review: no human channel exists, so a non-allow cannot "wait for
 * the user" — fail closed. An `allow` still auto-approves.
 */
async function headlessReview({ req, cfg, deps }) {
  if (cfg.headlessGraceMs > 0) await deps.sleep(cfg.headlessGraceMs);
  if (req.signal?.aborted === true) return "cancelled";
  const decision = await assessOnce({ req, cfg, deps, headless: true });
  if (decision.verdict === "aborted") return "cancelled";
  if (req.signal?.aborted === true) return "cancelled";
  if (decision.verdict === "allow") {
    deps.notify?.(req.agent, buildNotice(req, "allowed-once", decision.riskLevel, decision.rationale, { headless: true, source: "assessor" }));
    deps.log?.("info", `headless auto-approve ${req.toolName} (${decision.riskLevel}): ${decision.rationale}`);
    return "allowed-once";
  }
  deps.notify?.(req.agent, buildNotice(req, "rejected", decision.riskLevel, "无人工审批通道（headless），评审未放行，失败关闭", { headless: true, source: "assessor" }));
  deps.log?.("info", `headless non-allow → rejected ${req.toolName}: ${decision.rationale ?? ""}`);
  return "rejected";
}

/** Run one assessment, containing assessor failures into a decision. */
async function assessOnce({ req, cfg, deps, headless }) {
  try {
    return await deps.assess({ req, cfg, headless });
  } catch (error) {
    if (req.signal?.aborted === true) return { verdict: "aborted", riskLevel: "unknown", rationale: "request aborted" };
    const detail = error?.message ?? String(error);
    deps.log?.("warn", `assessor failed: ${detail}`);
    return { verdict: "error", riskLevel: "unknown", rationale: `评审 agent 失败：${detail}` };
  }
}

/** Build the user-visible notice injected into the session after a decision. */
export function buildNotice(req, state, riskLevel, rationale, info) {
  const verb = state === "allowed-once"
    ? "✅ 已自动放行"
    : state === "pending-human"
      ? "⏳ 未自动放行，已交由你本人决定（审批弹窗保持等待）"
      : "⛔ 已失败关闭（rejected）";
  const when = info.source === "quick"
    ? "确定性规则命中"
    : info.source === "allow-rules"
      ? "「始终允许」规则命中"
      : info.headless
        ? "无人工审批通道（headless）"
        : "人工宽限期超时";
  const by = info.source === "quick"
    ? "确定性规则"
    : info.source === "allow-rules"
      ? "「始终允许」规则"
      : "风险评估 agent";
  const reason = truncate(typeof req.reason === "string" ? req.reason : "(无说明)", 200);
  return `[帮我批准] ${when}，${by} 审查了请求「${req.toolName}: ${reason}」→ ${verb}（风险: ${riskLevel ?? "unknown"}）。理由: ${truncate(rationale ?? "", 300)}`;
}

/** Race a promise against a timeout; the losing side is left pending (its dialog stays open). */
async function raceWithTimeout(promise, ms, sleep) {
  if (ms <= 0) return { kind: "timeout" };
  const timeout = sleep(ms).then(() => ({ kind: "timeout" }));
  return Promise.race([
    promise.then((value) => ({ kind: "human", value }), (error) => ({ kind: "human", value: "unavailable", error })),
    timeout
  ]);
}

/** Simple FIFO concurrency gate (max parallel assessors). */
export function createGate(max) {
  let active = 0;
  const queue = [];
  async function run(task) {
    if (active >= max) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  }
  return run;
}
