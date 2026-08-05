# Remote development (rdev)

`rdev` opens a development workspace on another machine over SSH. It is installed
by the same `setup` that installs claudex and the status line, on macOS, Linux and
native Windows.

Setup installs:

- `HOME/.claude/bin/rdev` (POSIX) or `rdev.cmd` (Windows)
- `HOME/.claude/bin/rdev-exec.mjs` — host resolution, transport selection, launch
- `HOME/.claude/bin/rclaude` / `rclaude.cmd` — shortcut for `rdev --agent claude`

Skip it with `setup --no-remotedev`. `uninstall` removes the launchers with every
other managed file.

## Topology lives in the profile, never in this repository

No host name, SSH alias, address or port appears in any tracked file. `rdev` reads
`remoteDev` from `HOME/.config/cc-portable-bootstrap/profile.json` (mode 600, never
committed). `templates/profile.example.json` ships placeholders only.

```json
"remoteDev": {
  "transport": "auto",
  "defaultHost": "hub",
  "hosts": [
    {
      "name": "hub",
      "sshAlias": "my-hub-ssh-alias",
      "label": "HUB",
      "defaultWorkspace": "dev",
      "multiplexer": "auto",
      "remotePath": ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"]
    }
  ]
}
```

`sshAlias` is an alias from the user's own `~/.ssh/config`. `rdev` never learns an
address, a port, a jump host or a key path, so reaching a machine from outside its
LAN is an SSH configuration question, not an `rdev` question.

Validation is deliberately strict because these values reach `ssh` and a remote
shell: aliases reject shell metacharacters and a leading `-`, workspace names are
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, and `remotePath` entries must be absolute or
`~/`-relative with no metacharacters.

## Transports

`transport` is `auto` (default), `mux` or `ssh`.

- **mux** — the Mux desktop app (formerly cmux; upstream renamed it). `rdev` runs
  `mux ssh <alias> --name <workspace>`, and the app manages the remote daemon,
  reconnects and agent integration. Both product generations are discovered, and
  a socket-control password file is passed through the environment if one exists.
  The value is never printed.
- **ssh** — plain OpenSSH plus a remote multiplexer, so a dropped connection does
  not kill the session. Needs nothing installed locally beyond `ssh` itself, which
  Windows 10/11 ships.

Under `auto`, Mux wins when a usable build is found; otherwise SSH. If Mux is used
and exits non-zero within five seconds — it never attached — `rdev` reports why and
retries over SSH. A transport named explicitly is never silently downgraded.

Windows Mux support is upstream alpha and needs Git for Windows; WSL is not
supported. `auto` is the right setting there: it uses Mux when it works and falls
back on its own when it does not. Pin `--transport ssh` to skip Mux entirely.

## Remote multiplexer

`multiplexer` selects what keeps the SSH session alive: `auto` (default), `tmux`,
`zellij` or `none`.

`auto` prefers tmux, then zellij, then a plain login shell. tmux comes first
because it is the only one of the two that can start a workspace command, which is
what agent shortcuts need. `zellij` therefore refuses to combine with `--agent` or
`--command`, and says so while planning rather than after Mux has already given up.

## Usage

```bash
rdev                      # default host, default workspace
rdev build                # named workspace
rdev --host other build   # another host from the profile
rdev --agent claude       # Claude Code in its own workspace
rclaude                   # same thing
rdev --command 'npm test' # one-off command in a workspace
rdev --list               # hosts configured in the profile
rdev --check              # resolved host, workspace and transport; connects to nothing
```

Windows uses `rdev.cmd` and `rclaude.cmd`; the arguments are identical.

Environment overrides, for debugging: `RDEV_PROFILE_FILE`, `RDEV_TRANSPORT`,
`RDEV_MUX_BIN`, `RDEV_NODE_BIN`.

## Reaching a machine from outside its network

`rdev` deliberately has no opinion here. Give the SSH alias whatever `HostName`,
`Port`, `ProxyJump` or tunnel the machine actually needs, verify it with
`ssh <alias> true`, then point a `remoteDev` host at that alias. A machine with no
inbound path is not reachable by `rdev` either; that has to be solved in SSH and
the network first.
