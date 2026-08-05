import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENTS,
  DEFAULT_REMOTE_PATH,
  buildMuxArgs,
  buildSshArgs,
  findMuxBinary,
  muxPasswordCandidates,
  parseArgs,
  planLaunch,
  profilePathFor,
  remoteCommand,
  resolveHost,
  shellQuote,
  validateRemoteDev,
} from '../templates/rdev-exec.mjs';
import { profilePath, validateProfile, writeProfile, readProfile, defaultProfile } from '../core/profile.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

const HOST = { name: 'hub', sshAlias: 'hub-alias' };

function remoteDevWith(hosts, overrides = {}) {
  return validateRemoteDev({ hosts, ...overrides });
}

test('the shipped example profile validates and carries no real remote topology', () => {
  const raw = fs.readFileSync(path.join(repository, 'templates/profile.example.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const validated = validateProfile(parsed);
  assert.equal(validated.remoteDev.hosts.length, 1);
  // Placeholders only: no address, no port, no resolvable alias.
  assert.doesNotMatch(raw, /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./);
  for (const host of validated.remoteDev.hosts) {
    assert.match(host.sshAlias, /^my-/);
  }
});

test('remoteDev is optional and absent stays absent', () => {
  const base = validateProfile(defaultProfile());
  assert.equal(Object.hasOwn(base, 'remoteDev'), false);
  assert.equal(validateRemoteDev(undefined), null);
  assert.equal(validateRemoteDev(null), null);
});

test('remoteDev validation rejects unusable hosts', () => {
  assert.throws(() => validateRemoteDev({ hosts: [] }), /non-empty array/);
  assert.throws(() => validateRemoteDev({ hosts: [{ name: 'a b', sshAlias: 'x' }] }), /host name must match/);
  assert.throws(
    () => validateRemoteDev({ hosts: [HOST, { name: 'hub', sshAlias: 'other' }] }),
    /duplicate remoteDev host name/,
  );
  // An alias reaches ssh argv and one day maybe a shell; refuse metacharacters.
  assert.throws(
    () => validateRemoteDev({ hosts: [{ name: 'hub', sshAlias: 'host; rm -rf /' }] }),
    /shell metacharacters/,
  );
  assert.throws(
    () => validateRemoteDev({ hosts: [{ name: 'hub', sshAlias: '-oProxyCommand=x' }] }),
    /must not start with "-"/,
  );
  assert.throws(
    () => validateRemoteDev({ hosts: [{ ...HOST, defaultWorkspace: 'has space' }] }),
    /defaultWorkspace must match/,
  );
  assert.throws(
    () => validateRemoteDev({ hosts: [{ ...HOST, multiplexer: 'byobu' }] }),
    /multiplexer must be one of/,
  );
  assert.throws(
    () => validateRemoteDev({ hosts: [{ ...HOST, remotePath: ['/bin; rm -rf /'] }] }),
    /remotePath entry must be/,
  );
  assert.throws(() => validateRemoteDev({ hosts: [HOST], transport: 'telnet' }), /transport must be one of/);
  assert.throws(
    () => validateRemoteDev({ hosts: [HOST], defaultHost: 'absent' }),
    /defaultHost is not one of the configured hosts/,
  );
});

test('remoteDev defaults fill in without inventing topology', () => {
  const remoteDev = remoteDevWith([HOST]);
  assert.equal(remoteDev.transport, 'auto');
  assert.equal(remoteDev.defaultHost, 'hub');
  assert.deepEqual(remoteDev.hosts[0], {
    name: 'hub',
    sshAlias: 'hub-alias',
    defaultWorkspace: 'dev',
    multiplexer: 'auto',
    remotePath: [...DEFAULT_REMOTE_PATH],
  });
  assert.equal(resolveHost(remoteDev).name, 'hub');
  assert.throws(() => resolveHost(remoteDev, 'nope'), /unknown host "nope"/);
});

test('profiles carrying remoteDev round-trip on disk', () => {
  const file = path.join(temporaryDirectory('remotedev-io'), 'profile.json');
  const written = writeProfile(file, {
    ...defaultProfile(),
    remoteDev: { hosts: [{ name: 'hub', sshAlias: 'hub-alias', label: 'HUB' }] },
  });
  assert.equal(written.remoteDev.hosts[0].label, 'HUB');
  assert.deepEqual(readProfile(file), written);
});

test('the launcher resolves the profile path exactly like the core module', () => {
  // rdev-exec.mjs is installed flat and cannot import core/profile.mjs, so its
  // copy of the lookup is pinned against the original here.
  const home = path.join(os.tmpdir(), 'rdev-home');
  const cases = [
    [{}, home],
    [{ XDG_CONFIG_HOME: path.join(os.tmpdir(), 'xdg') }, home],
    [{ CC_BOOTSTRAP_PROFILE_FILE: path.join(os.tmpdir(), 'custom.json') }, home],
  ];
  for (const [env, homeDir] of cases) {
    assert.equal(profilePathFor(env, homeDir), profilePath(env, homeDir));
  }
});

test('everything interpolated into the remote command is single-quoted', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const command = remoteCommand({ workspace: 'dev', command: "echo 'hi'; rm -rf /", multiplexer: 'none' });
  // The injected semicolon stays inside the quoted argument.
  assert.match(command, /exec \$\{SHELL:-\/bin\/sh\} -lc 'echo '\\''hi'\\''; rm -rf \/'$/);
});

test('the remote command honours the selected multiplexer', () => {
  const plain = remoteCommand({ workspace: 'dev', multiplexer: 'auto', remotePath: [] });
  // Probed by running each candidate: a stale Homebrew build stays on PATH long
  // after its linked libraries are gone, and `command -v` would still find it.
  assert.equal(
    plain,
    "if tmux -V >/dev/null 2>&1; then exec tmux new-session -A -s 'dev'"
    + "; elif zellij --version >/dev/null 2>&1; then exec zellij attach --create 'dev'"
    + '; else exec ${SHELL:-/bin/sh} -l; fi',
  );
  assert.doesNotMatch(plain, /command -v/);

  // With a workspace command, zellij is skipped in auto because it cannot run one.
  const agent = remoteCommand({ workspace: 'claude-code', command: 'claude', multiplexer: 'auto', remotePath: [] });
  assert.match(agent, /exec tmux new-session -A -s 'claude-code' 'claude'/);
  assert.doesNotMatch(agent, /zellij/);

  assert.equal(remoteCommand({ workspace: 'dev', multiplexer: 'none', remotePath: [] }), 'exec ${SHELL:-/bin/sh} -l');
  assert.match(remoteCommand({ workspace: 'dev', multiplexer: 'zellij', remotePath: [] }), /^exec zellij attach --create 'dev'$/);
  assert.throws(
    () => remoteCommand({ workspace: 'dev', command: 'claude', multiplexer: 'zellij' }),
    /zellij cannot start a workspace command/,
  );
  assert.throws(() => remoteCommand({ workspace: 'bad name' }), /invalid workspace name/);
});

test('the remote PATH prefix expands ~ without letting the remote shell expand anything else', () => {
  const command = remoteCommand({ workspace: 'dev', multiplexer: 'none', remotePath: ['/opt/x', '~/.local/bin'] });
  assert.match(command, /^PATH=\/opt\/x:\$HOME\/\.local\/bin:\$PATH; export PATH; /);
});

test('transport arguments name the alias, never an address', () => {
  const host = remoteDevWith([{ ...HOST, multiplexer: 'tmux', remotePath: [] }]).hosts[0];
  assert.deepEqual(buildMuxArgs(host, { workspace: 'dev' }), ['ssh', 'hub-alias', '--name', 'dev']);
  assert.deepEqual(
    buildMuxArgs(host, { workspace: 'claude-code', command: 'claude' }),
    ['ssh', 'hub-alias', '--name', 'claude-code', '--command', 'exec claude'],
  );
  const ssh = buildSshArgs(host, { workspace: 'dev' });
  assert.deepEqual(ssh.slice(0, 3), ['-t', 'hub-alias', '--']);
  assert.match(ssh[3], /^exec tmux new-session -A -s 'dev'$/);
});

test('argument parsing rejects ambiguous and unknown input', () => {
  assert.deepEqual(parseArgs(['build']).workspace, 'build');
  assert.deepEqual(parseArgs(['--host', 'hub', 'build']).host, 'hub');
  assert.deepEqual(parseArgs(['--host=hub']).host, 'hub');
  assert.equal(parseArgs(['--agent', 'claude']).agent, 'claude');
  assert.throws(() => parseArgs(['--agent', 'nope']), /unknown agent/);
  assert.throws(() => parseArgs(['--agent', 'claude', '--command', 'x']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--transport', 'telnet']), /--transport must be one of/);
  assert.throws(() => parseArgs(['a', 'b']), /only one workspace name/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--host']), /--host requires a value/);
});

test('auto transport falls back to ssh when no Mux build is present', () => {
  const remoteDev = remoteDevWith([HOST]);
  const empty = temporaryDirectory('rdev-nomux');
  const context = { env: { PATH: empty }, platform: 'linux', home: empty };

  const auto = planLaunch(parseArgs([]), remoteDev, context);
  assert.equal(auto.transport, 'ssh');
  assert.equal(auto.allowFallback, true);
  assert.equal(auto.workspace, 'dev');

  // A pinned transport is never silently downgraded.
  assert.throws(() => planLaunch(parseArgs(['--transport', 'mux']), remoteDev, context), /no Mux\/cmux executable/);
  const pinned = planLaunch(parseArgs(['--transport', 'ssh']), remoteDev, context);
  assert.equal(pinned.allowFallback, false);
});

test('a discovered Mux build wins under auto, and agents pick their own workspace', () => {
  const home = temporaryDirectory('rdev-mux');
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const muxBin = path.join(binDir, 'mux');
  fs.writeFileSync(muxBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const context = { env: { PATH: '' }, platform: 'linux', home };
  assert.equal(findMuxBinary({ ...context }), muxBin);

  const remoteDev = remoteDevWith([HOST]);
  const plan = planLaunch(parseArgs(['--agent', 'claude']), remoteDev, context);
  assert.equal(plan.transport, 'mux');
  assert.equal(plan.muxBin, muxBin);
  assert.equal(plan.workspace, AGENTS.claude.workspace);
  assert.equal(plan.command, AGENTS.claude.command);

  // An explicit workspace still overrides the agent default.
  assert.equal(planLaunch(parseArgs(['--agent', 'claude', 'review']), remoteDev, context).workspace, 'review');
  assert.throws(() => planLaunch(parseArgs(['bad name']), remoteDev, context), /invalid workspace name/);
});

test('an unusable multiplexer choice fails while planning, not after Mux gives up', () => {
  const remoteDev = remoteDevWith([{ ...HOST, multiplexer: 'zellij' }]);
  const empty = temporaryDirectory('rdev-zellij');
  assert.throws(
    () => planLaunch(parseArgs(['--agent', 'claude']), remoteDev, { env: { PATH: empty }, platform: 'linux', home: empty }),
    /zellij cannot start a workspace command/,
  );
});

test('Mux socket password lookup covers both product generations on every platform', () => {
  const home = path.join(os.tmpdir(), 'rdev-pw');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const candidates = muxPasswordCandidates({}, platform, home);
    assert.ok(candidates.some((file) => file.includes(`mux${path.sep}socket-control-password`)));
    assert.ok(candidates.some((file) => file.includes(`cmux${path.sep}socket-control-password`)));
  }
});

test('rdev sources carry no host name, address or port', () => {
  for (const name of ['templates/rdev-exec.mjs', 'templates/rdev.sh', 'templates/rdev.cmd']) {
    const raw = fs.readFileSync(path.join(repository, name), 'utf8');
    assert.doesNotMatch(raw, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${name} contains an address`);
    assert.doesNotMatch(raw, /\b(?:ssh|Host)\s+\w+@[\w.-]+/, `${name} contains a login target`);
  }
});
