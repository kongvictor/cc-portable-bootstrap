# Windows and WSL

## Native Windows

Use `scripts/setup-windows.ps1` from Windows PowerShell 5.1 or PowerShell 7. Git Bash is not required.

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 setup -DryRun
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 setup -Yes
```

测试或可移植目录可使用 `-BootstrapHome`、`-ConfigDir`、`-Claude`、`-Codex`；`-SkipUserPath` 只在明确不希望管理 User PATH 时使用。

Installed launchers:

- `%USERPROFILE%\.claude\bin\claudex.ps1`
- `%USERPROFILE%\.claude\bin\claudex.cmd`

`claudex.cmd` prefers `pwsh.exe` and otherwise uses built-in `powershell.exe`. Setup adds the bin directory to User PATH idempotently. PATH checks and snapshots are native PowerShell, keyed by core backup ID, and participate in rollback without storing the whole PATH. Open a new terminal after setup.

A Windows Codex candidate must be a stable executable outside `%TEMP%`/`%TMP%` and must support `mcp-server`. Temporary terminal integrations and cmux shims are rejected.

## WSL2

Treat WSL2 as Linux and run `scripts/setup-posix.sh`. WSL HOME, Claude configuration, Codex executable, secret file, and proxy endpoint are separate from native Windows unless you deliberately bridge them.

Do not use the Windows PowerShell setup against a WSL HOME and do not register a Windows TEMP shim from WSL.

## Line endings and encoding

PowerShell files are UTF-8 without BOM. The Node core accepts existing BOM/CRLF text and preserves the dominant newline style when updating managed text blocks.
