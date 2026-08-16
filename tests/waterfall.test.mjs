// tests/waterfall.test.mjs — drives the pure decision engine (lib/core.js)
// against a simulated approval/request waterfall, exactly as the cordis
// adapter wires it: sentinel listener outermost, a fake "human channel"
// answerer behind it (or none = headless), and a fake risk assessor.
//
// POLICY UNDER TEST: the assessor may AUTO-APPROVE (allow) but may never
// auto-deny — reject / wait / assessor error all hand the request back to the
// human and keep waiting until the user acts. Only headless (no answerer at
// all) fails closed.
//
// Run: node tests/waterfall.test.mjs

import assert from "node:assert/strict";
import {
  runApprovalFlow,
  quickCheck,
  buildSessionContext,
  createGate,
  buildNotice,
  matchAllowRules,
  extractEscalationMode
} from "../lib/core.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReq(overrides = {}) {
  return {
    agent: {
      id: "s1",
      session: { id: "s1", header: { cwd: "/work" }, events: [] },
      inject() {}
    },
    toolName: "bash",
    reason: "escalate sandbox to workspace-write: run npm install",
    ...overrides
  };
}

function baseCfg(overrides = {}) {
  return {
    enabled: true,
    graceMs: 40,
    headlessGraceMs: 0,
    assessTimeoutMs: 1000,
    maxConcurrentAssessments: 3,
    assessorModel: "",
    assessorProvider: "",
    denyPatterns: [],
    allowPatterns: [],
    notifyUser: true,
    verbose: false,
    ...overrides
  };
}

function makeDeps(overrides = {}) {
  return {
    assess: async () => ({ verdict: "allow", riskLevel: "low", rationale: "safe" }),
    sleep,
    log: () => {},
    notify: () => {},
    ...overrides
  };
}

let passed = 0;
async function scenario(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}

