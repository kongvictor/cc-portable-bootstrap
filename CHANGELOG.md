# Changelog

## 1.1.0

First release that actually works on a native Windows host. Everything here was
found by deploying 1.0.0 to real machines rather than by testing on the machine
it was written on.

### Fixed — native Windows

- npm installs Codex as a `.cmd` shim, which `CreateProcess` cannot launch. Batch
  shims now go through `cmd.exe` with a verbatim, outer-quoted command line, and
  command lookup prefers `PATHEXT` candidates over the extensionless POSIX
  scripts npm installs beside them. Previously `mcp-server` detection always
  failed and setup reported no stable Codex binary.
- `setup-windows.ps1` resolved node with `Get-Command`, which returns every match
  on PATH; with two Node installs the path became an array and the wrapper tried
  to execute both joined by a space.
- Windows PowerShell strips embedded double quotes from native-command
  arguments, so the Node version probe was evaluated as `split(.)` and threw a
  SyntaxError, failing the 18+ check on a supported runtime.
- Claude Code runs the status line through Git Bash whenever Git Bash is
  installed. Git Bash rewrites the `/d` and `/s` switches into filesystem paths,
  so the recorded `cmd.exe /d /s /c` form started an interactive cmd.exe that
  printed its banner and echoed the status-line JSON. On Windows the launcher is
  now recorded in POSIX form when Git Bash is present; hosts without it keep the
  cmd.exe form. Both are recognised as managed, so upgrading needs no `--force`.

### Fixed — status line never refreshed

- The usage refresh built its endpoint list from `CLIPROXY_URL` alone. Claude
  Code spawns the status line from the user's shell, and setup deliberately does
  not pin that variable into `settings.env`, so the list was empty on every run
  and the quota segments silently froze at whatever the cache held. Nothing
  surfaced, because a missing snapshot renders as an absent segment, not an
  error. Endpoints now fall back to the machine profile that setup already
  writes; an explicit `CLIPROXY_URL` stays authoritative.
- That fallback duplicated the profile lookup (the status-line runtime is
  installed flat, without `core/profile.mjs`) and immediately drifted from it:
  it sorted priority descending instead of ascending, so a tunnelled hub at
  priority 10 lost to a local fallback at 100, and it compared `activeEndpoint`
  against each entry's label when the profile stores a URL, so the recorded
  active endpoint was never preferred. A test now pins both orderings together.

### Fixed — upgrades did not reach deployed machines

- Pulling new code and rerunning setup reported "no bootstrap changes required"
  and kept running the previous status-line runtime. The launcher path and the
  statusLine setting do not change between versions, and nothing compared the
  installed files. setup now compares the installed bytes against the checkout,
  reports a `stale` state, and reinstalls.

### Changed

- Codex implementation mode documents how long MCP calls behave: calls past two
  minutes move to a background task (that is not a timeout — check `/tasks`), the
  wall-clock limit is about 28 hours, and the stdio idle window is disabled via
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`. Retrying or opening a new Codex thread
  would duplicate work that is still running.

## 1.0.0

First release of the merged repository. Supersedes `claude-portable-bootstrap` and
`cliproxy-usage-statusline`, which are retired.

### Merged

- Bootstrap core (`core/bootstrap.mjs`) and the status-line runtime
  (`core/statusline/*.mjs`) now ship together, so a new machine is provisioned by a
  single install instead of two independent ones.
- The status line's `setup.sh` / `setup.ps1` pair is replaced by
  `core/statusline/install.mjs`: the copy, launcher selection and node pinning were
  identical on both platforms and are now written once.
- Legacy Bash/Python status-line implementations (`statusline.sh`, `render.py`,
  `snapshot.py`) are dropped; the Node runtime is the only implementation.

### Changed

- Managed-block markers and the PATH block are rebranded to `cc-portable-bootstrap`.
  Setup rewrites predecessor markers in place, so upgrading a machine keeps exactly
  one managed block instead of gaining a second one. A file containing both current
  and predecessor markers fails closed.
- Status-line launchers are renamed to `statusline`, `statusline.cmd` and
  `statusline.ps1`, installed under `~/.claude/cc-portable-bootstrap/`. Launchers
  installed by either predecessor are still recognised, so an upgrade is not treated
  as a foreign statusLine.
- `isCliproxyStatusCommand` is renamed `isManagedStatusCommand`; the old name remains
  as an alias.

### Added

- Dependency provisioning: the Codex CLI, cliproxyapi and required Claude Code
  plugins are installed automatically. Without them the status line and Codex
  implementation mode cannot work at all, which made the previous "install two
  repositories, then wire up the rest yourself" flow incomplete on a new machine.
  npm availability is verified rather than assumed, because a host can have node
  with a broken npm.
- Non-macOS cliproxyapi installs download a release asset and verify its
  published SHA256. Upstream's Linux path is `curl | bash`; a mutable remote
  script is not something this repository will pipe into a shell.
- cliproxyapi config generation with CSPRNG keys written to `~/.secrets/*` (mode
  600). Existing keys are reused rather than rotated, so a partially provisioned
  machine converges instead of breaking other hosts that share the credential.
- Machine profile (`~/.config/cc-portable-bootstrap/profile.json`, git-ignored)
  with two independent role flags — `runsLocalProxy` and `servesOthers` — plus
  priority-ordered endpoint candidates. Endpoint selection is capability probing:
  the first candidate to answer HTTP 2xx wins, and the repository contains no
  hostname, alias, domain or port of its own.
- Background autostart per platform: brew services or a user LaunchAgent on
  macOS, `systemctl --user` on Linux, and a logon-triggered scheduled task on
  Windows. Upstream ships no Windows service integration, and a logon task is the
  only mechanism that needs no administrator rights.
- `doctor` reports the whole chain (dependencies, service, endpoint reachability,
  pending interactive logins) in one redacted screen. `uninstall` removes what
  setup added while deliberately keeping secrets, upstream credentials and the
  MCP registration.
- CI matrix across macOS, Ubuntu and Windows on Node 18 and 22, plus gitleaks and
  a committed-topology check. The Windows leg exists because the maintainer's
  machine has no PowerShell, leaving those paths otherwise unverifiable.

### Retained from the predecessors

- GPT/Codex context rescaled to the real 372k window; always-on input/cache detail;
  Claude 5h/Weekly/scoped and GPT Weekly quota; ANSI/CJK-aware multi-line reflow.
- Windows refreshes through a lightweight `.cmd` that execs Node directly;
  PowerShell is used only for one-time installation.
- Management key is transmitted only to strict loopback addresses, and only when
  `CLIPROXY_URL` is set explicitly — no credentialed port probing.
- Codex MCP is never removed or replaced automatically.
- `claudex` requires HTTP 2xx, verifies the localhost fallback, fails closed when
  both are unreachable, and strips inherited `ANTHROPIC_API_KEY`.
