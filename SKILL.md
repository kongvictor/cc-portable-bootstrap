---
name: cc-portable-bootstrap
description: 检查、安装或恢复用户级 Claude Code 可移植 agent 环境：稳定 Codex MCP、Codex 实现模式、claudex 启动器和跨平台 statusline。用户说“bootstrap Claude / 安装 claudex / 配置 Codex MCP / 装状态栏 / 恢复 bootstrap / 检查可移植配置”时触发。
allowed-tools: Bash, Read, Skill, AskUserQuestion
---

# cc-portable-bootstrap

为当前用户执行 `check`、`doctor`、`setup`、`restore` 或 `uninstall`。共享逻辑在 Node.js 18+ 核心中；Windows 使用原生 PowerShell，不要求 Git Bash。

一次 setup 覆盖：Codex CLI 与 user-scope Codex MCP、Codex 实现模式 managed block、claudex 启动器、statusline、cliproxyapi（本机需要时）及其后台自启、依赖插件。

## 安全边界

- bootstrap 永远不要读取、复制、打印或让用户粘贴 `~/.secrets/cliproxy_apikey` 的值。只允许用文件元数据判断它是否存在且非空；仅安装后的 launcher 可在运行时读取，并且不得输出。
- launcher 启动 Claude 前必须移除继承的 `ANTHROPIC_API_KEY`，只注入 `ANTHROPIC_AUTH_TOKEN`，避免 Claude Code 2.1.220+ 同时发送两种认证 header。
- claudex 用 `--gpt-model sol|luna|terra` 选择 GPT-5.6 模型，用 `--effort high|xhigh|max|ultra` 选择模型支持的档位；Luna 不支持 Ultra。`--fast` 显式选择 Fast，`--standard` 显式覆盖继承 Fast，最后一个 tier 参数生效。Fast 会保留已有 `CLAUDE_CODE_EXTRA_BODY` JSON object、强制顶层 `"speed":"fast"`、设置进程级 `CLAUDEX_DELEGATION_TIER=fast`，并注入固定下游委派 policy；Standard 只删除顶层 `speed` 并保留其他字段。`--gpt-model`、`--effort`、`--fast`、`--standard` 和 `--check` 必须放在 Claude Code 参数之前；带 `--check` 只检查，不启动会话。不要用 Claude Code 会话内的 `/fast` 代替。
- 永远不要读取或同步整份 `~/.claude.json`。Codex MCP 只通过 `claude mcp get/add` 自动检查和注册，并且 scope 必须是 `user`。禁止自动 remove/replace；CLI 无 compare-and-swap，需要删除时必须保留当前定义并要求用户手工处理。
- 不允许 `danger-full-access`；Codex 实现模式只能使用 `read-only` 或 `workspace-write`，`approval-policy` 固定为 `never`。Bootstrap 新注册的 Codex MCP 必须使用 `codex --sandbox workspace-write --ask-for-approval never mcp-server`。
- Codex 实现模式有 22 个完整触发词，格式为 `Codex<Model><Effort>[Fast]`，按最长关键词匹配。Sol=`gpt-5.6-sol` 和 Terra=`gpt-5.6-terra` 支持 `high/xhigh/max/ultra`；Luna=`gpt-5.6-luna` 支持 `high/xhigh/max`。完整 Fast 触发词传 `"service_tier":"fast"`；完整非 Fast 触发词必须省略它，即使父 claudex 会话 Fast；仅通用或未指定 tier 的 Codex 委派继承父会话默认。claudex 使用同一 22 组合：非 Fast 触发词/快捷命令必须传 `--standard`，Fast 变体传 `--fast`，通用 bare claudex 继承。session-level 默认只覆盖 Codex MCP 和嵌套 claudex，不新增内置 Agent tier 规则。sandbox、`approval-policy`、`threadId` 和进入/退出规则不变。
- statusline 由本仓库 `core/statusline/install.mjs` 安装。不要手改 `settings.json` 的 `statusLine`，也不要复制 renderer 或 snapshot 实现。
- 不初始化 Git，不 commit，不 push。

## 选择平台入口

从本 `SKILL.md` 所在目录作为 skill root。

- macOS / Linux / WSL2：`scripts/setup-posix.sh`
- 原生 Windows：`scripts/setup-windows.ps1`

WSL2 按 Linux 处理；原生 Windows 不调用 Bash。

## 依赖与交互式登录

