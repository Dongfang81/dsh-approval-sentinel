// tests/client-card.test.mjs — smoke-test the browser-half settings card
// (lib/client.js) with a stubbed ModuleLoader / require / ctx. No real
// browser or React runtime: verifies the card registers into the
// settings.plugin.item slot, the scope controller injects working
// set/unset, and the component renders the field catalog without throwing.
//
// Run: node tests/client-card.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(path.join(dir, "../lib/client.js"), "utf8");

// --- stubs ----------------------------------------------------------------
function makeRequire() {
  const jsxStub = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const jsxsStub = jsxStub;
  return (name) => {
    if (name === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxsStub, Fragment: "fragment" };
    if (name === "react") {
      return {
        // open=false (the card's disclosure state) is forced to true so the
        // field catalog renders; draft strings keep their initial value.
        useState: (initial) => [typeof initial === "boolean" ? true : initial, () => {}],
        useEffect: () => {}
      };
    }
    if (name === "@deepseek-ai/dsh-client-runtime/client") {
      return {
        createSnapshotStore: (initial) => {
          let value = typeof initial === "function" ? initial() : initial;
          return {
            getSnapshot: () => value,
            set: (next) => { value = next; },
            subscribe: () => () => {}
          };
        }
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
}

let lastExport;
const windowStub = {
  __ModuleLoader__: {
    load: (spec) => {
      lastExport = spec.factory(makeRequire());
    }
  }
};
globalThis.window = windowStub;

// --- load the client bundle ----------------------------------------------
new Function("window", clientSource)(windowStub);
assert.ok(lastExport, "client bundle must export something");
assert.equal(typeof lastExport.apply, "function", "apply must be a function");
assert.ok(Array.isArray(lastExport.inject), "inject must be an array");

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
  // 1. apply registers a top-level settings.section (Settings → 帮我批准).
  await scenario("apply registers settings.section menu item", () => {
    const registrations = [];
    const disposers = [];
    const writes = [];
    const scope = {
      getSnapshot: () => ({
        status: "ready",
        writable: true,
        value: { enabled: true, graceMs: 120000, notifyTurnComplete: false, allowRules: [] },
        base: { enabled: true, graceMs: 120000 }
      }),
      subscribe: () => () => {},
      set: (field, value) => writes.push(["set", field, value]),
      unset: (field) => writes.push(["unset", field])
    };
    const ctx = {
      effect: (fn) => { disposers.push(fn()); return () => {}; },
      settingsScope: { bind: (spec) => { assert.equal(spec.namespace, "approval-sentinel"); return scope; } },
      slots: {
        inject: (name, registerFn) => registerFn(),
        register: (options, component) => {
          registrations.push({ options, component });
          return () => {};
        }
      }
    };
    lastExport.apply(ctx);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.name, "settings.section");
    assert.equal(registrations[0].options.id, "approval-sentinel");
    assert.equal(typeof registrations[0].options.label, "function");
    assert.equal(registrations[0].options.label(), "帮我批准");
    assert.equal(typeof registrations[0].component, "function");

    // 2. The controller injects a store + working set/unset.
    const injected = registrations[0].options.inject();
    assert.equal(typeof injected.hooks.sentinelSettings.getSnapshot, "function");
    injected.set("graceMs", 5000);
    injected.unset("graceMs");
    assert.deepEqual(writes, [["set", "graceMs", 5000], ["unset", "graceMs"]]);

    // 3. The page component renders the field catalog without throwing.
    const Page = registrations[0].component;
    const tree = Page({
      t: (k) => k,
      useSentinelSettings: (selector) => selector(injected.hooks.sentinelSettings.getSnapshot()),
      set: injected.set,
      unset: injected.unset
    });
    const text = JSON.stringify(tree);
    assert.match(text, /帮我批准/);
    assert.match(text, /轮次完成通知/);
    assert.match(text, /权限审批通知/);
    assert.match(text, /提问通知/);
    assert.match(text, /始终允许规则/);
    assert.match(text, /宽限期/);
  });

  // 4. Page renders nothing when the namespace is unavailable.
  await scenario("page hides when namespace unavailable", () => {
    const registrations = [];
    const scope = {
      getSnapshot: () => ({ status: "unavailable", writable: false, value: undefined, base: undefined }),
      subscribe: () => () => {},
      set: () => {}, unset: () => {}
    };
    const ctx = {
      effect: (fn) => { fn(); return () => {}; },
      settingsScope: { bind: () => scope },
      slots: {
        inject: (name, registerFn) => registerFn(),
        register: (options, component) => { registrations.push({ options, component }); return () => {}; }
      }
    };
    lastExport.apply(ctx);
    const injected = registrations[0].options.inject();
    const tree = registrations[0].component({
      t: (k) => k,
      useSentinelSettings: (selector) => selector(injected.hooks.sentinelSettings.getSnapshot()),
      set: () => {}, unset: () => {}
    });
    assert.equal(tree, null, "unavailable namespace renders nothing");
  });

  console.log(`\nall ${passed} client-card scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
