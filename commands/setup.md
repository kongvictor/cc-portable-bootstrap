---
description: 安装或检查可移植 Claude Code agent 环境（Codex MCP、工作模式、claudex、statusline）
---

调用 `cc-portable-bootstrap` skill 完成本机安装。

流程不可跳过：

1. 先运行 `check`，把缺失项报告给用户。
2. 运行 `setup --dry-run`，列出将写入的路径和 MCP 动作，不显示文件 diff 或任何 secret。
3. 用户确认后运行 `setup --yes`。
4. 复验：再次 `check`，运行默认 `claudex --check`，再运行 `claudex --gpt-model terra --effort ultra --fast --check` 验证非默认组合，并确认 `settings.json` 的 `statusLine` 指向 `~/.claude/cc-portable-bootstrap/` 下的稳定 launcher。

平台入口：

- macOS / Linux / WSL2：`scripts/setup-posix.sh`
- 原生 Windows：`scripts/setup-windows.ps1`

安全边界见 skill 正文：不读取或输出任何密钥，不读取整份 `~/.claude.json`，不自动 remove 或替换已有的 Codex MCP，不覆盖无法识别的 `statusLine`。
