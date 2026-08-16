// core.js — pure decision engine for dsh-approval-sentinel (帮我批准).
//
// No cordis / harness imports here on purpose: the whole approval policy is a
// set of pure functions plus one async flow, so the tests in tests/ can drive
// it with a fake `next()` chain and a fake assessor. The cordis adapter in
// index.js only wires these into `approval/request` and `ctx.subagents`.

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
 * Flow:
 *  1. deterministic quick check (cheapest) — deny/allow straight away;
 *  2. otherwise start the human channel (`next()`: the composed answerers —
 *     normally the web approval dialog) and race it against a grace timer;
 *  3. human answers in time → their outcome wins unchanged;
 *  4. no answerer at all (`unavailable`) → headless mode: assess after an
 *     optional extra grace;
 *  5. grace expires → run the risk-assessment agent;
 *     - allow → `allowed-once`; reject → `rejected`;
 *     - wait → re-arm the human grace window (no re-assessment), up to
 *       `maxWaits` rounds, then fail closed to `rejected`;
 *     - assessor error → `onAssessError` (`wait` = hand back to the human,
 *       `reject` = fail closed); in headless mode any non-allow collapses to
 *       `rejected` because there is no human to fall back to.
 *
 * Every auto-decision is announced through `deps.notify` (a session-visible
 * message) and logged through `deps.log`.
 *
 * @param {object} input
 * @param {any} input.req - the approval request (`{ agent, toolName, callId, reason, signal }`).
 * @param {() => Promise<string>} input.next - the remaining waterfall (human channel).
 * @param {object} input.cfg - the resolved sentinel config (defaults applied).
 * @param {object} input.deps
 * @param {(input: { req: any, cfg: object, headless: boolean, waitRound: number }) => Promise<{ verdict: string, riskLevel?: string, rationale?: string }>} input.deps.assess
 * @param {(ms: number) => Promise<void>} input.deps.sleep
 * @param {(level: string, ...args: any[]) => void} [input.deps.log]
 * @param {(agent: any, text: string) => void} [input.deps.notify]
 * @returns {Promise<string>} one of `allowed-once` | `rejected` | `cancelled`.
 */
export async function runApprovalFlow({ req, next, cfg, deps }) {
  if (!cfg.enabled) return next();
  if (req.signal?.aborted === true) return "cancelled";

  const reason = typeof req.reason === "string" ? req.reason : "";

  // 1. Deterministic quick path — no human, no model.
  const quick = quickCheck(req.toolName, reason, cfg);
  if (quick === "reject") {
    const rationale = "denyPatterns 命中，确定性拒绝（未调用评审模型）";
    deps.notify?.(req.agent, buildNotice(req, "rejected", "high", rationale, { headless: false, waitRound: 0, source: "quick" }));
    deps.log?.("info", `quick-deny ${req.toolName} ${JSON.stringify(reason)}`);
    return "rejected";
  }
  if (quick === "allow") {
    const rationale = "allowPatterns 命中，确定性放行（未调用评审模型）";
    deps.notify?.(req.agent, buildNotice(req, "allowed-once", "low", rationale, { headless: false, waitRound: 0, source: "quick" }));
    deps.log?.("info", `quick-allow ${req.toolName} ${JSON.stringify(reason)}`);
    return "allowed-once";
  }

  // 2. Human channel + grace race.
  const human = Promise.resolve().then(() => next(), (error) => {
    deps.log?.("warn", `human channel rejected: ${error?.message ?? String(error)}`);
    return "unavailable";
  });
  let waitRound = 0;
  for (;;) {
    if (req.signal?.aborted === true) return "cancelled";
    const winner = await raceWithTimeout(human, waitRound === 0 ? cfg.graceMs : cfg.graceMs, deps.sleep);
    if (req.signal?.aborted === true) return "cancelled";

    if (winner.kind === "human") {
      const outcome = winner.value;
      if (outcome !== "unavailable") return outcome; // human decided: allowed-once | rejected | cancelled
      // No answerer composed at all → headless: assess after an optional extra grace.
      if (cfg.headlessGraceMs > 0) await deps.sleep(cfg.headlessGraceMs);
      if (req.signal?.aborted === true) return "cancelled";
      const decision = await assessOnce({ req, cfg, deps, headless: true, waitRound });
      return finalize(decision, { req, cfg, deps, headless: true, waitRound });
    }

    // 3. Grace expired → run the risk-assessment agent.
    const decision = await assessOnce({ req, cfg, deps, headless: false, waitRound });
    const outcome = finalize(decision, { req, cfg, deps, headless: false, waitRound });
    if (outcome !== "wait") return outcome;

    // 4. `wait` → keep waiting for the human; fail closed after maxWaits rounds.
    if (waitRound >= cfg.maxWaits - 1) {
      const rationale = "评审 agent 多次未能给出确定结论，等待人工确认超时，失败关闭";
      deps.notify?.(req.agent, buildNotice(req, "rejected", "unknown", rationale, { headless: false, waitRound, source: "wait-exhausted" }));
      deps.log?.("info", `wait-exhausted ${req.toolName}: ${decision.rationale ?? ""}`);
      return "rejected";
    }
    waitRound += 1;
    deps.log?.("info", `assessor wait ${req.toolName} (round ${waitRound}): ${decision.rationale ?? ""}`);
  }
}

