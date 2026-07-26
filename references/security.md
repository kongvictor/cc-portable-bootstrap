# Security model

- Bootstrap checks the API key file with `stat` metadata only. It does not open it.
- Installed claudex launchers read the key only at runtime, keep it in process memory, and never print it.
- Before launching Claude, both POSIX and PowerShell launchers remove any inherited `ANTHROPIC_API_KEY` and inject only `ANTHROPIC_AUTH_TOKEN`, preventing dual auth headers on Claude Code 2.1.220+.
- Health checks require a direct HTTP 2xx response (redirects are not followed) and do not print response bodies, headers, endpoint credentials, or the key.
- Claude MCP child processes run without inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_BASE_URL` values.
- MCP inspection captures `claude mcp get codex` privately, retains only scope/type/command plus a strictly validated `mcp-server` shape, and reduces environment data to a boolean. Child output, environment values, nonstandard arguments, URLs, and headers are never logged or backed up; ambiguous output fails closed.
- `~/.claude.json` is explicitly blocked as a managed path and is never used for MCP synchronization.
- Managed file writes are atomic where the platform permits; backup directories/files use 0700/0600 on POSIX. Restore preflights physical paths, rejects parent symlink escapes, uses no-follow regular-file reads, and performs relative writes/removals only after changing into an inode-verified pinned parent directory.
- Backup IDs must name a strict direct child of the backup root; `.` and `..` are rejected by both Node and Windows wrappers.
- Bootstrap MCP add operations use a private operation lock and are always followed by inspection; the postcondition, not the CLI exit code alone, decides whether add succeeded. Automatic MCP remove/replace is disabled because Claude CLI deletion is name-based and has no compare-and-swap protection. A different or concurrently changed definition is preserved for explicit manual handling.
- `danger-full-access` is prohibited by the installed Codex mode policy. Investigation uses `read-only`; implementation uses `workspace-write`; approval policy is `never`.
- The status line ships in this repository and is covered by the same boundary. Its management key is read only at refresh time, is sent only to a strict loopback endpoint over HTTP (any non-loopback endpoint must be HTTPS), and never appears in logs, errors, or snapshots. Refresh is skipped entirely unless `CLIPROXY_URL` is set explicitly, so the key is never offered to whatever happens to be listening on a guessed port.
- Machine-specific topology (hostnames, SSH aliases, domains, LAN addresses, tunnel ports) is confined to `~/.config/cc-portable-bootstrap/profile.json`, which is git-ignored. The repository ships only placeholder examples.
