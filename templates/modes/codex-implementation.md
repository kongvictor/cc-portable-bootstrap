# Claude 调度 + Codex 实现模式

- 触发词：用户说“使用 Codex 实现模式”时，仅当前任务启用；说“进入 Codex 实现模式”时，后续任务持续启用，直到用户说“退出 Codex 实现模式”。
- 模式启用后，当前 Claude 保持主协调者，不切换模型、不启动 `claudex`。Claude 负责理解需求、读取上下文、拆分任务、给出验收标准、审查结果、运行最终验证和向用户汇报；实际代码实现交给 Codex。
- Codex 必须通过用户级 MCP 工具 `mcp__codex__codex` 启动。需要继续同一任务时，保存返回的 `threadId`，通过 `mcp__codex__codex-reply` 继续；不要用新的 Codex thread 重做同一任务。
- 调用 Codex 时必须传绝对 `cwd`。默认模型 `gpt-5.6-sol`，`approval-policy` 为 `never`，`config.model_reasoning_effort` 为 `xhigh`。只读调查使用 `sandbox: read-only`；实现代码使用 `sandbox: workspace-write`。禁止 `danger-full-access`。
- 用户说“使用 CodexFast 实现模式”时，仅当前任务启用；说“进入 CodexFast 实现模式”时，后续任务持续启用，直到用户说“退出 CodexFast 实现模式”。启用后所有规则均与 Codex 实现模式相同，包括模型、effort、sandbox、`approval-policy` 和 `threadId` 复用；唯一区别是每次调用 `mcp__codex__codex` 时都在 `config` 中额外传 `"service_tier": "fast"`。这是 Codex 原生 fast tier（请求值 `priority`），基础设施优先级提速约 1.5×，推理深度不变；ChatGPT 登录下 credit 约为 Standard 的 2.5×。普通 Codex 实现模式不传 `service_tier`。
- 委派提示必须包含：任务目标、允许修改范围、相关约束、验收条件、测试命令、期望输出格式，以及当前 Claude 已确认的关键上下文。不要假设 Codex 能看到 Claude 的对话历史或 tool results。
- 要求 Codex 最终简洁返回：摘要、检查或修改的文件、实现决策、测试及结果、剩余风险。不要回传完整文件或冗长日志。
- Claude 收到结果后必须检查 diff、复核关键结论并运行必要测试。发现问题时优先用原 `threadId` 要求 Codex 修正。Claude 不应重新实现 Codex 已完成的工作，也不能把 Codex 的报告未经验证地当成最终事实。
- MCP 不可用、Codex 失败或任务超时时，明确报告阻塞；不要静默改由 Claude 实现，除非用户明确授权回退。
- 多个只读 Codex 任务可并行；并发写入必须使用独立 git worktree，初始并发限制为 2–4 个，避免文件冲突。
- 长任务不会因为耗时被中断。超过 2 分钟的调用会自动转成后台任务，Claude 立即拿到 task ID 并继续其他工作，结果以通知返回——这是正常行为，不是超时；用 `/tasks` 查看进度。wall-clock 上限约 28 小时，idle 检测已通过 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` 关闭。因此调用"卡住"时不要重试或改用新 thread，先查 `/tasks` 确认它是否仍在跑。
