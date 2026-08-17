// tests/integration.mjs — smoke-test the cordis adapter (lib/index.js) with a
// minimal fake ctx: no real cordis, no real subagent — just enough surface to
// prove the wiring (prepend listener, assessor spawn arguments, notice
// injection, settings-absent behavior).
//
// Run: node tests/integration.mjs

import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function makeCtx({ services = {}, listeners = [], injected = [], settings = null } = {}) {
  const updates = [];
  return {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    get: (name) => services[name],
    inject: (deps, callback) => {
      if (settings !== null && Array.isArray(deps) && deps.includes("settings")) {
        // minimal settings service: register returns an owner scope whose
        // get() decodes base + user section through the schema (defaults fill in)
        let registerOptions = {};
        const scope = {
          get: () => registerOptions.schema({ ...registerOptions.base, ...settings.section }),
          update: async (patch) => {
            updates.push(patch);
            settings.section = { ...settings.section, ...patch };
          },
          watch: () => () => {}
        };
        const sctx = {
          settings: { register: (ns, schema, options) => {
            registerOptions = { schema, base: options?.base };
            return scope;
          } },
          effect: () => () => {}
        };
        callback(sctx);
      }
      return () => {};
    },
    on: (name, listener, options) => {
      listeners.push({ name, listener, options });
      return () => {};
    },
    effect: () => () => {},
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/work" }) },
    _services: services,
    _listeners: listeners,
    _injected: injected,
    _settingsUpdates: updates
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
  // 1. Listeners: approval/request prepended, session/event observer.
  await scenario("registers listeners (approval prepend + session observer)", () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const approval = ctx._listeners.find((entry) => entry.name === "approval/request");
    const sessionEvent = ctx._listeners.find((entry) => entry.name === "session/event");
    assert.ok(approval, "approval/request listener must be registered");
    assert.equal(approval.options, true, "approval/request must prepend (outermost in the waterfall)");
    assert.ok(sessionEvent, "session/event listener must be registered");
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
    const listener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
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
    assert.match(injected[0].content[0].text, /已自动放行/);
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
    const listener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
    const outcome = await listener(makeReq(agent), () => Promise.resolve("rejected"));
    assert.equal(outcome, "rejected");
    assert.equal(started, 0);
    assert.equal(injected.length, 0, "a human decision needs no sentinel notice");
  });

  // 4. Assessor returns reject → NOT an auto-denial: notify and keep waiting for the user.
  await scenario("assessor reject → pending-human → user decides", async () => {
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
    const listener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
    // The user comes back later and rejects it themselves.
    const outcome = await listener(makeReq(agent), () => new Promise((resolve) => setTimeout(() => resolve("rejected"), 70)));
    assert.equal(outcome, "rejected"); // the USER's rejection
    assert.match(injected[0].content[0].text, /已交由你本人决定/);
    assert.match(injected[0].content[0].text, /审批弹窗保持等待/);
  });

  // 5. No subagents service → contained failure → handed to human → human decides.
  await scenario("no subagents service → assessor error → human decides", async () => {
    const ctx = makeCtx({ services: {} }); // no subagents at all
    apply(ctx, { graceMs: 30 });
    const listener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
    // Grace (30ms) expires, assessor throws, the flow keeps waiting; the user answers at 60ms.
    const outcome = await listener(makeReq(makeAgent([])), () => new Promise((resolve) => setTimeout(() => resolve("allowed-once"), 60)));
    assert.equal(outcome, "allowed-once");
  });

  // 6. Assessor allow → the notice suggests the "始终允许" interaction.
  await scenario("assessor allow → notice suggests always-allow", async () => {
    const injected = [];
    const agent = makeAgent(injected);
    const ctx = makeCtx({
      services: {
        subagents: {
          list: () => ["spawn"],
          getProvider: (name) => ({ name, inheritsParentContext: false }),
          start: async () => ({
            id: "child-3",
            result: Promise.resolve({
              output: [],
              structured: { verdict: "allow", riskLevel: "low", rationale: "in-workspace npm install" },
              stopReason: "completed"
            }),
            dispose: async () => {}
          })
        }
      },
      injected
    });
    apply(ctx, { graceMs: 30 });
    const listener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
    await listener(makeReq(agent), () => new Promise(() => {}));
    assert.ok(injected.length >= 1);
    assert.match(injected[0].content[0].text, /回复：始终允许/);
    assert.match(injected[0].content[0].text, /已自动放行/);
  });

  // 7. User replies "始终允许" after an auto-approval → rule persisted via settings.
  await scenario("reply 始终允许 persists an allow rule", async () => {
    const injected = [];
    const agent = makeAgent(injected);
    const settings = { base: {}, section: {} };
    const ctx = makeCtx({
      settings,
      services: {
        subagents: {
          list: () => ["spawn"],
          getProvider: (name) => ({ name, inheritsParentContext: false }),
          start: async () => ({
            id: "child-4",
            result: Promise.resolve({
              output: [],
              structured: { verdict: "allow", riskLevel: "low", rationale: "safe" },
              stopReason: "completed"
            }),
            dispose: async () => {}
          })
        },
        agents: { get: (id) => agent }
      },
      injected
    });
    apply(ctx, { graceMs: 30 });
    const req = makeReq(agent);
    const approvalListener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
    await approvalListener(req, () => new Promise(() => {})); // grace expiry → assessor allow

    // Now the user replies "始终允许" in the same session.
    const eventListener = ctx._listeners.find((entry) => entry.name === "session/event").listener;
    const session = { id: "s1" };
    eventListener(session, { type: "user/message", data: { role: "user", content: [{ type: "text", text: "始终允许" }] } });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the async addAlwaysRule settle

    assert.equal(ctx._settingsUpdates.length, 1, "settings.update must be called once");
    const rules = ctx._settingsUpdates[0].allowRules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].tool, "bash");
    assert.equal(rules[0].mode, "workspace-write");
    assert.equal(rules[0].pattern, req.reason);
    assert.match(injected.at(-1).content[0].text, /已添加「始终允许」规则/);

    // Replying again → duplicate, no second update.
    eventListener(session, { type: "user/message", data: { role: "user", content: [{ type: "text", text: "始终允许" }] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx._settingsUpdates.length, 1, "duplicate rule must not be persisted twice");
  });

  // 8. No settings service → "始终允许" reply cannot persist; announces the limitation.
  await scenario("reply 始终允许 without settings → limitation notice", async () => {
    const injected = [];
    const agent = makeAgent(injected);
    const ctx = makeCtx({
      services: {
        subagents: {
          list: () => ["spawn"],
          getProvider: (name) => ({ name, inheritsParentContext: false }),
          start: async () => ({
            id: "child-5",
            result: Promise.resolve({
              output: [],
              structured: { verdict: "allow", riskLevel: "low", rationale: "safe" },
              stopReason: "completed"
            }),
            dispose: async () => {}
          })
        },
        agents: { get: (id) => agent }
      },
      injected
    });
    apply(ctx, { graceMs: 30 });
    await ctx._listeners.find((entry) => entry.name === "approval/request").listener(makeReq(agent), () => new Promise(() => {}));
    const eventListener = ctx._listeners.find((entry) => entry.name === "session/event").listener;
    eventListener({ id: "s1" }, { type: "user/message", data: { role: "user", content: [{ type: "text", text: "始终允许" }] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(injected.at(-1).content[0].text, /无法持久化/);
  });

  // 9. Turn-complete system notification fires on turn/end when enabled.
  await scenario("turn/end → turn-complete notification", async () => {
    const calls = [];
    const ctx = makeCtx();
    const hooks = apply(ctx, { notifyTurnComplete: true, notifyMinIntervalMs: 0 });
    hooks.notifierState.impl = async (title, message) => { calls.push({ title, message }); return { ok: true }; };
    const eventListener = ctx._listeners.find((entry) => entry.name === "session/event").listener;
    eventListener({ id: "s1" }, { type: "turn/end", data: { turn: 1, reason: "completed" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.match(calls[0].title, /轮次完成/);
  });

  // 10. Question notification fires when the agent calls ask_user_question.
  await scenario("ask_user_question → needs-input notification", async () => {
    const calls = [];
    const ctx = makeCtx();
    const hooks = apply(ctx, { notifyQuestion: true, notifyMinIntervalMs: 0 });
    hooks.notifierState.impl = async (title, message) => { calls.push({ title, message }); return { ok: true }; };
    const eventListener = ctx._listeners.find((entry) => entry.name === "session/event").listener;
    eventListener({ id: "s1" }, {
      type: "assistant/message",
      data: { message: { role: "assistant", content: [
        { type: "tool-call", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q1", question: "继续执行吗？" }] }) }
      ] } }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.match(calls[0].title, /需要你的输入/);
    assert.match(calls[0].message, /继续执行吗？/);
  });

  // 11. Permission notification fires when an approval request arrives.
  await scenario("approval request → permission notification", async () => {
    const calls = [];
    const agent = makeAgent([]);
    const ctx = makeCtx({ services: { subagents: { list: () => ["spawn"], getProvider: (n) => ({ name: n, inheritsParentContext: false }) } } });
    const hooks = apply(ctx, { notifyPermissionRequest: true, notifyMinIntervalMs: 0 });
    hooks.notifierState.impl = async (title, message) => { calls.push({ title, message }); return { ok: true }; };
    const listener = ctx._listeners.find((entry) => entry.name === "approval/request").listener;
    listener(makeReq(agent), () => new Promise(() => {})); // fire-and-forget
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.match(calls[0].title, /需要权限审批/);
    assert.match(calls[0].message, /run npm install/);
  });

  // 12. Switch off / throttle: no (second) notification.
  await scenario("notification switch off and throttle", async () => {
    const calls = [];
    // switch off
    const ctxOff = makeCtx();
    const hooksOff = apply(ctxOff, { notifyTurnComplete: false, notifyMinIntervalMs: 0 });
    hooksOff.notifierState.impl = async (title, message) => { calls.push({ title, message }); return { ok: true }; };
    ctxOff._listeners.find((entry) => entry.name === "session/event").listener({ id: "s1" }, { type: "turn/end", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0, "disabled switch must not notify");
    // throttle: two turn/end within the interval → one notification
    const calls2 = [];
    const ctx = makeCtx();
    const hooks = apply(ctx, { notifyTurnComplete: true, notifyMinIntervalMs: 60000 });
    hooks.notifierState.impl = async (title, message) => { calls2.push({ title, message }); return { ok: true }; };
    const eventListener = ctx._listeners.find((entry) => entry.name === "session/event").listener;
    eventListener({ id: "s1" }, { type: "turn/end", data: {} });
    eventListener({ id: "s1" }, { type: "turn/end", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls2.length, 1, "second turn/end inside the interval must be throttled");
  });

  console.log(`\nall ${passed} integration scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
