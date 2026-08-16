// tests/waterfall.test.mjs — drives the pure decision engine (lib/core.js)
// against a simulated approval/request waterfall, exactly as the cordis
// adapter wires it: sentinel listener outermost, a fake "human channel"
// answerer behind it (or none = headless), and a fake risk assessor.
//
// Run: node tests/waterfall.test.mjs

import assert from "node:assert/strict";
import {
  runApprovalFlow,
  quickCheck,
  buildSessionContext,
  createGate,
  buildNotice
} from "../lib/core.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    maxWaits: 2,
    maxConcurrentAssessments: 3,
    assessorModel: "",
    assessorProvider: "",
    onAssessError: "wait",
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
  // 1. Deterministic quick-deny (no human, no assessor).
  await scenario("quick-deny via denyPatterns", async () => {
    const cfg = baseCfg({ denyPatterns: ["rm\\s+-rf\\s+/"] });
    let nextCalled = 0;
    const outcome = await runApprovalFlow({
      req: makeReq({ reason: "escalate sandbox to danger-full-access: rm -rf / tmp cleanup" }),
      next: () => { nextCalled += 1; return new Promise(() => {}); },
      cfg,
      deps: makeDeps()
    });
    assert.equal(outcome, "rejected");
    assert.equal(nextCalled, 0, "quick-deny must not touch the human channel");
  });

  // 2. Deterministic quick-allow.
  await scenario("quick-allow via allowPatterns", async () => {
    const cfg = baseCfg({ allowPatterns: ["npm install"] });
    const outcome = await runApprovalFlow({
      req: makeReq({ reason: "escalate sandbox to workspace-write: npm install deps" }),
      next: () => new Promise(() => {}),
      cfg,
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
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

  // 4. Human silent → grace expiry → assessor allow → allowed-once.
  await scenario("grace expiry + assessor allow → allowed-once", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => new Promise(() => {}),
      cfg: baseCfg({ graceMs: 20 }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
  });

  // 5. Human silent → assessor reject → rejected.
  await scenario("grace expiry + assessor reject → rejected", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => new Promise(() => {}),
      cfg: baseCfg({ graceMs: 20 }),
      deps: makeDeps({ assess: async () => ({ verdict: "reject", riskLevel: "critical", rationale: "exfiltration pattern" }) })
    });
    assert.equal(outcome, "rejected");
  });

  // 6. Assessor `wait` → re-arms the human window → late human answer wins.
  await scenario("assessor wait → human answers on the second window", async () => {
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(30).then(() => "rejected"),
      cfg: baseCfg({ graceMs: 20 }),
      deps: makeDeps({
        assess: async () => { assessed += 1; return { verdict: "wait", riskLevel: "medium", rationale: "unclear" }; }
      })
    });
    assert.equal(outcome, "rejected"); // the late HUMAN decision
    assert.equal(assessed, 1, "wait must not re-assess");
  });

  // 7. Assessor `wait` twice → fail closed to rejected (no human ever answers).
  await scenario("wait exhausted after maxWaits → rejected", async () => {
    let assessed = 0;
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => new Promise(() => {}),
      cfg: baseCfg({ graceMs: 10, maxWaits: 2 }),
      deps: makeDeps({
        assess: async () => { assessed += 1; return { verdict: "wait", riskLevel: "medium", rationale: "unclear" }; }
      })
    });
    assert.equal(outcome, "rejected");
    assert.equal(assessed, 2);
  });

  // 8. Headless (next → unavailable) → assessor allow → allowed-once.
  await scenario("headless + assessor allow → allowed-once", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => Promise.resolve("unavailable"),
      cfg: baseCfg({ headlessGraceMs: 0 }),
      deps: makeDeps()
    });
    assert.equal(outcome, "allowed-once");
  });

  // 9. Headless + assessor wait → fail closed (no human to wait for).
  await scenario("headless + assessor wait → rejected", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => Promise.resolve("unavailable"),
      cfg: baseCfg(),
      deps: makeDeps({ assess: async () => ({ verdict: "wait", riskLevel: "high", rationale: "unclear" }) })
    });
    assert.equal(outcome, "rejected");
  });

  // 10. Assessor failure + onAssessError=wait → handed back to human → late answer wins.
  await scenario("assessor error → onAssessError wait → human decides", async () => {
    // Round 0: grace (10ms) expires, assessor throws → wait → re-arm.
    // Round 1: human answers at 15ms, inside the second window → their call wins.
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => sleep(15).then(() => "allowed-once"),
      cfg: baseCfg({ graceMs: 10, onAssessError: "wait" }),
      deps: makeDeps({ assess: async () => { throw new Error("provider down"); } })
    });
    assert.equal(outcome, "allowed-once");
  });

  // 11. Assessor failure + onAssessError=reject → rejected immediately.
  await scenario("assessor error → onAssessError reject → rejected", async () => {
    const outcome = await runApprovalFlow({
      req: makeReq(),
      next: () => new Promise(() => {}),
      cfg: baseCfg({ graceMs: 10, onAssessError: "reject" }),
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

  // 15. buildSessionContext renders tool-call arguments (the real command).
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

  // 16. createGate serializes beyond the cap.
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

  // 17. buildNotice carries the brand + rationale.
  await scenario("buildNotice includes 帮我批准 and rationale", () => {
    const notice = buildNotice(makeReq(), "allowed-once", "low", "在仓库内操作", { headless: false, waitRound: 0, source: "assessor" });
    assert.match(notice, /帮我批准/);
    assert.match(notice, /已自动批准/);
    assert.match(notice, /在仓库内操作/);
  });

  // 18. quickCheck edge: malformed regex is skipped, not thrown.
  await scenario("quickCheck tolerates malformed regex", () => {
    assert.equal(quickCheck("bash", "rm -rf /", { denyPatterns: ["[unclosed"], allowPatterns: [] }), undefined);
    assert.equal(quickCheck("bash", "npm install", { denyPatterns: ["[unclosed"], allowPatterns: ["npm"] }), "allow");
  });

  console.log(`\nall ${passed} scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