async function main() {
  // 1. Deterministic quick-allow (no human, no assessor).
  await scenario("quick-allow via allowPatterns", async () => {
    let nextCalled = 0;
    const outcome = await runApprovalFlow({
      req: makeReq({ reason: "escalate sandbox to workspace-write: npm install deps" }),
      next: () => { nextCalled += 1; return new Promise(() => {}); },
      cfg: baseCfg({ allowPatterns: ["npm install"] }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
    assert.equal(nextCalled, 0, "quick-allow must not touch the human channel");
  });

  // 2. Quick-deny is NOT an auto-denial: hand to the human and wait for THEIR decision.
  await scenario("quick-deny → pending-human → user decides", async () => {
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq({ reason: "escalate sandbox to danger-full-access: rm -rf / tmp cleanup" }),
      next: () => sleep(15).then(() => "rejected"),
      cfg: baseCfg({ denyPatterns: ["rm\\s+-rf\\s+/"], graceMs: 200 }),
      deps: makeDeps({ assess: async () => { assessed += 1; return { verdict: "allow", riskLevel: "low", rationale: "should not run" }; } })
    });
    assert.equal(outcome, "rejected"); // the HUMAN's rejection
    assert.equal(assessed, 0, "quick-deny must not spawn an assessor");
  });

  // 3. Human answers inside the grace window → their outcome wins, no assessor.
  await scenario("human answers within grace → outcome propagates", async () => {
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(5).then(() => "allowed-once"),
      cfg: baseCfg({ graceMs: 200 }),
      deps: makeDeps({ assess: async () => { assessed += 1; return { verdict: "reject", riskLevel: "high", rationale: "should not run" }; } })
    });
    assert.equal(outcome, "allowed-once");
    assert.equal(assessed, 0, "assessor must not run when the human answers");
  });

  // 4. Grace expiry + assessor allow → auto-approved.
  await scenario("grace expiry + assessor allow → allowed-once", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => new Promise(() => {}),
      cfg: baseCfg({ graceMs: 20 }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
  });

  // 5. Assessor reject is NOT an auto-denial: wait for the user's own decision.
  await scenario("assessor reject → pending-human → user decides", async () => {
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(80).then(() => "rejected"),
      cfg: baseCfg({ graceMs: 20 }),
      deps: makeDeps({
        assess: async () => { assessed += 1; return { verdict: "reject", riskLevel: "critical", rationale: "exfiltration pattern" }; }
      })
    });
    assert.equal(outcome, "rejected"); // the HUMAN's rejection, not the assessor's
    assert.equal(assessed, 1, "assessor runs exactly once");
  });

  // 6. Assessor wait → keeps waiting for the user (no re-assessment, no auto-deny).
  await scenario("assessor wait → keeps waiting until the user acts", async () => {
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(60).then(() => "allowed-once"),
      cfg: baseCfg({ graceMs: 20 }),
      deps: makeDeps({
        assess: async () => { assessed += 1; return { verdict: "wait", riskLevel: "medium", rationale: "unclear" }; }
      })
    });
    assert.equal(outcome, "allowed-once"); // the user's late decision
    assert.equal(assessed, 1, "wait must not re-assess");
  });

  // 7. Non-allow keeps waiting INDEFINITELY — the flow stays pending until the user acts.
  await scenario("non-allow waits indefinitely (no fail-closed)", async () => {
    const human = deferred();
    let assessed = 0;
    const flow = runApprovalFlow({
      req: makeReq(),
      next: () => human.promise,
      cfg: baseCfg({ graceMs: 10 }),
      deps: makeDeps({
        assess: async () => { assessed += 1; return { verdict: "wait", riskLevel: "medium", rationale: "unclear" }; }
      })
    });
    // 150ms later the flow must still be waiting (no maxWaits fail-closed).
    const early = await Promise.race([flow.then((o) => ["settled", o]), sleep(150).then(() => ["waiting"])]);
    assert.deepEqual(early, ["waiting"], "must keep waiting for the human");
    assert.equal(assessed, 1);
    human.resolve("rejected");
    assert.equal(await flow, "rejected");
  });

  // 8. Headless (next → unavailable) + assessor allow → auto-approved.
  await scenario("headless + assessor allow → allowed-once", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => Promise.resolve("unavailable"),
      cfg: baseCfg({ headlessGraceMs: 0 }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
  });

  // 9. Headless + assessor wait → fail closed (nobody to wait for).
  await scenario("headless + assessor wait → rejected", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => Promise.resolve("unavailable"),
      cfg: baseCfg(),
      deps: makeDeps({ assess: async () => ({ verdict: "wait", riskLevel: "high", rationale: "unclear" }) })
    });
    assert.equal(outcome, "rejected");
  });

  // 10. Assessor failure → handed back to the human → the user decides.
  await scenario("assessor error → pending-human → user decides", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(50).then(() => "allowed-once"),
      cfg: baseCfg({ graceMs: 10 }),
      deps: makeDeps({ assess: async () => { throw new Error("provider down"); } })
    });
    assert.equal(outcome, "allowed-once"); // the user's decision
  });

  // 11. Headless + assessor failure → fail closed.
  await scenario("headless + assessor error → rejected", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => Promise.resolve("unavailable"),
      cfg: baseCfg({ graceMs: 10 }),
      deps: makeDeps({ assess: async () => { throw new Error("provider down"); } })
    });
    assert.equal(outcome, "rejected");
  });

  // 12. Aborted request → cancelled, nothing runs.
  await scenario("aborted request → cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq({ signal: controller.signal }),
      next: () => Promise.resolve("allowed-once"),
      cfg: baseCfg(),
      deps: makeDeps({ assess: async () => { assessed += 1; return { verdict: "allow", riskLevel: "low", rationale: "" }; } })
    });
    assert.equal(outcome, "cancelled");
    assert.equal(assessed, 0);
  });

  // 13. Human channel returning "cancelled" propagates.
  await scenario("human cancels → cancelled", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(5).then(() => "cancelled"),
      cfg: baseCfg({ graceMs: 200 }),
      deps: makeDeps()
    });
    assert.equal(outcome, "cancelled");
  });

  // 14. disabled → pure delegate.
  await scenario("disabled → delegates to the human channel", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => Promise.resolve("allowed-once"),
      cfg: baseCfg({ enabled: false }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
  });

  // 15. buildSessionContext renders tool calls + messages.
  await scenario("buildSessionContext renders tool calls + messages", () => {
    const events = [
      { type: "user/message", data: { role: "user", content: [{ type: "text", text: "请修一下构建" }] } },
      { type: "assistant/message", data: { message: { role: "assistant", content: [
        { type: "text", text: "我来跑一下测试" },
        { type: "tool-call", name: "bash", arguments: JSON.stringify({ command: "rm -rf /", description: "dangerous" }) }
      ] } } },
      { type: "tool/result", data: { message: { role: "user", content: [{ type: "tool-result", content: "denied", isError: true }] } } },
      { type: "approval/asked", data: { id: "x", toolName: "bash" } },
      { type: "turn/end", data: {} }
    ];
    const context = buildSessionContext(events);
    assert.match(context, /user: 请修一下构建/);
    assert.match(context, /assistant: 我来跑一下测试/);
    assert.match(context, /\[tool call bash/);
    assert.match(context, /rm -rf/);
    assert.match(context, /tool result/);
    assert.doesNotMatch(context, /approval\/asked/, "non-surface events must be skipped");
  });

  // 16. createGate caps concurrency.
  await scenario("createGate caps concurrency", async () => {
    const gate = createGate(1);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(10);
      running -= 1;
    };
    await Promise.all([gate(task), gate(task), gate(task)]);
    assert.equal(peak, 1, "max 1 concurrent through the gate");
  });

  // 17. buildNotice carries the brand + the pending-human wording.
  await scenario("buildNotice includes 帮我批准 and state wording", () => {
    const allow = buildNotice(makeReq(), "allowed-once", "low", "在仓库内操作", { headless: false, source: "assessor" });
    assert.match(allow, /帮我批准/);
    assert.match(allow, /已自动放行/);
    assert.match(allow, /在仓库内操作/);
    const pending = buildNotice(makeReq(), "pending-human", "high", "评审判定不可放行", { headless: false, source: "assessor" });
    assert.match(pending, /已交由你本人决定/);
    assert.match(pending, /审批弹窗保持等待/);
  });

  // 18. quickCheck edge: malformed regex is skipped, not thrown.
  await scenario("quickCheck tolerates malformed regex", () => {
    assert.equal(quickCheck("bash", "rm -rf /", { denyPatterns: ["[unclosed"], allowPatterns: [] }), undefined);
    assert.equal(quickCheck("bash", "npm install", { denyPatterns: ["[unclosed"], allowPatterns: ["npm"] }), "allow");
  });

  // 19. extractEscalationMode parses the shared reason shape.
  await scenario("extractEscalationMode parses escalation reasons", () => {
    assert.equal(extractEscalationMode("escalate sandbox to danger-full-access: run tests"), "danger-full-access");
    assert.equal(extractEscalationMode("escalate sandbox to workspace-write: npm install"), "workspace-write");
    assert.equal(extractEscalationMode("just a plain reason"), undefined);
    assert.equal(extractEscalationMode(undefined), undefined);
  });

  // 20. matchAllowRules dimension matching.
  await scenario("matchAllowRules matches tool/mode/pattern with wildcards", () => {
    const rules = [
      { tool: "bash", mode: "danger-full-access", pattern: "npm", note: "npm installs" },
      { tool: "", mode: "workspace-write", pattern: "" },
      { tool: "*", mode: "", pattern: "pnpm", enabled: false },
      { tool: "fs", mode: "", pattern: "" }
    ];
    assert.equal(matchAllowRules("bash", "escalate sandbox to danger-full-access: npm run build", "danger-full-access", rules)?.note, "npm installs");
    assert.equal(matchAllowRules("bash", "escalate sandbox to danger-full-access: yarn build", "danger-full-access", rules), undefined, "pattern mismatch");
    assert.ok(matchAllowRules("bash", "escalate sandbox to workspace-write: anything", "workspace-write", rules), "empty tool+pattern = wildcard");
    assert.ok(matchAllowRules("fs", "escalate sandbox to workspace-write: write file", "workspace-write", rules), "fs tool rule");
    assert.equal(matchAllowRules("bash", "escalate sandbox to danger-full-access: yarn x", "danger-full-access", rules), undefined, "disabled rule must not match");
    // the same pnpm rule, enabled, does match
    assert.ok(matchAllowRules("bash", "escalate sandbox to danger-full-access: pnpm x", "danger-full-access", [{ tool: "*", mode: "", pattern: "pnpm", enabled: true }]), "enabled pnpm rule matches");
    assert.equal(matchAllowRules("bash", "x", "danger-full-access", undefined), undefined);
  });

  // 21. allowRules hit → auto-approve WITHOUT dialog/assessor, even over denyPatterns.
  await scenario("allowRules hit → allowed-once (no dialog, no assessor, overrides deny)", async () => {
    let nextCalled = 0;
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq({ reason: "escalate sandbox to danger-full-access: npm run build" }),
      next: () => { nextCalled += 1; return new Promise(() => {}); },
      cfg: baseCfg({
        allowRules: [{ tool: "bash", mode: "danger-full-access", pattern: "npm", note: "npm builds" }],
        denyPatterns: ["npm"] // must be overridden by the explicit user grant
      }),
      deps: makeDeps({ assess: async () => { assessed += 1; return { verdict: "reject", riskLevel: "critical", rationale: "" }; } })
    });
    assert.equal(outcome, "allowed-once");
    assert.equal(nextCalled, 0, "allow-rule must not open the dialog");
    assert.equal(assessed, 0, "allow-rule must not spawn an assessor");
  });

  // 22. allowRules non-match falls through to the normal flow.
  await scenario("allowRules non-match → normal assessor flow", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq({ reason: "escalate sandbox to workspace-write: run npm install" }),
      next: () => new Promise(() => {}),
      cfg: baseCfg({ graceMs: 10, allowRules: [{ tool: "bash", mode: "danger-full-access", pattern: "npm" }] }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once"); // via the assessor
  });

  console.log(`\nall ${passed} scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