setup 会自动安装缺失的 Codex CLI、cliproxyapi 和依赖插件，并生成 cliproxyapi 配置与本机密钥（CSPRNG 生成，写入 `~/.secrets/*`，绝不打印）。

**登录无法自动化**，这是上游限制：Codex 是交互式 ChatGPT OAuth，cliproxyapi 上游是 OAuth/设备码。setup 完成后会列出待执行的登录命令，必须由用户自己运行。不要尝试代替用户完成，也不要假装已完成。

## check

直接运行非破坏性检查：

```bash
scripts/setup-posix.sh check     # 本仓库管理的配置
scripts/setup-posix.sh doctor    # 全链路：依赖、服务、端点、待办登录
```

原生 Windows：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 check
```

检查结果必须包含：Node/Claude、稳定 Codex binary、user-scope Codex MCP、Codex managed block、claudex launcher、PATH、secret 文件元数据，以及 statusline 委派状态。即使 check 返回 2，也要汇报缺项，而不是把它当成脚本崩溃。

## setup

始终先 dry-run，不得跳过：

```bash
scripts/setup-posix.sh setup --dry-run
```

原生 Windows：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 setup -DryRun
```

向用户概述将写入的路径和 MCP 动作；不要显示文件 diff 或任何 secret 内容。用户确认后执行：

```bash
scripts/setup-posix.sh setup --yes
```

原生 Windows：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 setup -Yes
```

完成后再次运行 `check`，再运行已安装 `claudex --check`（Windows 用 `claudex.cmd --check`）。

statusline 由同一次 setup 安装到 `~/.claude/cc-portable-bootstrap/`，并把 `settings.json` 的 `statusLine` 指向稳定 launcher。若该字段已存在且不是本仓库或其前身安装的，setup 会拒绝覆盖并要求人工确认，只有复核后才可加 `--force`。

## restore

先预览最新记录的 backup（restore 后可能是 `pre-restore-*` safety backup）：

```bash
scripts/setup-posix.sh restore --dry-run
```

确认后：

```bash
scripts/setup-posix.sh restore --yes
```

指定 backup：

```bash
scripts/setup-posix.sh restore --backup setup-... --yes
```

Windows 使用相同 action 和 `-DryRun` / `-Yes` / `-Backup` 参数。restore 只恢复 bootstrap 管理的文件和可安全 re-add 的 Codex MCP；若需要删除/替换可见 MCP，必须中止并要求手工处理后重试。

## uninstall

移除本仓库安装的配置和 statusline 运行时，并停用 cliproxyapi 自启服务。**保留**密钥、上游凭据、cliproxyapi 配置和 Codex MCP 注册——这些可能被其他机器或工具共用，删除必须由用户显式决定。

```bash
scripts/setup-posix.sh uninstall --dry-run
scripts/setup-posix.sh uninstall --yes
```

需要回到 setup 之前的精确状态时用 `restore`，不要用 `uninstall`。

## 机器 profile

角色由两个独立布尔量决定，不是单一枚举：

- `runsLocalProxy`：本机是否运行 cliproxyapi。外网 Windows 机、中心机、需要本地回退的机器都是 true。
- `servesOthers`：是否被其他机器连接。只有中心机是 true，它决定是否开启远程管理。

端点候选按优先级探测，第一个返回 HTTP 2xx 的胜出。**探测是能力检测，不是身份识别**：仓库里不含任何主机名、SSH 别名、域名或端口。真实拓扑只在 `~/.config/cc-portable-bootstrap/profile.json`（600，不进 git），仓库只提供 `templates/profile.example.json` 占位符。

凭据只发给严格 loopback（隧道映射到本机端口后同样是 loopback）；非 loopback 端点必须 HTTPS。

## 从旧仓库升级

本仓库取代 `claude-portable-bootstrap` 和 `cliproxy-usage-statusline`。setup 会就地重写前身留下的 managed block marker 和 PATH block，升级后仍然只有一个 block。若同一文件里同时存在新旧 marker，setup 会 fail closed，要求人工消除重复后重试。前身安装的 statusline launcher 会被识别为本仓库管理，不需要 `--force`。

## 最终汇报

简洁列出：动作、backup ID、Codex binary 路径、MCP 是否为 user scope、改动文件、`claudex --check` 结果、statusline 安装位置，以及测试/检查结果。绝不输出 key、Authorization header、MCP 环境值或命令原始 stderr。
