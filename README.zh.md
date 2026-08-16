# dsh-approval-sentinel — 帮我批准

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**DeepSeek Harness 的「帮我批准」：当一条权限审批长时间无人回应时，由一个新拉起的风险评估 agent 审查请求——低风险操作自动放行，有风险的操作标记出来交给你本人决定（它永远不会自动拒绝）。**

[English](README.md) | 中文

## 为什么需要它

DeepSeek Harness 的 agent 需要升级沙箱权限（写工作区外文件、完全访问等）时，Web 界面会弹出审批对话框并一直等待人工点击。如果你不在电脑前、或者没注意到弹窗，操作就会无限期卡住；若没有任何回答者（headless），则直接失败关闭。

本插件提供一个**「宽限 → 审查」的兜底**，与 [Codex 的 `approvals_reviewer=auto_review`](https://github.com/openai/codex) 思路一致：

1. 正常审批对话框照常弹出，你有**宽限期**（默认 120 秒）点击「批准 / 拒绝」——你的决定永远优先；
2. 宽限超时（或根本没有任何人工通道——headless）后，插件拉一个**全新的风险评估 agent**：零对话上下文、无工具、结构化输出。它能看到具体请求和 agent 的近期活动（含实际工具参数），返回 `allow` / `reject` / `wait`；
3. **只有 `allow` 会自动放行。** `reject`、`wait` 或评审失败都**绝不会被自动决定**：插件通知会话并让审批弹窗**一直等待你本人评估和操作**——子 agent 可以标记风险，但只有你能拒绝；
4. 每次自动决定都会写入审批审计日志（`approval/asked` + `approval/decided`），并向会话注入一条可见消息。

## 与 [dsh-approval-llm](https://github.com/Letter2025/dsh-approval-llm) 的差异

两者都是 codex「帮我批准」在 DSH 的实现，但设计互补：

| | dsh-approval-llm | **dsh-approval-sentinel（本插件）** |
| --- | --- | --- |
| 触发方式 | **模式开关**：选择「帮我批准」权限预设后，独立的评审**模型**先裁决每一个请求（模型优先、人工其次）。 | **超时兜底**：人工对话框优先；只有长期无人回应（或无回答者）时评审才介入。 |
| 评审形态 | 一次独立的 reviewer **模型调用**。 | **全新 subagent**（`subagent-spawn-in-process`）——零父上下文、无工具、结构化输出，最接近 codex 的 guardian subagent。 |
| 拿不准 | `ESCALATE` → 立即转人工。 | `reject`/`wait` → **绝不自动决定**：弹窗一直等待你本人（只有 `allow` 自动放行）。 |
| Headless | 无人工回答者时失败关闭。 | 直接审查 headless 请求（可加 `headlessGraceMs`）。 |

想要「所有审批都由模型先过一遍」→ 用 dsh-approval-llm；想要「先问人、人不在才审查」→ 用本插件。

> **警告**：AI 评审是策略选择，不是安全保证。它可能被提示注入或 agent 的说明文字误导。请收紧 `denyPatterns`、定期查看审计日志，并优先用于低风险场景。

## 安装

> **给 AI agent 的复制即用指令**：「阅读 https://github.com/Dongfang81/dsh-approval-sentinel 的 `## Install` 部分，把 `dsh-approval-sentinel` 装进 DeepSeek Harness web profile，重启 `dsh web`，并验证一条无人回应的审批会自动走风险评估。」

```sh
# 发布到 npm 后：
dsh plugin --profile web add dsh-approval-sentinel

# 或本地目录：
dsh plugin --profile web add ./dsh-approval-sentinel
```

重启 `dsh web` 即生效。无需额外点击——它只在审批无人回应（或会话没有审批回答者）时才介入。

## 配置

可在 Web 设置面板（命名空间 `approval-sentinel`）、`$DSH_HOME/settings.yaml` 或 profile 的 `cordis.patch.yml` 行配置中修改：

```yaml
- id: approval-sentinel
  config:
    graceMs: 120000
    assessorModel: deepseek-v4-flash
    denyPatterns:
      - "rm\\s+-rf\\s+/"
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时全部转交人工通道。 |
| `graceMs` | `120000` | 等待人工回应的宽限期（毫秒）。 |
| `headlessGraceMs` | `0` | 无人工回答者时，审查前的额外等待（毫秒）。 |
| `assessTimeoutMs` | `90000` | 单次评审的截止时间（毫秒）。 |
| `maxConcurrentAssessments` | `3` | 并发评审 agent 上限（超出排队）。 |
| `assessorModel` / `assessorProvider` | *继承请求 agent 的路线* | 评审模型的显式覆盖。 |
| `denyPatterns` | 破坏性操作默认集 | 确定性危险正则：命中**不是自动拒绝**，而是转交你本人（不调用模型）。 |
| `denyPatterns` | 破坏性操作默认集 | 确定性快速拒绝正则，先于任何模型调用检查。 |
| `allowPatterns` | `[]` | 确定性快速放行正则（deny 仍优先）。 |
| `notifyUser` | `true` | 向会话注入可见的决策通知。 |
| `verbose` | `true` | 额外 info 级日志。 |

## 工作原理

```
approval/request（waterfall 钩子）
   │
   ├─ enabled? no ──────────────────────────────► next()（原样转交）
   ├─ denyPatterns 命中 ────────────────────────► 转交人工：通知 + 等你本人决定
   ├─ allowPatterns 命中 ───────────────────────► 'allowed-once'
   ├─ 启动人工通道（next()）并与宽限计时器赛跑
   │    ├─ 人工在宽限内回应 ──────────────────────► 以人工决定为准
   │    ├─ 无回答者（'unavailable'）──────────────► headless 审查（可加 headlessGraceMs）
   │    └─ 宽限超时 ─────────────────────────────► 全新风险评估 subagent（仅一次）
   │         ├─ allow ──────────────────────────► 'allowed-once'（自动放行）
   │         └─ reject / wait / 评审失败 ────────► 通知 + 弹窗一直等待你本人决定
   │                                               （绝不自动拒绝）
   │
   └─ 每次自动决定都会被审计（approval/asked + approval/decided）
      并向会话注入一条消息
```

评审 subagent 通过 `ctx.subagents` 的 `spawn` 系提供者（全新 agent，`inheritsParentContext: false`）拉起，限制为**无工具**（`toolFilter: { allow: [] }`），必须通过结构化输出工具返回结论。其提示词把请求视为不可信数据，并指示它对破坏性、不可逆或工作区外的操作优先选择 `wait`/`reject`——因为 `reject`/`wait` 只会把决定权交还给你，绝不会被当作自动拒绝执行。

## 开发

```sh
pnpm test   # 18 个引擎场景 + 5 个接线冒烟测试（无需完整 harness）
```

- `lib/core.js` — 纯决策引擎（无 cordis 依赖，完整单测）。
- `lib/index.js` — cordis 适配层：prepend `approval/request` 监听器、`ctx.subagents` 拉起、设置接线、会话通知。

## License

MIT
