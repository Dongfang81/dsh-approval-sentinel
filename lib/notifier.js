// notifier.js — macOS system notifications for dsh-approval-sentinel.
//
// Two backends:
//   - "osascript": built into macOS (`display notification` via Notification
//     Center). No extra install needed.
//   - "terminal-notifier": nicer (click-through support); used when available
//     and `backend: "auto"` (the default) or explicitly selected.
//
// The exec function is injectable for tests; the default shells out to
// child_process with argument arrays (no shell interpolation).

import { execFile as nodeExecFile } from "node:child_process";

/** Escape a plain string as an AppleScript double-quoted literal. */
export function appleEscapeString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Build the osascript argument vector for one notification. */
export function osascriptArgs(title, message, sound) {
  const body = `display notification ${appleEscapeString(message)} with title ${appleEscapeString(title)}${sound ? ' sound name "Glass"' : ""}`;
  return ["-e", body];
}

/** Build the terminal-notifier argument vector for one notification. */
export function terminalNotifierArgs(title, message, sound) {
  const args = ["-title", String(title), "-message", String(message)];
  if (sound) args.push("-sound", "default");
  return args;
}

/**
 * Probe whether a binary exists on PATH (cached).
 * @param {string} command
 * @param {(command: string) => Promise<boolean>} probe - injectable `which`-style probe.
 */
export function createBackendProbe(probe) {
  let cached = void 0;
  return async function hasBackend(command) {
    if (cached === void 0) {
      try {
        cached = await probe(command);
      } catch {
        cached = false;
      }
    }
    return cached;
  };
}

/**
 * Create a system-notification sender.
 * @param {object} [options]
 * @param {"auto"|"osascript"|"terminal-notifier"} [options.backend] - `auto` prefers terminal-notifier, falls back to osascript.
 * @param {boolean} [options.sound]
 * @param {(command: string, args: string[]) => Promise<{ code?: number, stderr?: string }>} [options.exec] - injectable execFile; default uses node's execFile.
 * @param {(command: string) => Promise<boolean>} [options.probe] - injectable `which` probe (default: node `which` via execFile).
 * @returns {(title: string, message: string) => Promise<{ ok: boolean, error?: unknown }>}
 */
export function createSystemNotifier(options = {}) {
  const { backend = "auto", sound = false } = options;
  const exec = options.exec ?? ((command, args) => new Promise((resolve, reject) => {
    nodeExecFile(command, args, (error, stdout, stderr) => {
      if (error !== null && error !== void 0) reject(error);
      else resolve({ stdout, stderr });
    });
  }));
  const has = createBackendProbe(options.probe ?? (async (command) => {
    try {
      await new Promise((resolve, reject) => {
        nodeExecFile("/usr/bin/which", [command], (error) => {
          if (error !== null && error !== void 0) reject(error);
          else resolve();
        });
      });
      return true;
    } catch {
      return false;
    }
  }));

  return async function sendNotification(title, message) {
    const resolvedBackend = backend === "auto"
      ? (await has("terminal-notifier") ? "terminal-notifier" : "osascript")
      : backend;
    try {
      if (resolvedBackend === "terminal-notifier") {
        await exec("terminal-notifier", terminalNotifierArgs(title, message, sound));
      } else {
        await exec("osascript", osascriptArgs(title, message, sound));
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };
}
