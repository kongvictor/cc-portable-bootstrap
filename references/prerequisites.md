# Prerequisites

## Required

- Node.js 18 or newer.
- Claude Code CLI available as `claude`, or pass `--claude /absolute/path`.
- A stable Codex executable that supports `codex mcp-server`.
- User write access to the selected HOME and Claude config directory.

## claudex runtime secret

Create the file yourself; bootstrap never creates it, reads its value, or prints it:

```bash
mkdir -p ~/.secrets
chmod 700 ~/.secrets
$EDITOR ~/.secrets/cliproxy_apikey
chmod 600 ~/.secrets/cliproxy_apikey
```

Native Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.secrets" | Out-Null
notepad "$HOME\.secrets\cliproxy_apikey"
```

The file must contain the cliproxy API key and be non-empty. Do not pass the value on a command line.

## Proxy endpoint

`claudex` uses the current process `CLIPROXY_URL` when set. Its default and failover endpoint is localhost `http://127.0.0.1:8317`. A health check succeeds only when `/v1/models` directly returns HTTP 2xx with the key. Before launching Claude it removes inherited `ANTHROPIC_API_KEY` and uses `ANTHROPIC_AUTH_TOKEN` only.

## Statusline

The status line ships with this repository and is installed by the same setup run. See [statusline.md](statusline.md).

Quota segments additionally need a management key at `~/.secrets/cliproxy_mgmtkey` (mode 600) and an explicit `CLIPROXY_URL`. Without them the status line still renders context and token detail; only the quota segments stay empty.
