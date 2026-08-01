# Claude 调度 + Codex 实现模式

- Codex 触发词共有 22 个，格式为 `Codex<Model><Effort>[Fast]`，必须按最长的完整关键词匹配，不能因前缀相同把其他模型、Max、Ultra 或 Fast 档降级：
  - Sol（`gpt-5.6-sol`）：`CodexSolHigh`、`CodexSolXhigh`、`CodexSolMax`、`CodexSolUltra`，以及对应 Fast 变体 `CodexSolHighFast`、`CodexSolXhighFast`、`CodexSolMaxFast`、`CodexSolUltraFast`。
  - Luna（`gpt-5.6-luna`）：`CodexLunaHigh`、`CodexLunaXhigh`、`CodexLunaMax`，以及对应 Fast 变体 `CodexLunaHighFast`、`CodexLunaXhighFast`、`CodexLunaMaxFast`。Luna 不支持 `ultra`，不存在 Luna Ultra 触发词。
  - Terra（`gpt-5.6-terra`）：`CodexTerraHigh`、`CodexTerraXhigh`、`CodexTerraMax`、`CodexTerraUltra`，以及对应 Fast 变体 `CodexTerraHighFast`、`CodexTerraXhighFast`、`CodexTerraMaxFast`、`CodexTerraUltraFast`。
