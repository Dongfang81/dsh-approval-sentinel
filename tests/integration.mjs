// tests/integration.mjs — smoke-test the cordis adapter (lib/index.js) with a
// minimal fake ctx: no real cordis, no real subagent — just enough surface to
// prove the wiring (prepend listener, assessor spawn arguments, notice
// injection, settings-absent behavior).
//
// Run: node tests/integration.mjs

import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function makeCtx({ services = {}, listeners = [], injected = [] } = {}) {
  return {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    get: (name) => services[name],
    inject: () => {}, // no settings service → installSettingsSection is a no-op
    on: (name, listener, options) => {
      listeners.push({ name, listener, options });
      return () => {};
    },
    effect: () => () => {},
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/work" }) },
    _services: services,
    _listeners: listeners,
    _injected: injected
  };
}

function makeAgent(injected) {
  return {
    id: "s1",
    options: { model: "deepseek-v4-flash", provider: "deepseek-official" },
    session: { id: "s1", header: { cwd: "/work" }, events: [] },
    inject: (message) => injected.push(message)
  };
}

function makeReq(agent) {
  return {
    agent,
    toolName: "bash",
    callId: "call-1",
    reason: "escalate sandbox to workspace-write: run npm install"
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
  // 1. Listener registered prepend on approval/request.
  await scenario("registers prepend listener on approval/request", () => {
    const ctx = makeCtx();
    apply(ctx, {});
    assert.equal(ctx._listeners.length, 1);
    assert.equal(ctx._listeners[0].name, "approval/request");
    assert.equal(ctx._listeners[0].options, true, "must prepend (outermost in the waterfall)");
  });

  // 2. Human never answers → fresh assessor subagent → allowed-once + notice.
  await scenario("grace expiry → spawns assessor subagent → allowed-once + notice", async () => {
    const injected = [];
    const starts = [];
    const agent = makeAgent(injected);
    const ctx = makeCtx({
      services: {
        subagents: {
          list: () => ["spawn", "fork"],
          getProvider: (name) => name === "spawn"
            ? { name, inheritsParentContext: false }
            : { name, inheritsParentContext: true },
          start: async (provider, request) => {
            starts.push({ provider, request });
            return {
              id: "child-1",
              localAgent: undefined,
              result: Promise.resolve({
                output: [],
                structured: { verdict: "allow", riskLevel: "low", rationale: "in-workspace npm install" },
                stopReason: "completed"
              }),
              dispose: async () => {}
            };
          }
        }
      },
      injected
    });
    apply(ctx, { graceMs: 30 });
    const listener = ctx._listeners[0].listener;
    const outcome = await listener(makeReq(agent), () => new Promise(() => {}));
    assert.equal(outcome, "allowed-once");

    // spawn args
    assert.equal(starts.length, 1);
    assert.equal(starts[0].provider, "spawn", "must prefer the zero-parent-context provider");
    const request = starts[0].request;
    assert.match(request.label, /risk assessment/);
    assert.equal(request.parent, agent);
    assert.deepEqual(request.toolFilter, { allow: [] }, "assessor must be tool-less");
    assert.equal(request.outputSchema.type, "object");
    assert.equal(request.outputSchema.required[0], "verdict");
    assert.match(request.prompt[0].text, /UNTRUSTED DATA/);
    assert.match(request.prompt[0].text, /escalate sandbox to workspace-write/);
    assert.equal(request.agentOptions.model, "deepseek-v4-flash", "inherits the parent model route");

    // notice injected into the session
    assert.ok(injected.length >= 1, "auto-decision must be announced");
    assert.match(injected[0].content[0].text, /帮我批准/);
    assert.match(injected[0].content[0].text, /已自动批准/);
    assert.equal(injected[0].source.kind, "plugin");
  });

  // 3. Human answers quickly → outcome propagates, no assessor, no notice.
  await scenario("human answers within grace → no assessor, no notice", async () => {
    const injected = [];
    let started = 0;
    const agent = makeAgent(injected);
    const ctx = makeCtx({
      services: {
        subagents: {
          list: () => ["spawn"],
          getProvider: (name) => ({ name, inheritsParentContext: false }),
          start: async () => { started += 1; throw new Error("must not be called"); }
        }
      },
      injected
    });
    apply(ctx, { graceMs: 200 });
    const listener = ctx._listeners[0].listener;
    const outcome = await listener(makeReq(agent), () => Promise.resolve("rejected"));
    assert.equal(outcome, "rejected");
    assert.equal(started, 0);
    assert.equal(injected.length, 0, "a human decision needs no sentinel notice");
  });

  // 4. Assessor returns reject → rejected + notice.
  await scenario("assessor reject → rejected + notice", async () => {
    const injected = [];
    const agent = makeAgent(injected);
    const ctx = makeCtx({
      services: {
        subagents: {
          list: () => ["spawn"],
          getProvider: (name) => ({ name, inheritsParentContext: false }),
          start: async () => ({
            id: "child-2",
            result: Promise.resolve({
              output: [],
              structured: { verdict: "reject", riskLevel: "critical", rationale: "credential exfiltration" },
              stopReason: "completed"
            }),
            dispose: async () => {}
          })
        }
      },
      injected
    });
    apply(ctx, { graceMs: 30 });
    const listener = ctx._listeners[0].listener;
    const outcome = await listener(makeReq(agent), () => new Promise(() => {}));
    assert.equal(outcome, "rejected");
    assert.match(injected[0].content[0].text, /已自动拒绝/);
  });

  // 5. No subagents service → contained failure → handed to human (wait) → human decides.
  await scenario("no subagents service → assessor error → human decides", async () => {
    const ctx = makeCtx({ services: {} }); // no subagents at all
    apply(ctx, { graceMs: 30 });
    const listener = ctx._listeners[0].listener;
    // next() resolves after 60ms — inside the second re-armed window (30-90ms).
    const outcome = await listener(makeReq(makeAgent([])), () => new Promise((resolve) => setTimeout(() => resolve("allowed-once"), 60)));
    assert.equal(outcome, "allowed-once");
  });

  console.log(`\nall ${passed} integration scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
