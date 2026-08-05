# cc-portable-bootstrap

Portable, cross-platform setup for my Claude Code agent environment. One repository, one install command, no secrets and no network topology committed.

One `setup` provisions the whole environment:

1. **Dependencies** — installs the Codex CLI and, when this host needs one, [cliproxyapi](https://github.com/router-for-me/CLIProxyAPI), plus the required Claude Code plugins.
2. **Codex MCP** — registers a stable Codex binary as a user-scope MCP server using `codex --sandbox workspace-write --ask-for-approval never mcp-server`, so Claude can delegate implementation to Codex with safe defaults.
3. **Working modes** — installs 22 model-aware *Claude orchestrates / Codex implements* triggers into your user `CLAUDE.md`: `Codex<Model><Effort>[Fast]` selects Sol, Luna, or Terra plus `high`, `xhigh`, `max`, or supported `ultra` reasoning.
4. **`claudex`** — a launcher that runs Claude Code against GPT-5.6 Sol/Luna/Terra through a local or tunnelled proxy, with a fail-closed health check, model-aware reasoning tiers, matching shortcuts, and inherited Fast defaults for downstream Codex/claudex delegation.
5. **Statusline** — a Node runtime layered on [claude-hud](https://github.com/jarrodwatts/claude-hud) that rescales GPT/Codex context to its real window, always shows input/cache tokens, appends official Claude/ChatGPT quota, and marks Fast-tier sessions.
6. **Autostart** — keeps a local proxy running across reboots (launchd / systemd --user / a logon scheduled task on Windows).
7. **`rdev`** — opens a development workspace on another machine over the Mux desktop app, or over plain SSH with a remote multiplexer when Mux is unavailable. Hosts are SSH aliases read from the machine profile. See [references/remote-dev.md](references/remote-dev.md).

### What it cannot do for you

Signing in is interactive upstream — Codex uses a ChatGPT OAuth flow, cliproxyapi uses OAuth/device codes. Setup installs and configures everything, then prints the exact login commands for you to run. It never automates, stores, or fakes that step.

## Requirements

- Node.js 18+
- Claude Code CLI
- macOS, Linux, WSL2, or native Windows (no Git Bash required)

## Model-aware modes

- Sol: `gpt-5.6-sol`, efforts `high|xhigh|max|ultra`
- Luna: `gpt-5.6-luna`, efforts `high|xhigh|max` (no Ultra)
- Terra: `gpt-5.6-terra`, efforts `high|xhigh|max|ultra`
- Every valid pair has standard and `Fast` prompt triggers. Codex triggers use `Codex<Model><Effort>[Fast]`; claudex triggers and shortcuts use `claudex<Model><Effort>[Fast]`.
- Bare `claudex` defaults to Sol+xhigh and inherits a Fast parent session when nested. `claudexfast` selects Sol+xhigh+Fast. Direct selection uses `claudex --gpt-model sol|luna|terra --effort high|xhigh|max|ultra [--fast|--standard]`.
- A Fast claudex session defaults generic Codex MCP and bare nested claudex delegation to Fast. Explicit non-Fast trigger names override that default and use Standard; explicit Fast names always use Fast. This policy does not add a new tier rule for Claude Code built-in Agent subagents.

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
- Machine-specific topology (hostnames, SSH aliases, domains, LAN addresses, ports) lives in `~/.config/cc-portable-bootstrap/profile.json`, which is git-ignored. The repository ships only `templates/profile.example.json` with placeholders. This includes `rdev`: it knows an alias name, never an address, port, jump host or key.
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
- `claudex --gpt-model <sol|luna|terra> --effort <tier> [--fast|--standard]` selects the exact GPT-5.6 model, reasoning tier, and optional explicit transport tier. Fast preserves the existing request-body object, injects `speed: "fast"`, sets a process-only inheritance marker, and appends a fixed downstream-delegation policy. `--standard` removes only top-level `speed`, preserves other fields, and clears inherited Fast. Launcher-only flags must precede Claude arguments; the last `--fast`/`--standard` wins. This remains separate from Claude Code's in-session `/fast`.

## Development

```bash
npm test          # node --test
npm run check     # syntax check the Node core
npm run check:posix
```

Tests run against isolated `HOME` sandboxes with fake `claude` / `codex` binaries and never touch the network or your real configuration.

## License

MIT
