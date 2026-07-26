# Statusline

The status line ships with this repository. There is no separate plugin to install.

## What it renders

`core/statusline/runtime.mjs` runs [claude-hud](https://github.com/jarrodwatts/claude-hud) and augments its output:

- **Context** — for GPT/Codex sessions the context bar and percentage are rescaled to the real window (`CLIPROXY_GPT_WINDOW`, default `372000`) instead of the window Claude Code advertises. Claude sessions pass through untouched.
- **Token detail** — `(in:N, cache:Nk)` is always appended after the context percentage. `cache` is the sum of cache creation and cache read tokens.
- **Quota** — Claude sessions show `5h`, `Weekly` and scoped weekly limits; GPT/Codex sessions show `Weekly` only.
- **Reflow** — usage segments are appended inline when they fit, otherwise wrapped onto indented lines sized to the terminal width, measured with ANSI escapes stripped and CJK width accounted for.

Every other claude-hud segment (tools, agents, todos, git) is preserved. If claude-hud is missing or fails, the runtime falls back to rendering context and quota on its own.

## Install layout

`core/statusline/install.mjs` copies the runtime to a stable directory and points Claude Code at it:

```text
~/.claude/cc-portable-bootstrap/
├── runtime.mjs, layout.mjs, snapshot.mjs, discovery.mjs, configure.mjs
├── statusline           (POSIX launcher)
├── statusline.cmd       (Windows refresh path)
├── statusline.ps1       (Windows compatibility entry)
└── .node-path           (pinned Node interpreter)
```

`settings.json` gets a `statusLine` pointing at the platform launcher with `refreshInterval: 3`.

On Windows the refresh path is the `.cmd`, which execs Node directly. PowerShell is used only for one-time installation — starting a PowerShell process every three seconds would be far too slow.

## Quota snapshots

Quota comes from a throttled background refresh written to `~/.cache/cliproxy-usage/`. No daemon or scheduled job is required.

The refresh only runs when `CLIPROXY_URL` is set explicitly. Without it the status line still renders, using any existing snapshot; it just does not fetch. This is deliberate: the management key must never be sent to whatever happens to be listening on a guessed port.

Transport rules:

- HTTP is accepted only for strict loopback (`127.0.0.0/8`, `localhost`, `::1`). A hostname that merely starts with `127.` is rejected.
- Any non-loopback endpoint must be HTTPS.
- The management key is read from `~/.secrets/cliproxy_mgmtkey` at refresh time and never logged, printed, or included in errors.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIPROXY_URL` | unset | Management endpoint; refresh is disabled when unset |
| `CLIPROXY_USAGE_DIR` | `~/.cache/cliproxy-usage` | Snapshot directory |
| `CLIPROXY_MGMTKEY_FILE` | `~/.secrets/cliproxy_mgmtkey` | Management key path |
| `CLIPROXY_GPT_WINDOW` | `372000` | Real GPT/Codex context window |
| `CLIPROXY_REFRESH_SECONDS` | `55` | Minimum interval between refreshes |
| `CLIPROXY_USAGE_STALE` | `600` | Snapshot age after which quota is hidden |
| `CLIPROXY_DISABLE_REFRESH` | unset | Set to `1` to disable refresh entirely |
| `CC_BOOTSTRAP_NODE_BIN` | pinned at install | Override the Node interpreter |

## Replacing an existing statusLine

Setup refuses to overwrite a `statusLine` it does not recognise. Launchers installed by this repository or either predecessor (`cliproxy-usage-statusline`, and the legacy `statusline.sh`) are recognised, so upgrades proceed without prompting. Anything else requires `--force` after you have reviewed what is currently configured.
