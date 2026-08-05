#!/usr/bin/env node
// Remote development launcher. Resolves a host from the machine profile, picks a
// transport (a Mux/cmux workspace, or plain SSH with a terminal multiplexer) and
// execs it.
//
// This file is installed flat into HOME/.claude/bin, so it imports nothing from
// the repository. core/profile.mjs imports the pure validators below instead, so
// the remoteDev schema has exactly one definition rather than a drifting copy.
//
// No host name, alias, address or port is hard-coded here. Real topology lives
// only in the machine profile, which is never committed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const TRANSPORTS = Object.freeze(['auto', 'mux', 'ssh']);
export const MULTIPLEXERS = Object.freeze(['auto', 'tmux', 'zellij', 'none']);
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A remote PATH entry is rendered into a shell command unquoted, so its
// character set is restricted to what cannot carry meaning to a shell.
export const REMOTE_PATH_PATTERN = /^(?:\/|~\/)[A-Za-z0-9._/-]*$/;
export const DEFAULT_REMOTE_PATH = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin']);
export const DEFAULT_WORKSPACE = 'dev';

// Named agents give the shortcuts (rclaude) a workspace that is stable across
// sessions, so reconnecting lands in the same long-running agent.
export const AGENTS = Object.freeze({
  claude: Object.freeze({ command: 'claude', workspace: 'claude-code' }),
  codex: Object.freeze({ command: 'codex', workspace: 'codex' }),
});

function defaultInvalid(message) {
  throw new Error(`Invalid profile: ${message}`);
}

