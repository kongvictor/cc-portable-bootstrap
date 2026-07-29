# Claude 调度 + Codex 实现模式

- 触发词共有六个，必须按最长的完整关键词匹配，不能因为前缀相同而把 Max、Ultra 或 Fast 档降级为普通 CodexDev：
  - `CodexDev`：`config.model_reasoning_effort` 为 `xhigh`。
  - `CodexDevMax`：`config.model_reasoning_effort` 为 `max`。
  - `CodexDevUltra`：`config.model_reasoning_effort` 为 `ultra`。
  - `CodexDevFast`：effort 为 `xhigh`，并启用 Fast。
  - `CodexDevMaxFast`：effort 为 `max`，并启用 Fast。
  - `CodexDevUltraFast`：effort 为 `ultra`，并启用 Fast。
- 用户说“使用 <触发词>”或在消息中用任一触发词指名当前任务时，仅当前任务启用对应档位；说“进入 <触发词>”时，后续任务持续启用该档位；说“退出 CodexDev”或“退出 <当前触发词>”时退出持续模式。
- 模式启用后，当前 Claude 保持主协调者，不切换模型、不启动 `claudex`。Claude 负责理解需求、读取上下文、拆分任务、给出验收标准、审查结果、运行最终验证和向用户汇报；实际代码实现交给 Codex。
- Codex 必须通过用户级 MCP 工具 `mcp__codex__codex` 启动。需要继续同一任务时，保存返回的 `threadId`，通过 `mcp__codex__codex-reply` 继续；不要用新的 Codex thread 重做同一任务。
- Bootstrap 将 Codex MCP 默认注册为 `codex --sandbox workspace-write --ask-for-approval never mcp-server`。调用 Codex 时仍必须传绝对 `cwd`，模型固定为 `gpt-5.6-sol`，`approval-policy` 固定为 `never`，并按触发词传对应的 `config.model_reasoning_effort`。只读调查可显式收紧为 `sandbox: read-only`；实现代码使用 `sandbox: workspace-write`。禁止 `danger-full-access`。
- 三个 Fast 触发词的唯一区别是每次调用 `mcp__codex__codex` 时都在 `config` 中额外传 `"service_tier": "fast"`；三个非 Fast 触发词不得传 `service_tier`。Fast 是 Codex 原生 fast tier（请求值 `priority`），基础设施优先级提速约 1.5×，推理深度不变；ChatGPT 登录下 credit 约为 Standard 的 2.5×。
- 委派提示必须包含：任务目标、允许修改范围、相关约束、验收条件、测试命令、期望输出格式，以及当前 Claude 已确认的关键上下文。不要假设 Codex 能看到 Claude 的对话历史或 tool results。
- 要求 Codex 最终简洁返回：摘要、检查或修改的文件、实现决策、测试及结果、剩余风险。不要回传完整文件或冗长日志。
- Claude 收到结果后必须检查 diff、复核关键结论并运行必要测试。发现问题时优先用原 `threadId` 要求 Codex 修正。Claude 不应重新实现 Codex 已完成的工作，也不能把 Codex 的报告未经验证地当成最终事实。
- MCP 不可用、Codex 失败或任务超时时，明确报告阻塞；不要静默改由 Claude 实现，除非用户明确授权回退。
- 多个只读 Codex 任务可并行；并发写入必须使用独立 git worktree，初始并发限制为 2–4 个，避免文件冲突。
- 长任务不会因为耗时被中断。超过 2 分钟的调用会自动转成后台任务，Claude 立即拿到 task ID 并继续其他工作，结果以通知返回——这是正常行为，不是超时；用 `/tasks` 查看进度。wall-clock 上限约 28 小时，idle 检测已通过 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` 关闭。因此调用"卡住"时不要重试或改用新 thread，先查 `/tasks` 确认它是否仍在跑。
