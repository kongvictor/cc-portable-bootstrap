# Restore

Setup writes a backup only when files, Codex MCP, or a wrapper-owned PATH action changes. Restore creates a pre-restore safety backup. The latest restorable backup ID is stored in:

```text
~/.claude/portable-bootstrap/state.json
```

Preview and restore:

```bash
./scripts/setup-posix.sh restore --dry-run
./scripts/setup-posix.sh restore --yes
```

Select an older backup:

```bash
./scripts/setup-posix.sh restore --backup setup-YYYY... --dry-run
./scripts/setup-posix.sh restore --backup setup-YYYY... --yes
```

Native Windows uses `setup-windows.ps1 restore -DryRun/-Yes/-Backup`.

Restore behavior:

- Creates a `pre-restore-*` safety backup before mutation and attempts rollback if file, MCP, state, or wrapper-owned PATH restoration fails.
- Restores previous bytes and mode for files that existed.
- Removes files that setup originally created.
- Re-adds a missing prior standard user-scope Codex MCP when the name is still absent. It never automatically removes or replaces a visible definition because `claude mcp remove` has no compare-and-swap; manually resolve that conflict, then rerun restore.
- Restores the Windows User PATH entry state recorded for the selected backup; snapshots are keyed by backup ID and never copy the complete PATH value.
- Restores the `statusLine` setting from the backup like any other managed change. The runtime files under `~/.claude/cc-portable-bootstrap/` are left in place; rerun setup to reinstall them.
- Does not read or restore `~/.claude.json`, secret files, OAuth credentials, SSH keys, or Codex auth.

Backup contents are local and user-private. Keep secrets out of `CLAUDE.md` and shell profiles; secret material belongs in dedicated secret stores/files.
