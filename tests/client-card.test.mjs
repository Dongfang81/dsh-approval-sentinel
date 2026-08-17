// tests/client-card.test.mjs — smoke-test the browser-half settings page
// (lib/client.js) with a stubbed ModuleLoader / require / fetch. No real
// browser or React runtime: verifies the page registers as a top-level
// settings.section, loads the config through GET /dsh-approval-sentinel/config,
// renders the field catalog, and writes through POST.
//
// Run: node tests/client-card.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(path.join(dir, "../lib/client.js"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- stubs ----------------------------------------------------------------
/** 共享 hooks 状态：按渲染重置 batch，跨渲染复用 cell（近似 React useState）。 */
const hooks = { cells: [], batch: 0 };
function makeRequire() {
  const jsxStub = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return (name) => {
    if (name === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxStub, Fragment: "fragment" };
    if (name === "react") {
      return {
        useState: (initial) => {
          const index = hooks.batch++;
          if (hooks.cells[index] === undefined) hooks.cells[index] = { value: initial };
          return [
            hooks.cells[index].value,
            (next) => { hooks.cells[index].value = typeof next === "function" ? next(hooks.cells[index].value) : next; }
          ];
        },
        // 执行副作用（reload 会发 fetch；微任务后 setState → 下一次渲染读到 ready）
        useEffect: (fn) => { fn(); }
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
}

let lastExport;
const windowStub = { __ModuleLoader__: { load: (spec) => { lastExport = spec.factory(makeRequire()); } } };
globalThis.window = windowStub;

new Function("window", clientSource)(windowStub);
assert.ok(lastExport, "client bundle must export something");
assert.equal(typeof lastExport.apply, "function", "apply must be a function");
assert.ok(Array.isArray(lastExport.inject), "inject must be an array");

/** 渲染组件（重置 batch；hooks.cells 跨渲染保留）。 */
function renderComponent(component) {
  hooks.batch = 0;
  return component({});
}

/** 递归找第一个 type==='button' 或 checkbox 的 jsx 节点（展开嵌套数组）。 */
function findByType(node, type) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found !== void 0) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  if (node.type === type) return node;
  const kids = (Array.isArray(node.children) && node.children.length > 0)
    ? node.children
    : Array.isArray(node.props?.children) ? node.props.children : [];
  for (const child of kids) {
    const found = findByType(child, type);
    if (found !== void 0) return found;
  }
  return undefined;
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
  // 1. apply 注册顶层 settings.section 菜单。
  await scenario("apply registers settings.section menu item", () => {
    const registrations = [];
    const ctx = {
      effect: (fn) => { fn(); return () => {}; },
      slots: {
        inject: (name, registerFn) => registerFn(),
        register: (options, component) => { registrations.push({ options, component }); return () => {}; }
      }
    };
    lastExport.apply(ctx);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.name, "settings.section");
    assert.equal(registrations[0].options.id, "approval-sentinel");
    assert.equal(typeof registrations[0].options.label, "function");
    assert.equal(registrations[0].options.label(), "帮我批准");
  });

  // 2. 页面通过 GET /config 加载并渲染字段；改动通过 POST /config 提交。
  await scenario("page loads via GET and writes via POST", async () => {
    const fetches = [];
    let serverValue = { enabled: true, graceMs: 120000, notifyTurnComplete: false, allowRules: [] };
    const baseValue = { enabled: true, graceMs: 120000, notifyTurnComplete: false, allowRules: [] };
    globalThis.fetch = async (url, options) => {
      fetches.push({ url, method: options?.method ?? "GET", body: options?.body });
      if (options?.method === "POST") {
        const patch = JSON.parse(options.body);
        serverValue = { ...serverValue, ...patch };
      }
      return { ok: true, json: async () => ({ ok: true, value: serverValue, base: baseValue }) };
    };

    const registrations = [];
    const ctx = {
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (name, registerFn) => registerFn(), register: (options, component) => { registrations.push({ options, component }); return () => {}; } }
    };
    lastExport.apply(ctx);
    const Page = registrations[0].component;

    // 首次渲染触发 useEffect → fetch GET → 异步 setState → 再渲染读到 ready。
    let tree = renderComponent(Page);
    assert.match(JSON.stringify(tree), /加载中/);
    await sleep(10);
    tree = renderComponent(Page);
    const text = JSON.stringify(tree);
    assert.match(text, /帮我批准/);
    assert.match(text, /轮次完成通知/);
    assert.match(text, /权限审批通知/);
    assert.match(text, /提问通知/);
    assert.match(text, /始终允许规则/);
    assert.match(text, /宽限期/);
    assert.equal(fetches[0].url, "/dsh-approval-sentinel/config");
    assert.equal(fetches[0].method, "GET");

  });

  // 3. 加载失败时显示错误与重试。
  await scenario("load failure shows an error", async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: "boom" }) });
    const registrations = [];
    const ctx = {
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (name, registerFn) => registerFn(), register: (options, component) => { registrations.push({ options, component }); return () => {}; } }
    };
    lastExport.apply(ctx);
    const Page = registrations[0].component;
    let tree = renderComponent(Page);
    await sleep(10);
    tree = renderComponent(Page);
    assert.match(JSON.stringify(tree), /配置加载失败/);
    assert.match(JSON.stringify(tree), /重试/);
  });

  console.log(`\nall ${passed} client-card scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