/**
 * Run one assessment, containing assessor failures into a decision.
 * An aborted request surfaces as `{ verdict: "aborted" }` so the caller can
 * map it to `cancelled` instead of rejecting a dead request.
 */
async function assessOnce({ req, cfg, deps, headless, waitRound }) {
  try {
    return await deps.assess({ req, cfg, headless, waitRound });
  } catch (error) {
    if (req.signal?.aborted === true) return { verdict: "aborted", riskLevel: "unknown", rationale: "request aborted" };
    const detail = error?.message ?? String(error);
    deps.log?.("warn", `assessor failed: ${detail}`);
    // Default: hand back to the human channel (`wait`). In headless there is
    // no human, so a failure is a denial (fail closed).
    if (cfg.onAssessError === "reject" || headless) {
      return { verdict: "reject", riskLevel: "unknown", rationale: `评审 agent 失败：${detail}` };
    }
    return { verdict: "wait", riskLevel: "unknown", rationale: `评审 agent 失败，转人工确认：${detail}` };
  }
}

/** Map one assessor decision to the approval outcome vocabulary. */
function finalize(decision, { req, cfg, deps, headless, waitRound }) {
  const { verdict, riskLevel = "unknown", rationale = "" } = decision;
  switch (verdict) {
    case "allow": {
      deps.notify?.(req.agent, buildNotice(req, "allowed-once", riskLevel, rationale, { headless, waitRound, source: "assessor" }));
      deps.log?.("info", `auto-approve ${req.toolName} (${riskLevel}): ${rationale}`);
      return "allowed-once";
    }
    case "reject": {
      deps.notify?.(req.agent, buildNotice(req, "rejected", riskLevel, rationale, { headless, waitRound, source: "assessor" }));
      deps.log?.("info", `auto-reject ${req.toolName} (${riskLevel}): ${rationale}`);
      return "rejected";
    }
    case "wait": {
      // Headless: no human to wait for → fail closed now.
      if (headless) {
        deps.notify?.(req.agent, buildNotice(req, "rejected", riskLevel, `${rationale}（无人工通道，失败关闭）`, { headless, waitRound, source: "assessor" }));
        deps.log?.("info", `headless-wait → rejected ${req.toolName}: ${rationale}`);
        return "rejected";
      }
      deps.log?.("info", `assessor wait ${req.toolName} (${riskLevel}): ${rationale}`);
      return "wait";
    }
    case "aborted":
      return "cancelled";
    default: {
      deps.log?.("warn", `unknown assessor verdict ${JSON.stringify(verdict)} → rejected`);
      return "rejected";
    }
  }
}

/** Build the user-visible notice injected into the session after a decision. */
export function buildNotice(req, outcome, riskLevel, rationale, info) {
  const verb = outcome === "allowed-once" ? "✅ 已自动批准"
    : outcome === "rejected" ? "⛔ 已自动拒绝"
    : "⏳ 继续等待人工确认";
  const when = info.headless
    ? "无人工审批通道（headless）"
    : info.waitRound > 0
      ? `人工宽限期超时（第 ${info.waitRound + 1} 轮）`
      : "人工宽限期超时";
  const source = info.source === "quick" ? "确定性规则" : "风险评估 agent";
  const reason = truncate(typeof req.reason === "string" ? req.reason : "(无说明)", 200);
  return `[帮我批准] ${when}，${source} 审查了请求「${req.toolName}: ${reason}」→ ${verb}（风险: ${riskLevel}）。理由: ${truncate(rationale ?? "", 300)}`;
}

/** Race a promise against a timeout; the losing side is left pending (its dialog stays open). */
async function raceWithTimeout(promise, ms, sleep) {
  if (ms <= 0) return { kind: "timeout" };
  let timer;
  const timeout = sleep(ms).then(() => ({ kind: "timeout" }));
  const result = await Promise.race([
    promise.then((value) => ({ kind: "human", value }), (error) => ({ kind: "human", value: "unavailable", error })),
    timeout,
  ]);
  if (timer !== void 0) clearTimeout(timer);
  return result;
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