function validateAlias(value, invalid) {
  if (typeof value !== 'string' || !value.trim()) invalid('remoteDev host sshAlias must be a non-empty string');
  const alias = value.trim();
  // The alias becomes an ssh argv element and is interpolated into nothing else,
  // but refusing metacharacters up front keeps it safe if that ever changes.
  if (/[\s;&|`$()<>'"\\]/.test(alias)) invalid(`remoteDev host sshAlias contains shell metacharacters: ${alias}`);
  if (alias.startsWith('-')) invalid('remoteDev host sshAlias must not start with "-"');
  if (alias.length > 120) invalid('remoteDev host sshAlias is too long');
  return alias;
}

function validateRemotePath(value, invalid) {
  if (value === undefined || value === null) return [...DEFAULT_REMOTE_PATH];
  if (!Array.isArray(value)) invalid('remoteDev host remotePath must be an array');
  if (value.length > 8) invalid('remoteDev host remotePath accepts at most 8 entries');
  return value.map((entry) => {
    if (typeof entry !== 'string' || !REMOTE_PATH_PATTERN.test(entry)) {
      invalid(`remoteDev host remotePath entry must be an absolute or ~/ path with no shell metacharacters: ${entry}`);
    }
    return entry;
  });
}

// Shared with core/profile.mjs so a profile written by the bootstrap and a
// profile read by the installed launcher can never disagree about what is valid.
export function validateRemoteDev(value, invalid = defaultInvalid) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid('remoteDev must be an object');

  const transport = value.transport === undefined ? 'auto' : value.transport;
  if (!TRANSPORTS.includes(transport)) invalid(`remoteDev transport must be one of ${TRANSPORTS.join('|')}`);

  if (!Array.isArray(value.hosts) || value.hosts.length === 0) {
    invalid('remoteDev.hosts must be a non-empty array');
  }
  if (value.hosts.length > 32) invalid('remoteDev.hosts accepts at most 32 entries');

  const seen = new Set();
  const hosts = value.hosts.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('each remoteDev host must be an object');
    if (typeof entry.name !== 'string' || !HOST_NAME_PATTERN.test(entry.name)) {
      invalid(`remoteDev host name must match ${HOST_NAME_PATTERN}`);
    }
    if (seen.has(entry.name)) invalid(`duplicate remoteDev host name: ${entry.name}`);
    seen.add(entry.name);

    const sshAlias = validateAlias(entry.sshAlias, invalid);

    let label = null;
    if (entry.label !== undefined && entry.label !== null) {
      if (typeof entry.label !== 'string' || !entry.label.trim()) invalid('remoteDev host label must be a non-empty string');
      if (entry.label.length > 24 || /[\r\n]/.test(entry.label)) invalid('remoteDev host label is too long or contains newlines');
      label = entry.label.trim();
    }

    const defaultWorkspace = entry.defaultWorkspace === undefined || entry.defaultWorkspace === null
      ? DEFAULT_WORKSPACE
      : entry.defaultWorkspace;
    if (typeof defaultWorkspace !== 'string' || !WORKSPACE_PATTERN.test(defaultWorkspace)) {
      invalid(`remoteDev host defaultWorkspace must match ${WORKSPACE_PATTERN}`);
    }

    const multiplexer = entry.multiplexer === undefined || entry.multiplexer === null ? 'auto' : entry.multiplexer;
    if (!MULTIPLEXERS.includes(multiplexer)) {
      invalid(`remoteDev host multiplexer must be one of ${MULTIPLEXERS.join('|')}`);
    }

    const remotePath = validateRemotePath(entry.remotePath, invalid);

    const host = { name: entry.name, sshAlias, defaultWorkspace, multiplexer, remotePath };
    if (label) host.label = label;
    if (entry.muxBin !== undefined && entry.muxBin !== null) {
      if (typeof entry.muxBin !== 'string' || !entry.muxBin.trim()) invalid('remoteDev host muxBin must be a non-empty string');
      host.muxBin = entry.muxBin.trim();
    }
    return host;
  });

  let defaultHost = hosts[0].name;
  if (value.defaultHost !== undefined && value.defaultHost !== null) {
    if (typeof value.defaultHost !== 'string' || !seen.has(value.defaultHost)) {
      invalid('remoteDev.defaultHost is not one of the configured hosts');
    }
    defaultHost = value.defaultHost;
  }

  return { transport, defaultHost, hosts };
}

export function resolveHost(remoteDev, name = null) {
  if (!remoteDev) throw new Error('no remoteDev section in the machine profile');
  const wanted = name || remoteDev.defaultHost;
  const host = remoteDev.hosts.find((entry) => entry.name === wanted);
  if (!host) {
    const names = remoteDev.hosts.map((entry) => entry.name).join(', ');
    throw new Error(`unknown host "${wanted}" (configured: ${names})`);
  }
  return host;
}

// POSIX single-quote escaping. Everything interpolated into the remote command
// goes through here, so a workspace or agent command can never break out.
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function renderRemotePath(entries) {
  // Safe unquoted because REMOTE_PATH_PATTERN excludes every shell metacharacter
  // except the leading ~, which is expanded here rather than by the remote shell.
  return entries.map((entry) => (entry.startsWith('~/') ? `$HOME/${entry.slice(2)}` : entry));
}

export function remoteCommand({
  workspace,
  command = null,
  multiplexer = 'auto',
  remotePath = DEFAULT_REMOTE_PATH,
} = {}) {
  if (!WORKSPACE_PATTERN.test(workspace || '')) throw new Error(`invalid workspace name: ${workspace}`);
  if (multiplexer === 'zellij' && command) {
    throw new Error('zellij cannot start a workspace command; use multiplexer "tmux" or "none" for agent shortcuts');
  }

  const rendered = renderRemotePath(remotePath);
  const prefix = rendered.length ? `PATH=${rendered.join(':')}:$PATH; export PATH; ` : '';
  const session = shellQuote(workspace);
  const login = command
    ? `exec \${SHELL:-/bin/sh} -lc ${shellQuote(command)}`
    : 'exec ${SHELL:-/bin/sh} -l';
  const tmux = command
    ? `exec tmux new-session -A -s ${session} ${shellQuote(command)}`
    : `exec tmux new-session -A -s ${session}`;
  const zellij = `exec zellij attach --create ${session}`;

  if (multiplexer === 'none') return `${prefix}${login}`;
  if (multiplexer === 'tmux') return `${prefix}${tmux}`;
  if (multiplexer === 'zellij') return `${prefix}${zellij}`;

  // auto: tmux first because it is the only one of the two that can carry a
  // workspace command, then zellij for a plain shell, then the login shell.
  //
  // Each candidate is probed by running it, not by `command -v`. An abandoned
  // Homebrew build stays on PATH long after its linked libraries are gone, and
  // picking it would drop the session into a dyld error instead of a shell.
  const branches = command
    ? [`if tmux -V >/dev/null 2>&1; then ${tmux}`]
    : [`if tmux -V >/dev/null 2>&1; then ${tmux}`, `elif zellij --version >/dev/null 2>&1; then ${zellij}`];
  return `${prefix}${branches.join('; ')}; else ${login}; fi`;
}

export function buildSshArgs(host, { workspace, command = null } = {}) {
  return [
    '-t',
    host.sshAlias,
    '--',
    remoteCommand({
      workspace,
      command,
      multiplexer: host.multiplexer,
      remotePath: host.remotePath,
    }),
  ];
}

export function buildMuxArgs(host, { workspace, command = null } = {}) {
  if (!WORKSPACE_PATTERN.test(workspace || '')) throw new Error(`invalid workspace name: ${workspace}`);
  const args = ['ssh', host.sshAlias, '--name', workspace];
  if (command) args.push('--command', `exec ${command}`);
  return args;
}

// Duplicated from core/profile.mjs because the installed launcher runs flat, with
// no access to the repository. tests/remotedev.test.mjs pins the two together.
export function profilePathFor(env = process.env, homeDir = os.homedir()) {
  const override = env.CC_BOOTSTRAP_PROFILE_FILE?.trim();
  if (override) return path.resolve(override);
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const base = configHome ? path.resolve(configHome) : path.join(homeDir, '.config');
  return path.join(base, 'cc-portable-bootstrap', 'profile.json');
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathLookup(name, env, platform) {
  const separator = platform === 'win32' ? ';' : ':';
  const suffixes = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const directory of (env.PATH || env.Path || '').split(separator)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

// Both product generations are accepted: cmux was renamed to Mux upstream, and a
// machine may still carry either build.
export function muxCandidates(env, platform, home) {
  if (platform === 'darwin') {
    return [
      '/Applications/Mux.app/Contents/Resources/bin/mux',
      '/Applications/cmux.app/Contents/Resources/bin/cmux',
      path.join(home, 'Applications', 'Mux.app', 'Contents', 'Resources', 'bin', 'mux'),
      path.join(home, 'Applications', 'cmux.app', 'Contents', 'Resources', 'bin', 'cmux'),
      path.join(home, '.local', 'bin', 'mux'),
      path.join(home, '.local', 'bin', 'cmux'),
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Programs', 'Mux', 'resources', 'bin', 'mux.exe'),
      path.join(local, 'Programs', 'mux', 'resources', 'bin', 'mux.exe'),
      path.join(local, 'Programs', 'cmux', 'resources', 'bin', 'cmux.exe'),
      path.join(local, 'Programs', 'Mux', 'mux.exe'),
    ];
  }
  return [path.join(home, '.local', 'bin', 'mux'), path.join(home, '.local', 'bin', 'cmux')];
}

export function findMuxBinary({ env = process.env, platform = process.platform, home = os.homedir(), explicit = null } = {}) {
  const preferred = explicit || env.RDEV_MUX_BIN;
  if (preferred) return isExecutableFile(path.resolve(preferred)) ? path.resolve(preferred) : null;
  for (const candidate of muxCandidates(env, platform, home)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return pathLookup('mux', env, platform) || pathLookup('cmux', env, platform);
}

export function muxPasswordCandidates(env, platform, home) {
  const posix = [
    path.join(home, '.local', 'state', 'mux', 'socket-control-password'),
    path.join(home, '.local', 'state', 'cmux', 'socket-control-password'),
  ];
  if (platform !== 'win32') return posix;
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(local, 'mux', 'socket-control-password'),
    path.join(local, 'cmux', 'socket-control-password'),
    path.join(roaming, 'mux', 'socket-control-password'),
    path.join(roaming, 'cmux', 'socket-control-password'),
    ...posix,
  ];
}

// The value is injected into the child environment and never printed, logged or
// returned to a caller that reports state.
function readMuxPassword(env, platform, home) {
  for (const candidate of muxPasswordCandidates(env, platform, home)) {
    try {
      const value = fs.readFileSync(candidate, 'utf8').trim();
      if (value) return { file: candidate, value };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function readProfileRemoteDev(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  return validateRemoteDev(parsed.remoteDev);
}

export function parseArgs(argv) {
  const options = {
    host: null,
    workspace: null,
    command: null,
    agent: null,
    transport: null,
    list: false,
    check: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      index += 1;
      if (index >= argv.length) throw new Error(`${name} requires a value`);
      return argv[index];
    };
    if (arg === '--list') options.list = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--host' || arg.startsWith('--host=')) options.host = take('--host');
    else if (arg === '--command' || arg.startsWith('--command=')) options.command = take('--command');
    else if (arg === '--agent' || arg.startsWith('--agent=')) options.agent = take('--agent');
    else if (arg === '--transport' || arg.startsWith('--transport=')) options.transport = take('--transport');
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (options.workspace === null) options.workspace = arg;
    else throw new Error('only one workspace name is accepted');
  }
  if (options.agent !== null) {
    if (!Object.hasOwn(AGENTS, options.agent)) {
      throw new Error(`unknown agent "${options.agent}" (known: ${Object.keys(AGENTS).join(', ')})`);
    }
    if (options.command !== null) throw new Error('--agent and --command are mutually exclusive');
  }
  if (options.transport !== null && !TRANSPORTS.includes(options.transport)) {
    throw new Error(`--transport must be one of ${TRANSPORTS.join('|')}`);
  }
  return options;
}

// Resolves everything that decides what will be launched, without launching it.
// Kept pure so --check and the real run report exactly the same target.
export function planLaunch(options, remoteDev, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const host = resolveHost(remoteDev, options.host);
  const agent = options.agent ? AGENTS[options.agent] : null;
  const command = agent ? agent.command : options.command;
  const workspace = options.workspace || (agent ? agent.workspace : host.defaultWorkspace);
  if (!WORKSPACE_PATTERN.test(workspace)) {
    throw new Error(`invalid workspace name "${workspace}"; use letters, digits, dot, underscore or hyphen`);
  }

  const requested = options.transport || env.RDEV_TRANSPORT || remoteDev.transport;
  if (!TRANSPORTS.includes(requested)) throw new Error(`invalid transport: ${requested}`);

  const muxBin = requested === 'ssh' ? null : findMuxBinary({ env, platform, home, explicit: host.muxBin });
  let transport = requested;
  let reason = 'requested';
  if (requested === 'auto') {
    transport = muxBin ? 'mux' : 'ssh';
    reason = muxBin ? 'mux binary found' : 'no mux binary found';
  } else if (requested === 'mux' && !muxBin) {
    throw new Error('transport "mux" was requested but no Mux/cmux executable was found; install it or use --transport ssh');
  }

  const plan = {
    host,
    workspace,
    command: command || null,
    transport,
    reason,
    muxBin,
    // A fallback is only offered when the transport was not pinned by the user.
    allowFallback: requested === 'auto',
  };

  // Build the SSH command eagerly whenever it could be used, so an unusable
  // combination (zellij plus a workspace command) fails during --check rather
  // than only once Mux has already given up.
  if (plan.transport === 'ssh' || plan.allowFallback) buildSshArgs(host, plan);
  return plan;
}

function usage() {
  return `rdev - open a remote development workspace

Usage:
  rdev [options] [workspace]

Options:
  --host NAME        Host entry from the machine profile (default: profile defaultHost)
  --agent NAME       Launch a known agent in the workspace (${Object.keys(AGENTS).join('|')})
  --command CMD      Run this command in the workspace instead of a login shell
  --transport T      Force a transport (${TRANSPORTS.join('|')}); default comes from the profile
  --list             List the hosts configured in the machine profile
  --check            Print the resolved target and transport without connecting
  -h, --help         Show this help

Hosts, aliases and transports come from remoteDev in
HOME/.config/cc-portable-bootstrap/profile.json (mode 600, never committed).
`;
}

function fail(message) {
  process.stderr.write(`rdev: ${message}\n`);
  process.exit(1);
}

function launchProcess(binary, args, { env, description, onEarlyFailure = null }) {
  const started = Date.now();
  const child = spawn(binary, args, { env, stdio: 'inherit', windowsHide: true });
  // A failed spawn can emit both 'error' and 'exit'; the retry must happen once.
  let settled = false;
  const settle = (handler) => {
    if (settled) return;
    settled = true;
    handler();
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try { child.kill(signal); } catch { /* the child is already gone */ }
    });
  }
  child.on('error', (error) => settle(() => {
    if (onEarlyFailure) onEarlyFailure(`${description} could not start: ${error.message}`);
    else fail(`unable to launch ${description}: ${error.message}`);
  }));
  child.on('exit', (code, signal) => settle(() => {
    const elapsed = Date.now() - started;
    // A Mux build that refuses the connection exits immediately; a real session
    // the user closed does not. Only the former is worth retrying.
    if (onEarlyFailure && code !== 0 && elapsed < 5000) {
      onEarlyFailure(`${description} exited with code ${code} after ${elapsed}ms`);
      return;
    }
    if (Number.isInteger(code)) process.exit(code);
    const signalNumber = signal ? os.constants.signals[signal] : undefined;
    process.exit(Number.isInteger(signalNumber) ? 128 + signalNumber : 1);
  }));
}

function nudgeMuxApp(muxBin, platform) {
  if (platform !== 'darwin') return;
  const match = /^(.*\.app)\//.exec(muxBin);
  if (!match) return;
  // -g keeps focus in the current terminal; a running app makes this a no-op.
  spawnSync('open', ['-ga', match[1]], { stdio: 'ignore' });
}

function runSsh(plan, env) {
  launchProcess('ssh', buildSshArgs(plan.host, plan), { env, description: 'ssh' });
}

function main(argv, env = process.env, platform = process.platform, home = os.homedir()) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const profileFile = env.RDEV_PROFILE_FILE?.trim() || profilePathFor(env, home);
  let remoteDev;
  try {
    remoteDev = readProfileRemoteDev(profileFile);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (!remoteDev) {
    fail(`no remoteDev hosts configured; add a remoteDev section to ${profileFile} (see templates/profile.example.json)`);
    return;
  }

  if (options.list) {
    for (const host of remoteDev.hosts) {
      const marks = [host.name === remoteDev.defaultHost ? 'default' : null, host.label].filter(Boolean);
      process.stdout.write(`${host.name}\t${host.sshAlias}\t${host.defaultWorkspace}\t${marks.join(',') || '-'}\n`);
    }
    return;
  }

  let plan;
  try {
    plan = planLaunch(options, remoteDev, { env, platform, home });
  } catch (error) {
    fail(error.message);
    return;
  }

  const childEnv = { ...env };
  let password = null;
  if (plan.transport === 'mux') {
    password = readMuxPassword(env, platform, home);
    if (password) {
      childEnv.MUX_SOCKET_PASSWORD = password.value;
      childEnv.CMUX_SOCKET_PASSWORD = password.value;
    }
  }

  if (options.check) {
    process.stdout.write(`rdev check: profile ${profileFile}\n`);
    process.stdout.write(`rdev check: host ${plan.host.name} via ssh alias ${plan.host.sshAlias}\n`);
    process.stdout.write(`rdev check: workspace ${plan.workspace}${plan.command ? ` running ${plan.command}` : ''}\n`);
    process.stdout.write(`rdev check: transport ${plan.transport} (${plan.reason})\n`);
    if (plan.transport === 'mux') {
      process.stdout.write(`rdev check: mux binary ${plan.muxBin}\n`);
      process.stdout.write(password
        ? `rdev check: mux socket password file present at ${password.file} (value not shown)\n`
        : 'rdev check: no mux socket password file found; Mux must allow this client another way\n');
    } else {
      process.stdout.write(`rdev check: remote multiplexer ${plan.host.multiplexer}\n`);
    }
    if (plan.allowFallback && plan.transport === 'mux') {
      process.stdout.write('rdev check: ssh fallback is available if Mux fails to attach\n');
    }
    return;
  }

  if (plan.transport === 'ssh') {
    runSsh(plan, childEnv);
    return;
  }

  nudgeMuxApp(plan.muxBin, platform);
  launchProcess(plan.muxBin, buildMuxArgs(plan.host, plan), {
    env: childEnv,
    description: 'mux',
    onEarlyFailure: plan.allowFallback
      ? (why) => {
        process.stderr.write(`rdev: ${why}; falling back to ssh\n`);
        runSsh(plan, { ...env });
      }
      : null,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
