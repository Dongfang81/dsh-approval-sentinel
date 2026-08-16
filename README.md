# dsh-approval-sentinel — 帮我批准

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**帮我批准 (approve-for-me) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): when a permission approval goes unanswered, a fresh risk-assessment agent reviews the request — auto-approving low-risk operations, and flagging anything risky for YOU to decide (it never auto-denies).**

English | [中文](README.zh.md)

## Why

When a DeepSeek Harness agent needs to escalate sandbox permissions (write outside the workspace, full access, etc.), the Web UI pops an approval dialog and waits for a human click. If you are away from the computer — or simply miss the prompt — the operation stalls forever, or fails closed if no answerer is composed.

This plugin adds a **grace-then-review** fallback, the same spirit as [Codex's `approvals_reviewer=auto_review`](https://github.com/openai/codex):

1. The normal approval dialog still appears first, and you have a **grace window** (default 120 s) to click Allow / Deny — your decision always wins.
2. If the window expires (or there is no human channel at all — headless), the plugin spawns a **fresh risk-assessment agent**: zero conversation context, no tools, structured output. It sees the exact request and the agent's recent activity (including the actual tool arguments), and returns `allow` / `reject` / `wait`.
3. **Only `allow` auto-approves.** `reject`, `wait`, or an assessor failure are NEVER auto-decided: the plugin notifies the session and keeps the approval dialog waiting until **you** evaluate and act — the subagent can flag risk, but only you can deny.
4. Every auto-decision is recorded in the approval audit log (`approval/asked` + `approval/decided`) and announced as a user-visible message in the session.

## How it differs from [dsh-approval-llm](https://github.com/Letter2025/dsh-approval-llm)

Both are DSH equivalents of Codex "帮我批准", but they are complementary designs:

| | dsh-approval-llm | **dsh-approval-sentinel (this)** |
| --- | --- | --- |
| Trigger | A **mode switch**: pick the `帮我批准` permission preset and a separate reviewer **model** answers every ask (model first, human second). | A **timeout fallback**: the human dialog comes first; only when it goes unanswered (or no answerer exists) does the reviewer step in. |
| Reviewer | A separate **reviewer model call**. | A **fresh subagent** (`subagent-spawn-in-process`) — zero parent context, tool-less, structured-output verdict — the closest DSH equivalent of Codex's guardian subagent. |
| Uncertainty | `ESCALATE` → hands to the human immediately. | `reject`/`wait` → NEVER auto-decided: the dialog keeps waiting for you (only `allow` auto-approves). |
| Headless | Fails closed when no human answerer is composed. | Reviews headless asks directly (optionally after `headlessGraceMs`). |

If you want "always reviewed by the model" semantics, use dsh-approval-llm. If you want "ask the human first, review only when they're away", use this plugin.

> **Warning**: an AI reviewer is a policy choice, not a security guarantee. It can be fooled by prompt injection or by the agent's own justification. Keep `denyPatterns` tight, review the audit log, and prefer this for low-risk workflows.

## Install

> **Copy-paste for an AI agent**: "Read https://github.com/Dongfang81/dsh-approval-sentinel and follow its `## Install` section to install the `dsh-approval-sentinel` bundle into the DeepSeek Harness web profile, restart the `dsh web` server, and verify an unanswered approval auto-reviews."

```sh
# published package (once released to npm)
dsh plugin --profile web add dsh-approval-sentinel

# or a local checkout
dsh plugin --profile web add ./dsh-approval-sentinel
```

Restart `dsh web`, and the sentinel is active. Nothing to click — it only engages when an approval goes unanswered (or when the session has no approval answerer).

## Configuration

Editable live from the Web UI settings panel (namespace `approval-sentinel`) or via `$DSH_HOME/settings.yaml`, or as row config in your profile's `cordis.patch.yml`:

```yaml
- id: approval-sentinel
  config:
    graceMs: 120000
    assessorModel: deepseek-v4-flash
    denyPatterns:
      - "rm\\s+-rf\\s+/"
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` delegates everything to the human channel. |
| `graceMs` | `120000` | How long to wait for the human before the assessor steps in (ms). |
| `headlessGraceMs` | `0` | Extra wait before reviewing when there is no human answerer at all (ms). |
| `assessTimeoutMs` | `90000` | Deadline for one assessor run (ms). |
| `maxConcurrentAssessments` | `3` | Cap on concurrently running assessor agents (extra requests queue). |
| `assessorModel` / `assessorProvider` | *(inherit the requesting agent's route)* | Explicit reviewer model/provider override. |
| `denyPatterns` | destructive defaults | Deterministic danger regexes: a hit is NOT an auto-denial — the request is handed to you (no model call). |
| `allowPatterns` | `[]` | Deterministic quick-allow regexes (a deny hit still wins and goes to you). |
| `notifyUser` | `true` | Inject a user-visible decision notice into the session. |
| `verbose` | `true` | Extra info-level logging. |

## How it works

```
approval/request (waterfall)
   │
   ├─ enabled? no ──────────────────────────────► next() (unchanged)
   ├─ denyPatterns hit ─────────────────────────► pending-human: notify + wait for YOU
   ├─ allowPatterns hit ────────────────────────► 'allowed-once'
   ├─ start the human channel (next()) and race a grace timer
   │    ├─ human answers in time ───────────────► their outcome wins
   │    ├─ no answerer ('unavailable') ─────────► headless review (after headlessGraceMs)
   │    └─ grace expires ───────────────────────► fresh risk-assessment subagent (once)
   │         ├─ allow ──────────────────────────► 'allowed-once' (auto-approve)
   │         └─ reject / wait / error ──────────► notify + keep the dialog waiting
   │                                              until YOU decide (never auto-denies)
   │
   └─ every auto-decision is audited (approval/asked + approval/decided)
      and announced as a session message
```

The assessor subagent is spawned through `ctx.subagents` with the `spawn`-family provider (fresh agent, `inheritsParentContext: false`), restricted to **no tools** (`toolFilter: { allow: [] }`), and required to answer through the structured-output capture tool. Its prompt treats the request as untrusted data and instructs it to prefer `wait`/`reject` over `allow` for anything destructive, irreversible, or outside the workspace — knowing that `reject`/`wait` only hand the decision back to you, they are never executed as denials.

## Development

```sh
pnpm test   # 18 engine scenarios + 5 wiring smoke tests (no harness needed)
```

- `lib/core.js` — the pure decision engine (no cordis imports; fully unit-tested).
- `lib/index.js` — the cordis adapter: prepend `approval/request` listener, `ctx.subagents` spawn, settings wiring, session notices.

## License

MIT
