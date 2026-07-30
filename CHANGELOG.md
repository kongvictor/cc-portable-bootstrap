# Changelog

## 1.1.5

Makes the active Codex Fast service tier visible in the claudex statusline.

### Added

- The statusline now displays a `Fast` segment when the effective
  `CLAUDE_CODE_EXTRA_BODY` request object contains `speed: "fast"`. The marker
  works with both claude-hud and the standalone fallback, and stays hidden for
  standard, missing, or malformed request-body settings.

## 1.1.4

Brings the same reasoning tiers to the Claude-on-GPT launcher that 1.1.3 gave
Codex delegation, and makes `xhigh` the launcher's default.

### Added

- `claudex --effort high|xhigh|max|ultra` selects the reasoning tier through
  the model-name parentheses suffix (`gpt-5.6-sol(<effort>)[1m]`): the proxy
  strips the suffix and writes `reasoning.effort` upstream while Claude Code
  strips the trailing `[1m]` client-side, so the 1M context budget is kept.
  Verified end-to-end against a live proxy; combines freely with `--fast`.
- Setup installs terminal shortcuts on both platforms: `claudexhigh`,
  `claudexxhigh`, `claudexmax`, `claudexultra`, each with a `fast`-suffixed
  variant, plus `claudexfast` (default tier + Fast). Uninstall removes them.
- The managed CLAUDE.md block documents eight case-insensitive `claudex*`
  trigger words that delegate a task to a headless Claude-on-GPT run at the
  matching tier, mirroring the CodexDev triggers.

### Changed

- Bare `claudex` now defaults to `xhigh` reasoning instead of the upstream
  default; `claudex --check` reports the selected tier and composed model.

## 1.1.3

Adds explicit Codex performance tiers to both delegation mode and the
Claude-on-GPT launcher, and makes the safer Codex MCP policy the installed
default.

### Added

- Six implementation-mode triggers now cover `xhigh`, `max`, and `ultra`
  reasoning, each with a `Fast` variant that selects the Codex Fast service
  tier without changing reasoning depth.
- `claudex --fast` preserves the configured GPT model and any existing
  `CLAUDE_CODE_EXTRA_BODY` object while injecting `speed: "fast"`. Both Windows
  and POSIX launchers consume the flag themselves, validate malformed extra
  body configuration, and expose `claudex --fast --check`.
- Launcher regression coverage now verifies argument filtering, request-body
  merging, secret redaction, and malformed-configuration failure on Windows
  and POSIX.

### Changed

- New Codex MCP registrations use
  `codex --sandbox workspace-write --ask-for-approval never mcp-server`.

## 1.1.2

A single Windows defect, found the only way it could be: Claude Code could not
see a Codex MCP server that `check` had been reporting as healthy for days.

### Fixed

- The Windows wrapper forwarded `--config-dir` on every run, passing its own
  computed default as if the user had chosen it. The core reads that flag as an
  explicit choice and pins `CLAUDE_CONFIG_DIR` for each `claude mcp` call, which
  is the failure `sanitizedChildEnv` documents: the registration lands in
  `<configDir>/.claude.json` instead of the real `~/.claude.json`. Both sides
  agreed with themselves and disagreed with each other, so `check` reported a
  healthy user-scope registration for a server Claude Code never loaded. The
  flag is now forwarded only when `-ConfigDir` is supplied. `setup-posix.sh`
  never passed it, so only Windows was affected.

## 1.1.1

Bundles the rest of the working set, and makes CI green on every platform. The
CI work matters beyond the badge: five real defects were only visible on a
machine unlike this one, and 1.1.0 shipped with all of them.

### Added

- `caveman`, `dmd` and `context7` are now declared dependencies, so a new
  machine gets the whole working set rather than just the status-line HUD.
  caveman and dmd are bundled in this repository's marketplace; context7 is
  installed by its qualified id from the official one.
- `CC_BOOTSTRAP_GIT_BASH=1|0` overrides Git Bash detection. It exists so both
  statusLine forms can be tested deterministically, and doubles as an escape
  hatch if detection is ever wrong on a host.

### Fixed

- `node --test tests/*.test.mjs` never ran on Windows with Node 18: neither
  Node 18 nor a Windows shell expands globs, so the pattern reached node
  verbatim. Node 22 expands it internally, which is why only one matrix cell
  failed. The suite now runs as bare `node --test`.
- Three test files derived their directory from
  `new URL(import.meta.url).pathname`, which yields `/D:/a/...` on Windows. The
  leading slash produced `D:\D:\a\...` and broke ten tests. `fileURLToPath`
  exists for exactly this.
- Test fixtures wrote fake `claude`/`codex` binaries as extensionless shell
  scripts, which Windows cannot execute, failing every bootstrap test there.
  They are now a Node script plus a `.cmd` shim — the same shape npm produces
  for a global CLI, so the fixtures exercise the batch-shim path the installer
  handles in practice.
- The PowerShell syntax check passed the script path as a trailing argument to
  `-Command`, which appends it to the command text instead of populating
  `$args`, so `ParseFile` always received `$null`. This test had never executed
  here — no PowerShell is installed, so it always skipped.
- The CRLF guard used `grep -qU $'[^\r]\n'`, but grep strips the line terminator
  before matching, so the pattern could never fire and correctly-CRLF files were
  reported as wrong. It now reads bytes.
- Assertions that assumed POSIX layout now expect `claudex.ps1` plus
  `claudex.cmd` on Windows, and build paths from `os.tmpdir()` rather than
  hardcoding `/tmp`. Three tests that genuinely require POSIX mechanics (a
  `/bin/sh` launcher, symlinks needing elevation, extensionless PATH lookup) are
  skipped on Windows with a stated reason instead of failing.

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