- 触发词中的 Sol/Luna/Terra 分别决定 `model` 为 `gpt-5.6-sol`、`gpt-5.6-luna`、`gpt-5.6-terra`；High/Xhigh/Max/Ultra 分别决定 `config.model_reasoning_effort` 为 `high`、`xhigh`、`max`、`ultra`。
- 显式 tier 优先于父会话默认：完整 Fast 触发词每次初始 `mcp__codex__codex` 调用都必须在 `config` 中传 `"service_tier": "fast"`；完整非 Fast 触发词必须省略 `service_tier`，即使当前会话由 `claudex --fast` 启动。只有通用或未明确 Fast/Standard 的 Codex 委派才继承当前 claudex 会话默认；Fast 父会话默认传 `service_tier: "fast"`，Standard 父会话默认省略。
- 用户说“使用 <触发词>”或在消息中用任一触发词指名当前任务时，仅当前任务启用对应模型和档位；说“进入 <触发词>”时，后续任务持续启用；说“退出 Codex”或“退出 <当前触发词>”时退出持续模式。
- 模式启用后，当前 Claude 保持主协调者，不切换模型、不启动 `claudex`。Claude 负责理解需求、读取上下文、拆分任务、给出验收标准、审查结果、运行最终验证和向用户汇报；实际代码实现交给 Codex。
- Codex 必须通过用户级 MCP 工具 `mcp__codex__codex` 启动。需要继续同一任务时，保存返回的 `threadId`，通过 `mcp__codex__codex-reply` 继续；不要用新的 Codex thread 重做同一任务。Fast/Standard 必须在初始 thread 创建时选定，不能假设 reply 可以改变 service tier。
- Bootstrap 将 Codex MCP 默认注册为 `codex --sandbox workspace-write --ask-for-approval never mcp-server`。调用 Codex 时仍必须传绝对 `cwd`、触发词对应的精确 `model`、`approval-policy: "never"` 和 `config.model_reasoning_effort`。只读调查可显式收紧为 `sandbox: read-only`；实现代码使用 `sandbox: workspace-write`。禁止 `danger-full-access`。
- Fast 是 Codex 原生 fast tier（请求值 `priority`），基础设施优先级提速约 1.5×，推理深度不变；ChatGPT 登录下 credit 约为 Standard 的 2.5×。
- 委派提示必须包含：任务目标、允许修改范围、相关约束、验收条件、测试命令、期望输出格式，以及当前 Claude 已确认的关键上下文。不要假设 Codex 能看到 Claude 的对话历史或 tool results。
- 要求 Codex 最终简洁返回：摘要、检查或修改的文件、实现决策、测试及结果、剩余风险。不要回传完整文件或冗长日志。
- Claude 收到结果后必须检查 diff、复核关键结论并运行必要测试。发现问题时优先用原 `threadId` 要求 Codex 修正。Claude 不应重新实现 Codex 已完成的工作，也不能把 Codex 的报告未经验证地当成最终事实。
- MCP 不可用、Codex 失败或任务超时时，明确报告阻塞；不要静默改由 Claude 实现，除非用户明确授权回退。
- 多个只读 Codex 任务可并行；并发写入必须使用独立 git worktree，初始并发限制为 2–4 个，避免文件冲突。
- claudex session-level Fast 默认只规定 Codex MCP 和嵌套 claudex 委派，不新增 Claude Code 内置 `Agent` 子代理的 Fast 选择规则。
- 长任务不会因为耗时被中断。超过 2 分钟的调用会自动转成后台任务，Claude 立即拿到 task ID 并继续其他工作，结果以通知返回——这是正常行为，不是超时；用 `/tasks` 查看进度。wall-clock 上限约 28 小时，idle 检测已通过 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` 关闭。因此调用“卡住”时不要重试或改用新 thread，先查 `/tasks` 确认它是否仍在跑。

# claudex 启动档位（CC on GPT 委派）

- claudex 模型触发词共有 22 个，格式为 `claudex<Model><Effort>[Fast]`，大小写不敏感，必须按最长完整关键词匹配：
  - Sol：`claudexSolHigh`、`claudexSolXhigh`、`claudexSolMax`、`claudexSolUltra`，以及 `claudexSolHighFast`、`claudexSolXhighFast`、`claudexSolMaxFast`、`claudexSolUltraFast`。
  - Luna：`claudexLunaHigh`、`claudexLunaXhigh`、`claudexLunaMax`，以及 `claudexLunaHighFast`、`claudexLunaXhighFast`、`claudexLunaMaxFast`。Luna 不支持 `ultra`。
  - Terra：`claudexTerraHigh`、`claudexTerraXhigh`、`claudexTerraMax`、`claudexTerraUltra`，以及 `claudexTerraHighFast`、`claudexTerraXhighFast`、`claudexTerraMaxFast`、`claudexTerraUltraFast`。
- 默认触发词 `claudex` 使用 Sol+xhigh，并继承当前会话 Fast/Standard 默认；`claudexFast` 使用 Sol+xhigh+Fast。触发词中的模型映射和 effort 映射与 Codex 模式相同。
- 用户用 claudex 触发词指名任务时，当前 Claude 保持主协调者，把任务交给 CC-on-GPT 无头执行。显式非 Fast 触发词必须用 `claudex --gpt-model <model> --effort <effort> --standard -p "<任务提示>"`；显式 Fast 触发词必须用对应参数并加 `--fast`；通用或未指定 tier 的嵌套 claudex 委派不传 `--fast`/`--standard`，继承父会话默认。Luna 不得与 `ultra` 组合。
- `--fast` 和 `--standard` 都是 launcher 参数，必须出现在原生 Claude 参数之前；两者都出现时最后一个生效。`--standard` 会覆盖继承的 Fast，只移除 `CLAUDE_CODE_EXTRA_BODY` 顶层 `speed` 字段并保留其他字段。
- 委派提示的自包含要求、结果验收（检查 diff、复核结论、运行测试）与 Codex 模式一致。
- 终端快捷命令由 bootstrap 安装到 `~/.claude/bin/`。命名为小写 `claudex<model><effort>[fast]`，覆盖全部 22 个有效组合；非 Fast 快捷命令内置 `--standard`，Fast 快捷命令内置 `--fast`。另有 `claudexfast`（Sol+xhigh+Fast）。裸 `claudex` 为 Sol+xhigh，在 fresh shell 中为 Standard，在 Fast claudex 子进程中继承 Fast。
- 用户只说触发词而没有给出具体任务时，不要凭空造任务；给出等效命令让用户自己在终端交互启动。
- 实现机制：`--gpt-model` 选择 `gpt-5.6-sol/luna/terra`，effort 经模型名括号后缀（如 `gpt-5.6-terra(ultra)[1m]`）由 cliproxyapi 写入上游 `reasoning.effort`；Claude Code 客户端会剥掉末尾 `[1m]`，1M 上下文预算不受影响。子代理使用同模型同档位 plain 模型。Fast 使用 `CLAUDE_CODE_EXTRA_BODY.speed="fast"`，并通过进程级 `CLAUDEX_DELEGATION_TIER=fast` 和固定 system policy 传播下游默认；不把 marker 写入全局 settings。`claudex --gpt-model terra --effort ultra --fast --check` 可无副作用验证。
