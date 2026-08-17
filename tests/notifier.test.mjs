// tests/notifier.test.mjs — unit tests for lib/notifier.js (macOS system
// notifications) with an injected fake exec/probe: no real osascript runs.
//
// Run: node tests/notifier.test.mjs

import assert from "node:assert/strict";
import {
  createSystemNotifier,
  appleEscapeString,
  osascriptArgs,
  terminalNotifierArgs,
  createBackendProbe
} from "../lib/notifier.js";

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
  // 1. AppleScript string escaping.
  await scenario("appleEscapeString escapes quotes and backslashes", () => {
    assert.equal(appleEscapeString("plain"), '"plain"');
    assert.equal(appleEscapeString('say "hi"'), '"say \\"hi\\""');
    assert.equal(appleEscapeString("back\\slash"), '"back\\\\slash"');
  });

  // 2. osascriptArgs builds the display notification script.
  await scenario("osascriptArgs builds display notification", () => {
    const [flag, body] = osascriptArgs("标题", "需要权限审批：写文件", false);
    assert.equal(flag, "-e");
    assert.match(body, /^display notification "需要权限审批：写文件" with title "标题"$/);
    const [, soundBody] = osascriptArgs("t", "m", true);
    assert.match(soundBody, /sound name "Glass"/);
  });

  // 3. terminalNotifierArgs.
  await scenario("terminalNotifierArgs builds args", () => {
    assert.deepEqual(terminalNotifierArgs("t", "m", false), ["-title", "t", "-message", "m"]);
    assert.deepEqual(terminalNotifierArgs("t", "m", true), ["-title", "t", "-message", "m", "-sound", "default"]);
  });

  // 4. Explicit osascript backend uses osascript.
  await scenario("explicit osascript backend", async () => {
    const calls = [];
    const notify = createSystemNotifier({
      backend: "osascript",
      exec: async (command, args) => { calls.push([command, args]); return {}; }
    });
    const result = await notify("t", "m");
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "osascript");
    assert.match(calls[0][1].join(" "), /display notification "m" with title "t"/);
  });

  // 5. Explicit terminal-notifier backend (even if not installed on PATH — fake exec).
  await scenario("explicit terminal-notifier backend", async () => {
    const calls = [];
    const notify = createSystemNotifier({
      backend: "terminal-notifier",
      exec: async (command, args) => { calls.push([command, args]); return {}; }
    });
    const result = await notify("t", "m");
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ["terminal-notifier", ["-title", "t", "-message", "m"]]);
  });

  // 6. auto backend: probe says terminal-notifier missing → osascript fallback.
  await scenario("auto backend falls back to osascript", async () => {
    const calls = [];
    const notify = createSystemNotifier({
      backend: "auto",
      probe: async () => false,
      exec: async (command, args) => { calls.push([command, args]); return {}; }
    });
    await notify("t", "m");
    await notify("t2", "m2"); // second call reuses the cached probe
    assert.equal(calls.length, 2);
    assert.ok(calls.every(([command]) => command === "osascript"));
  });

  // 7. auto backend prefers terminal-notifier when present.
  await scenario("auto backend prefers terminal-notifier", async () => {
    const calls = [];
    const notify = createSystemNotifier({
      backend: "auto",
      probe: async () => true,
      exec: async (command, args) => { calls.push([command, args]); return {}; }
    });
    await notify("t", "m");
    assert.equal(calls[0][0], "terminal-notifier");
  });

  // 8. Exec failure → { ok: false } with the error, never throws.
  await scenario("exec failure is contained", async () => {
    const notify = createSystemNotifier({
      backend: "osascript",
      exec: async () => { throw new Error("osascript missing"); }
    });
    const result = await notify("t", "m");
    assert.equal(result.ok, false);
    assert.match(result.error.message, /osascript missing/);
  });

  // 9. createBackendProbe caches.
  await scenario("backend probe caches its result", async () => {
    let probes = 0;
    const has = createBackendProbe(async () => { probes += 1; return true; });
    assert.equal(await has("terminal-notifier"), true);
    assert.equal(await has("terminal-notifier"), true);
    assert.equal(probes, 1);
  });

  console.log(`\nall ${passed} notifier scenarios passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
