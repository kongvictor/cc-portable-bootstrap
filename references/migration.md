# Migration

## Existing Codex mode section

If `~/.claude/CLAUDE.md` contains an unmarked top-level section named `# Claude 调度 + Codex 实现模式`, setup replaces only that section with the bootstrap managed block. Other sections remain in place.

Markers:

```text
<!-- BEGIN cc-portable-bootstrap:codex-mode -->
<!-- END cc-portable-bootstrap:codex-mode -->
```

Malformed or duplicate markers stop setup instead of guessing.

## Upgrading from the predecessor repositories

This repository supersedes `claude-portable-bootstrap` and `cliproxy-usage-statusline`.

- Managed block markers and the shell PATH block written by `claude-portable-bootstrap` are rewritten in place, so an upgraded machine keeps exactly one block rather than gaining a second one beside the old markers.
- A file containing both current and predecessor markers fails closed; remove the duplicate manually, then rerun setup.
- Status-line launchers installed by either predecessor are recognised as managed, so an upgrade does not require `--force`.

## Existing Codex MCP

The bootstrap queries `claude mcp get codex`; it never reads `~/.claude.json`.

- Matching user-scope stdio command plus `mcp-server`: no change.
- Missing definition: add with `claude mcp add --scope user`.
- Any different visible definition, including a standard user-scope stdio `mcp-server`: preserve it and refuse automatic replacement. `claude mcp remove` is name-based and has no compare-and-swap, so the user must inspect and remove the old definition manually before rerunning setup.
- Non-user scope, HTTP/SSE, environment entries, nonstandard arguments, or ambiguous CLI output also fail closed to avoid copying or losing potential secrets.

## Existing claudex shell function

POSIX setup installs `~/.claude/bin/claudex` and a PATH managed block. It removes a legacy `claudex()` function only when the function contains all known implementation signatures:

- `cliproxy_apikey`
- `ANTHROPIC_BASE_URL`
- `CLAUDE_CODE_SUBAGENT_MODEL`
- `gpt-5.6-sol`

Any other same-name function remains untouched and check reports a warning. Use `--no-legacy-migrate` to retain even a recognized legacy function.

## Existing launcher files

Changed managed files are copied to the private backup directory before atomic replacement. No secret file and no `~/.claude.json` file is included.

## Statusline

The status line is installed by the same setup run; there is no separate plugin step. An existing `statusLine` that this installer does not recognise is preserved and reported instead of overwritten — pass `--force` only after reviewing it.
