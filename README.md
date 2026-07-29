# cc-portable-bootstrap

Portable, cross-platform setup for my Claude Code agent environment. One repository, one install command, no secrets and no network topology committed.

One `setup` provisions the whole environment:

1. **Dependencies** — installs the Codex CLI and, when this host needs one, [cliproxyapi](https://github.com/router-for-me/CLIProxyAPI), plus the required Claude Code plugins.
2. **Codex MCP** — registers a stable Codex binary as a user-scope MCP server using `codex --sandbox workspace-write --ask-for-approval never mcp-server`, so Claude can delegate implementation to Codex with safe defaults.
3. **Working modes** — installs six *Claude orchestrates / Codex implements* triggers into your user `CLAUDE.md`: `CodexDev`, `CodexDevMax`, and `CodexDevUltra` select `xhigh`, `max`, and `ultra` reasoning; each also has a `Fast` suffix variant.
4. **`claudex`** — a launcher that runs Claude Code against GPT models through a local or tunnelled proxy, with a fail-closed health check and an opt-in Codex Fast tier.
5. **Statusline** — a Node runtime layered on [claude-hud](https://github.com/jarrodwatts/claude-hud) that rescales GPT/Codex context to its real window, always shows input/cache tokens, and appends official Claude/ChatGPT quota.
6. **Autostart** — keeps a local proxy running across reboots (launchd / systemd --user / a logon scheduled task on Windows).

### What it cannot do for you

Signing in is interactive upstream — Codex uses a ChatGPT OAuth flow, cliproxyapi uses OAuth/device codes. Setup installs and configures everything, then prints the exact login commands for you to run. It never automates, stores, or fakes that step.

## Requirements

- Node.js 18+
- Claude Code CLI
- macOS, Linux, WSL2, or native Windows (no Git Bash required)

## Install

```bash
claude plugin marketplace add kongvictor/cc-portable-bootstrap
claude plugin install cc-portable-bootstrap
```

Then, in a Claude Code session:

```text
/cc-portable-bootstrap:setup
```

Or run the platform entry point directly:

```bash
scripts/setup-posix.sh check          # what this repo manages
scripts/setup-posix.sh doctor         # full chain: deps, service, endpoint, pending logins
scripts/setup-posix.sh setup --dry-run
scripts/setup-posix.sh setup --yes
scripts/setup-posix.sh uninstall --yes
```

```powershell
.\scripts\setup-windows.ps1 check
.\scripts\setup-windows.ps1 setup -DryRun
.\scripts\setup-windows.ps1 setup -Yes
```

## Secrets and topology stay out of this repository

- Secrets live only in `~/.secrets/cliproxy_apikey` and `~/.secrets/cliproxy_mgmtkey` (mode 600). The installer checks that they exist and are non-empty; it never reads, prints, copies or transmits their values. Only the installed launcher reads the key, at runtime.
- Machine-specific topology (hostnames, SSH aliases, domains, LAN addresses, ports) lives in `~/.config/cc-portable-bootstrap/profile.json`, which is git-ignored. The repository ships only `templates/profile.example.json` with placeholders.
- Endpoint selection is *capability probing, not identity detection*: candidates are tried in priority order and the first to answer HTTP 2xx wins. Nothing in the repository knows what any endpoint is.
- Keys generated during setup use a CSPRNG, are written locally with mode 600, and are never printed or returned.
- Release downloads are verified against a published SHA256 before anything is made executable. The upstream Linux installer is a `curl | bash` one-liner; this repository deliberately does not pipe a remote script into a shell.
- CI runs gitleaks plus a check that rejects committed private addresses.
- `~/.claude.json` is never read or synced. Codex MCP is managed exclusively through `claude mcp get/add`.
- The management key is only ever sent to a strict loopback address; any non-loopback endpoint must be HTTPS.

## Safety model

- Every write is planned first (`--dry-run`), backed up, applied atomically, and reversible via `restore`.
- Existing configuration is merged, never clobbered. A statusLine this installer does not recognise is left alone unless you pass `--force`.
- Codex MCP is **never** removed or replaced automatically: the Claude CLI has no compare-and-swap remove, so a conflicting definition is reported for manual handling instead of risking the deletion of a concurrently registered server.
- `claudex` strips any inherited `ANTHROPIC_API_KEY` before launching Claude Code, so the proxy sees exactly one credential.
- `claudex --fast` keeps the configured GPT model and injects `speed: "fast"` into Claude Code's request body. Current CLIProxyAPI translates that to Codex's priority/Fast service tier; use `claudex --fast --check` to verify launcher selection without starting a session. Launcher-only flags must come before any Claude Code arguments. This is intentionally separate from Claude Code's in-session `/fast`, which selects Anthropic's native Fast model path.

## Development

```bash
npm test          # node --test tests/*.test.mjs
npm run check     # syntax check the Node core
npm run check:posix
```

Tests run against isolated `HOME` sandboxes with fake `claude` / `codex` binaries and never touch the network or your real configuration.

## License

MIT
