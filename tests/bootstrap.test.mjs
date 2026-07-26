import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CODEX_BEGIN,
  CODEX_END,
  PATH_BEGIN,
  PATH_END,
  parseMcpGet,
  updateCodexManagedBlock,
  updateProfile,
  withPinnedManagedParent,
} from '../core/bootstrap.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const BOOTSTRAP = path.join(ROOT_DIR, 'core', 'bootstrap.mjs');
const SANDBOX_ROOT = path.join(TEST_DIR, '.sandbox');
const SECRET_SENTINEL = 'secret-value-must-never-appear';

function makeSandbox(name) {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SANDBOX_ROOT, `${name}-`));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'stable-bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

function cleanupSandbox(sandbox) {
  fs.rmSync(sandbox.root, { recursive: true, force: true });
  try {
    if (fs.readdirSync(SANDBOX_ROOT).length === 0) fs.rmdirSync(SANDBOX_ROOT);
  } catch {
    // Another test may still own a sandbox.
  }
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

// Windows cannot execute an extensionless shell script, so the fake binaries are
// written as a Node script plus a .cmd shim there. That is also what npm produces
// for a globally installed CLI, so these fixtures exercise the same batch-shim
// path the installer has to handle in practice.
const FAKE_SUFFIX = process.platform === 'win32' ? '.cmd' : '';

export function fakeBinaryPath(file) {
  return `${file}${FAKE_SUFFIX}`;
}

function writeFakeBinary(file, nodeSource) {
  if (process.platform !== 'win32') {
    writeExecutable(file, `#!/usr/bin/env node\n${nodeSource}`);
    return `${file}`;
  }
  const script = `${file}.mjs`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(script, nodeSource, 'utf8');
  // %* forwards arguments verbatim; @echo off keeps the banner out of stdout.
  fs.writeFileSync(`${file}.cmd`, `@echo off\r\nnode "%~dp0${path.basename(script)}" %*\r\n`, 'utf8');
  return `${file}.cmd`;
}

function createFakeCodex(file) {
  return writeFakeBinary(file, `
const args = process.argv.slice(2);
if (args[0] === 'mcp-server' && args[1] === '--help') {
  console.log('Start Codex as an MCP server (stdio)');
  process.exit(0);
}
process.exit(2);
`);
}

function createFakeClaude(file) {
  return writeFakeBinary(file, `
import fs from 'node:fs';
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CLAUDE_STATE;
const launchFile = process.env.FAKE_CLAUDE_LAUNCH;
const readState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return { mcp: { present: false }, actions: [] }; }
};
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const state = readState();
state.actions ||= [];

if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'codex') {
  if (process.env.FAKE_MCP_GET_FAIL === '1') {
    console.error('temporary MCP inspection failure');
    process.exit(2);
  }
  state.getCount = Number(state.getCount || 0) + 1;
  // Mirror the real CLI: CLAUDE_CONFIG_DIR moves where user-scope servers are
  // read from, so a wrongly-pinned value must look like "no server registered".
  state.getConfigDirs ||= [];
  state.getConfigDirs.push(process.env.CLAUDE_CONFIG_DIR ?? null);
  writeState(state);
  if (process.env.FAKE_MCP_REQUIRE_DEFAULT_CONFIG_DIR === '1' && process.env.CLAUDE_CONFIG_DIR) {
    console.error('No MCP server named "codex". Configured servers: none');
    process.exit(0);
  }
  if (!state.mcp?.present) {
    console.error('No MCP server found with name: codex');
    process.exit(1);
  }
  console.log('codex:');
  console.log('  Scope: ' + (state.mcp.scope || 'User config (available in all your projects)'));
  console.log('  Status: ✔ Connected');
  console.log('  Type: ' + (state.mcp.type || 'stdio'));
  console.log('  Command: ' + state.mcp.command);
  console.log('  Args: ' + (state.mcp.args || []).join(' '));
  if (state.mcp.environmentInline) {
    console.log('  Environment: TOKEN=' + (process.env.FAKE_MCP_SECRET || 'hidden-environment-value'));
  } else {
    console.log('  Environment:');
  }
  if (state.mcp.hasEnvironment) console.log('    TOKEN=' + (process.env.FAKE_MCP_SECRET || 'hidden-environment-value'));
  console.log('');
  console.log('To remove this server, run: claude mcp remove codex -s user');
  if (Number(process.env.FAKE_MCP_DELETE_AFTER_GET || 0) === state.getCount) {
    state.mcp = { present: false };
    writeState(state);
  } else if (Number(process.env.FAKE_MCP_SWAP_AFTER_GET || 0) === state.getCount) {
    state.mcp = {
      present: true,
      scope: 'User config (available in all your projects)',
      type: 'stdio',
      command: process.env.FAKE_MCP_CONCURRENT_COMMAND,
      args: ['mcp-server'],
      hasEnvironment: false,
    };
    writeState(state);
  }
  process.exit(0);
}

if (args[0] === 'mcp' && args[1] === 'remove') {
  state.actions.push({ type: 'remove', args });
  state.mcp = { present: false };
  writeState(state);
  process.exit(0);
}

if (args[0] === 'mcp' && args[1] === 'add') {
  const separator = args.indexOf('--');
  state.actions.push({ type: 'add', args, configDir: process.env.CLAUDE_CONFIG_DIR });
  if (process.env.FAKE_MCP_ADD_NOOP !== '1') {
    state.mcp = {
      present: true,
      scope: 'User config (available in all your projects)',
      type: 'stdio',
      command: args[separator + 1],
      args: args.slice(separator + 2),
      hasEnvironment: false,
    };
  }
  writeState(state);
  if (process.env.FAKE_BREAK_BOOTSTRAP_STATE === '1') {
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR + '/portable-bootstrap/state.json', { recursive: true });
  }
  process.exit(process.env.FAKE_MCP_ADD_FAIL === '1' ? 1 : 0);
}

if (args[0] === 'plugin' && args[1] === 'list') {
  console.log(process.env.FAKE_PLUGIN_INSTALLED === '1'
    ? JSON.stringify([{ id: 'cliproxy-usage@local', enabled: true }])
    : '[]');
  process.exit(0);
}

if (launchFile) {
  fs.writeFileSync(launchFile, JSON.stringify({
    args,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    apiKeyPresent: Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY'),
    subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
    concurrency: process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY,
    compactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    toolSearch: process.env.ENABLE_TOOL_SEARCH,
    inheritedMarker: process.env.CURRENT_ENV_MARKER,
  }, null, 2));
}
process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
`);
}

// Windows installs claudex.ps1 plus a .cmd shim; POSIX installs one extensionless
// launcher. Tests assert on whichever this platform is supposed to produce.
const CLAUDEX_LAUNCHERS = process.platform === 'win32'
  ? ['claudex.ps1', 'claudex.cmd']
  : ['claudex'];

function claudexInstalled(claudeDir) {
  return CLAUDEX_LAUNCHERS.every((name) => fs.existsSync(path.join(claudeDir, 'bin', name)));
}

function claudexAbsent(claudeDir) {
  return CLAUDEX_LAUNCHERS.every((name) => !fs.existsSync(path.join(claudeDir, 'bin', name)));
}

function createSecret(home) {
  const directory = path.join(home, '.secrets');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'cliproxy_apikey'), `${SECRET_SENTINEL}\n`, { mode: 0o600 });
}

function runBootstrap(sandbox, action, extra = [], env = {}) {
  // --no-provision keeps these tests hermetic: dependency provisioning probes
  // endpoints and shells out to real installers. Provisioning has its own
  // dedicated suites (profile/deps/service) that stub every side effect.
  const provisionFlag = extra.includes('--provision') ? [] : ['--no-provision'];
  return spawnSync(process.execPath, [
    BOOTSTRAP,
    action,
    '--home', sandbox.home,
    '--config-dir', path.join(sandbox.home, '.claude'),
    '--claude', sandbox.claude,
    ...provisionFlag,
    ...extra.filter((argument) => argument !== '--provision'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandbox.home,
      FAKE_CLAUDE_STATE: sandbox.state,
      ...env,
    },
  });
}

function stateOf(sandbox) {
  return JSON.parse(fs.readFileSync(sandbox.state, 'utf8'));
}

function backupIds(home) {
  const directory = path.join(home, '.claude', 'portable-bootstrap', 'backups');
  try { return fs.readdirSync(directory).sort(); }
  catch { return []; }
}

function fixtureSandbox(name) {
  const sandbox = makeSandbox(name);
  sandbox.state = path.join(sandbox.root, 'fake-claude-state.json');
  // On Windows these come back with a .cmd suffix, so the paths handed to
  // --claude/--codex must be whatever was actually written.
  sandbox.claude = createFakeClaude(path.join(sandbox.bin, 'claude'));
  sandbox.codex = createFakeCodex(path.join(sandbox.bin, 'codex'));
  fs.writeFileSync(sandbox.state, JSON.stringify({ mcp: { present: false }, actions: [] }));
  return sandbox;
}

test('setup is idempotent, migrates managed content, and restore rolls it back', () => {
  const sandbox = fixtureSandbox('setup-restore');
  try {
    createSecret(sandbox.home);
    const claudeDir = path.join(sandbox.home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const originalClaudeMd = `# User rule\n\nKeep this.\n\n# Claude 调度 + Codex 实现模式\n\n- old rule\n\n# Following section\n\nStill here.\n`;
    const originalProfile = `export EXISTING=1\n\n# claudex: old proxy launcher for gpt-5.6-sol\nclaudex(){\n  key=$(cat ~/.secrets/cliproxy_apikey)\n  ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \\\n  CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol claude \"$@\"\n}\n`;
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), originalClaudeMd);
    fs.writeFileSync(path.join(sandbox.home, '.zshrc'), originalProfile);
    const protectedConfig = path.join(sandbox.home, '.claude.json');
    fs.writeFileSync(protectedConfig, 'must-not-be-read-or-changed');
    fs.chmodSync(protectedConfig, 0o000);

    const first = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--profile', path.join(sandbox.home, '.zshrc'),
      '--yes',
    ], { CLAUDE_CONFIG_DIR: path.join(sandbox.root, 'must-not-be-used') });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.doesNotMatch(`${first.stdout}${first.stderr}`, new RegExp(SECRET_SENTINEL));

    const installedClaudeMd = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    assert.equal((installedClaudeMd.match(/BEGIN cc-portable-bootstrap:codex-mode/g) || []).length, 1);
    assert.match(installedClaudeMd, /threadId/);
    assert.match(installedClaudeMd, /gpt-5\.6-sol/);
    assert.match(installedClaudeMd, /approval-policy.*never/);
    assert.match(installedClaudeMd, /read-only/);
    assert.match(installedClaudeMd, /workspace-write/);
    assert.match(installedClaudeMd, /禁止 `danger-full-access`/);
    assert.match(installedClaudeMd, /# Following section/);
    assert.doesNotMatch(installedClaudeMd, /- old rule/);

    const installedProfile = fs.readFileSync(path.join(sandbox.home, '.zshrc'), 'utf8');
    assert.doesNotMatch(installedProfile, /claudex\s*\(\)\s*\{/);
    assert.match(installedProfile, /cc-portable-bootstrap PATH/);
    assert.ok(claudexInstalled(claudeDir));

    // The status line is installed by the same run; there is no second installer.
    const statuslineDir = path.join(claudeDir, 'cc-portable-bootstrap');
    assert.ok(fs.existsSync(path.join(statuslineDir, 'runtime.mjs')));
    // Windows installs statusline.cmd; POSIX installs the extensionless launcher.
    const statuslineLauncher = process.platform === 'win32' ? 'statusline.cmd' : 'statusline';
    assert.ok(fs.existsSync(path.join(statuslineDir, statuslineLauncher)));
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.match(settings.statusLine.command, /cc-portable-bootstrap\/statusline/);
    assert.equal(settings.statusLine.refreshInterval, 3);

    const fakeState = stateOf(sandbox);
    assert.equal(fakeState.mcp.present, true);
    assert.equal(fs.realpathSync(fakeState.mcp.command), fs.realpathSync(sandbox.codex));
    assert.deepEqual(fakeState.mcp.args, ['mcp-server']);
    const addAction = fakeState.actions.find((action) => action.type === 'add');
    assert.equal(addAction.configDir, path.join(sandbox.home, '.claude'));

    const idsAfterFirst = backupIds(sandbox.home);
    assert.equal(idsAfterFirst.length, 1);
    const manifestPath = path.join(claudeDir, 'portable-bootstrap', 'backups', idsAfterFirst[0], 'manifest.json');
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    assert.doesNotMatch(manifestText, new RegExp(SECRET_SENTINEL));
    assert.doesNotMatch(manifestText, /\.claude\.json/);

    const second = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--profile', path.join(sandbox.home, '.zshrc'),
      '--yes',
    ]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /already current/);
    assert.deepEqual(backupIds(sandbox.home), idsAfterFirst);

    const check = runBootstrap(sandbox, 'check', [
      '--codex', sandbox.codex,
      '--profile', path.join(sandbox.home, '.zshrc'),
    ]);
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.doesNotMatch(`${check.stdout}${check.stderr}`, new RegExp(SECRET_SENTINEL));

    const blockedRestore = runBootstrap(sandbox, 'restore', ['--yes']);
    assert.equal(blockedRestore.status, 1);
    assert.match(blockedRestore.stderr, /no compare-and-swap remove/);
    assert.equal(stateOf(sandbox).mcp.present, true);
    assert.match(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), /BEGIN cc-portable-bootstrap/);

    const manuallyRemoved = stateOf(sandbox);
    manuallyRemoved.mcp = { present: false };
    fs.writeFileSync(sandbox.state, JSON.stringify(manuallyRemoved, null, 2));
    const restored = runBootstrap(sandbox, 'restore', ['--yes']);
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), originalClaudeMd);
    assert.equal(fs.readFileSync(path.join(sandbox.home, '.zshrc'), 'utf8'), originalProfile);
    assert.ok(claudexAbsent(claudeDir));
    assert.equal(stateOf(sandbox).mcp.present, false);

    fs.chmodSync(protectedConfig, 0o600);
    assert.equal(fs.readFileSync(protectedConfig, 'utf8'), 'must-not-be-read-or-changed');
  } finally {
    try { fs.chmodSync(path.join(sandbox.home, '.claude.json'), 0o600); } catch {}
    cleanupSandbox(sandbox);
  }
});

test('dry-run writes no files, backups, or MCP configuration', () => {
  const sandbox = fixtureSandbox('dry-run');
  try {
    createSecret(sandbox.home);
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--profile', path.join(sandbox.home, '.profile'),
      '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Dry-run complete/);
    assert.equal(fs.existsSync(path.join(sandbox.home, '.claude', 'CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(sandbox.home, '.profile')), false);
    assert.deepEqual(backupIds(sandbox.home), []);
    assert.equal(stateOf(sandbox).mcp.present, false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(SECRET_SENTINEL));
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('the Claude CLI is not told a config dir the user did not choose', () => {
  const sandbox = fixtureSandbox('mcp-config-dir');
  try {
    createSecret(sandbox.home);
    // Pre-register the MCP the way a real machine would have it.
    fs.writeFileSync(sandbox.state, JSON.stringify({
      mcp: { present: true, command: sandbox.codex, args: ['mcp-server'] },
      actions: [],
    }, null, 2));

    // Without an explicit --config-dir, bootstrap must leave CLAUDE_CONFIG_DIR
    // alone. Pinning it makes `claude mcp` read <configDir>/.claude.json rather
    // than ~/.claude.json, so an existing registration looks missing and setup
    // would write a shadow one into the wrong file.
    const check = spawnSync(process.execPath, [
      BOOTSTRAP, 'check',
      '--home', sandbox.home,
      '--claude', sandbox.claude,
      '--codex', sandbox.codex,
      '--no-provision',
      '--no-profile',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: sandbox.home,
        FAKE_CLAUDE_STATE: sandbox.state,
        FAKE_MCP_REQUIRE_DEFAULT_CONFIG_DIR: '1',
        CLAUDE_CONFIG_DIR: undefined,
      },
    });

    assert.match(check.stdout, /Codex MCP: user-scope stdio registration is current/);
    const observed = stateOf(sandbox).getConfigDirs || [];
    assert.ok(observed.length > 0, 'expected the fake CLI to be invoked');
    assert.ok(
      observed.every((value) => value === null),
      `CLAUDE_CONFIG_DIR must stay unset, saw ${JSON.stringify(observed)}`,
    );
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('upgrading from predecessor markers rewrites them instead of duplicating', () => {
  const sandbox = fixtureSandbox('legacy-markers');
  try {
    createSecret(sandbox.home);
    const claudeDir = path.join(sandbox.home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Exactly what claude-portable-bootstrap left behind on an already-migrated machine.
    const legacyClaudeMd = [
      '# User rule',
      '',
      '<!-- BEGIN claude-portable-bootstrap:codex-mode -->',
      '# Claude 调度 + Codex 实现模式',
      '',
      '- superseded body',
      '<!-- END claude-portable-bootstrap:codex-mode -->',
      '# Trailing section',
      '',
      'Keep this.',
      '',
    ].join('\n');
    const legacyProfile = [
      'export KEEP=1',
      '',
      '# >>> claude-portable-bootstrap PATH >>>',
      'claude_portable_bin="$HOME/.claude/bin"',
      'case ":$PATH:" in',
      '  *":$claude_portable_bin:"*) ;;',
      '  *) export PATH="$claude_portable_bin:$PATH" ;;',
      'esac',
      'unset claude_portable_bin',
      '# <<< claude-portable-bootstrap PATH <<<',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), legacyClaudeMd);
    fs.writeFileSync(path.join(sandbox.home, '.zshrc'), legacyProfile);

    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--profile', path.join(sandbox.home, '.zshrc'),
      '--yes',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const claudeMd = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    assert.equal((claudeMd.match(/BEGIN cc-portable-bootstrap:codex-mode/g) || []).length, 1);
    assert.equal((claudeMd.match(/END cc-portable-bootstrap:codex-mode/g) || []).length, 1);
    assert.doesNotMatch(claudeMd, /claude-portable-bootstrap/);
    assert.doesNotMatch(claudeMd, /superseded body/);
    assert.match(claudeMd, /# User rule/);
    assert.match(claudeMd, /# Trailing section/);
    assert.match(claudeMd, /threadId/);

    const profile = fs.readFileSync(path.join(sandbox.home, '.zshrc'), 'utf8');
    assert.equal((profile.match(/cc-portable-bootstrap PATH/g) || []).length, 2);
    assert.doesNotMatch(profile, /claude_portable_bin/);
    assert.match(profile, /export KEEP=1/);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('a file carrying both current and predecessor markers fails closed', () => {
  const mixed = [
    '<!-- BEGIN claude-portable-bootstrap:codex-mode -->',
    'legacy',
    '<!-- END claude-portable-bootstrap:codex-mode -->',
    CODEX_BEGIN,
    'current',
    CODEX_END,
  ].join('\n');
  assert.throws(
    () => updateCodexManagedBlock(mixed, '# replacement'),
    /current and legacy managed markers/,
  );
});

test('managed text preserves BOM/CRLF and rejects malformed markers', () => {
  const original = `﻿${CODEX_BEGIN}\r\n# stale\r\n${CODEX_END}\r\n\r\n# Keep\r\n`;
  const updated = updateCodexManagedBlock(original, '# Claude 调度 + Codex 实现模式\n\n- current');
  assert.ok(updated.startsWith('﻿'));
  assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
  assert.match(updated, /- current/);
  assert.match(updated, /# Keep/);
  assert.throws(
    () => updateCodexManagedBlock(`${CODEX_BEGIN}\nmissing end`, '# replacement'),
    /Malformed Codex managed block/,
  );
  assert.throws(
    () => updateCodexManagedBlock(`${CODEX_END}\nreversed\n${CODEX_BEGIN}`, '# replacement'),
    /Malformed Codex managed block/,
  );
  assert.throws(
    () => updateProfile(`${PATH_END}\nreversed\n${PATH_BEGIN}`, true),
    /Malformed PATH managed block/,
  );

  const noEnvironment = parseMcpGet('codex:\n  Scope: User config\n  Type: stdio\n  Command: /bin/codex\n  Args: mcp-server\n  Environment:\n  Timeout: 30000ms\n');
  assert.equal(noEnvironment.hasEnvironment, false);
  const inlineEnvironment = parseMcpGet('codex:\n  Scope: User config\n  Type: stdio\n  Command: /bin/codex\n  Args: mcp-server\n  Environment: TOKEN=hidden\n');
  assert.equal(inlineEnvironment.hasEnvironment, true);

  const profile = updateProfile('﻿export A=1\r\n', true).content;
  assert.ok(profile.startsWith('﻿'));
  assert.equal(profile.replaceAll('\r\n', '').includes('\n'), false);
  assert.match(profile, new RegExp(PATH_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Codex resolver skips cmux shim and selects a stable PATH binary', {
  // Relies on symlinks and extensionless PATH lookup; neither applies on Windows.
  skip: process.platform === 'win32',
}, () => {
  const sandbox = fixtureSandbox('resolver');
  try {
    createSecret(sandbox.home);
    const tempDir = path.join(sandbox.root, 'declared-temp');
    const shimDir = path.join(sandbox.root, 'cmux-cli-shims', 'session');
    const stableDir = path.join(sandbox.root, 'real-codex-bin');
    const versionedDir = path.join(sandbox.root, 'versions', '1.0.0');
    const temporary = path.join(tempDir, 'codex');
    const shim = path.join(shimDir, 'codex');
    const stable = path.join(stableDir, 'codex');
    const versioned = path.join(versionedDir, 'codex');
    createFakeCodex(temporary);
    createFakeCodex(shim);
    const versionedBinary = createFakeCodex(versioned);
    fs.mkdirSync(stableDir, { recursive: true });
    fs.symlinkSync(versionedBinary, fakeBinaryPath(stable));

    const result = runBootstrap(sandbox, 'setup', ['--no-profile', '--yes'], {
      TMPDIR: tempDir,
      PATH: `${tempDir}${path.delimiter}${shimDir}${path.delimiter}${stableDir}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fakeState = stateOf(sandbox);
    assert.equal(fakeState.mcp.command, stable);
    assert.equal(fs.realpathSync(fakeState.mcp.command), fs.realpathSync(versioned));
    assert.notEqual(fs.realpathSync(fakeState.mcp.command), fs.realpathSync(shim));
    assert.notEqual(fs.realpathSync(fakeState.mcp.command), fs.realpathSync(temporary));

    const backups = backupIds(sandbox.home);
    const repeated = runBootstrap(sandbox, 'setup', ['--no-profile', '--yes'], {
      TMPDIR: tempDir,
      PATH: `${tempDir}${path.delimiter}${shimDir}${path.delimiter}${stableDir}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.match(repeated.stdout, /already current/);
    assert.deepEqual(backupIds(sandbox.home), backups);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('MCP environment entries are not printed and block automatic replacement', () => {
  const sandbox = fixtureSandbox('mcp-env');
  try {
    createSecret(sandbox.home);
    fs.writeFileSync(sandbox.state, JSON.stringify({
      mcp: {
        present: true,
        command: path.join(sandbox.root, 'other-codex'),
        args: ['mcp-server'],
        hasEnvironment: false,
        environmentInline: true,
      },
      actions: [],
    }));
    const envSecret = 'fake-mcp-environment-secret';
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ], { FAKE_MCP_SECRET: envSecret });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to replace/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(envSecret));
    assert.deepEqual(backupIds(sandbox.home), []);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('check reports missing Claude without mutating or crashing', () => {
  const sandbox = fixtureSandbox('check-missing');
  try {
    fs.rmSync(sandbox.claude);
    const result = runBootstrap(sandbox, 'check', [
      '--codex', sandbox.codex,
      '--no-profile',
    ], { PATH: sandbox.bin });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stdout, /\[missing\] Claude CLI/);
    assert.doesNotMatch(result.stderr, /^error:/m);
    assert.deepEqual(backupIds(sandbox.home), []);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('setup refuses unknown MCP state, non-user scope, and sensitive arguments', () => {
  const scenarios = [
    {
      name: 'inspection-failure',
      state: { mcp: { present: false }, actions: [] },
      env: { FAKE_MCP_GET_FAIL: '1' },
      expected: /determine the existing Codex MCP registration safely/,
      secret: null,
    },
    {
      name: 'non-user-scope',
      state: {
        mcp: {
          present: true,
          scope: 'Local config (private to this project)',
          type: 'stdio',
          command: '/other/codex',
          args: ['mcp-server'],
          hasEnvironment: false,
        },
        actions: [],
      },
      env: {},
      expected: /not user scope/,
      secret: null,
    },
    {
      name: 'sensitive-args',
      state: {
        mcp: {
          present: true,
          scope: 'User config (available in all your projects)',
          type: 'stdio',
          command: '/other/codex',
          args: ['--token=do-not-copy-this-value'],
          hasEnvironment: false,
        },
        actions: [],
      },
      env: {},
      expected: /nonstandard arguments/,
      secret: 'do-not-copy-this-value',
    },
  ];

  for (const scenario of scenarios) {
    const sandbox = fixtureSandbox(`mcp-${scenario.name}`);
    try {
      createSecret(sandbox.home);
      fs.writeFileSync(sandbox.state, JSON.stringify(scenario.state));
      const result = runBootstrap(sandbox, 'setup', [
        '--codex', sandbox.codex,
        '--no-profile',
        '--yes',
      ], scenario.env);
      assert.equal(result.status, 1, `${scenario.name}: ${result.stderr || result.stdout}`);
      assert.match(result.stderr, scenario.expected);
      if (scenario.secret) assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(scenario.secret));
      assert.deepEqual(backupIds(sandbox.home), []);
      assert.deepEqual(stateOf(sandbox).actions, []);
    } finally {
      cleanupSandbox(sandbox);
    }
  }
});

test('setup verifies MCP registration and rolls files back when add is a no-op', () => {
  const sandbox = fixtureSandbox('mcp-verify');
  try {
    createSecret(sandbox.home);
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ], { FAKE_MCP_ADD_NOOP: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required postcondition/);
    assert.match(result.stderr, /setup rolled back/);
    assert.equal(fs.existsSync(path.join(sandbox.home, '.claude', 'CLAUDE.md')), false);
    assert.ok(claudexAbsent(path.join(sandbox.home, '.claude')));
    assert.equal(stateOf(sandbox).mcp.present, false);
    assert.equal(backupIds(sandbox.home).length, 1);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('setup accepts add that writes the expected MCP then returns nonzero', () => {
  const sandbox = fixtureSandbox('mcp-add-write-then-fail');
  try {
    createSecret(sandbox.home);
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ], { FAKE_MCP_ADD_FAIL: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(stateOf(sandbox).mcp.present, true);
    assert.equal(stateOf(sandbox).mcp.command, sandbox.codex);
    assert.equal(stateOf(sandbox).actions.filter((action) => action.type === 'add').length, 1);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('setup rollback preserves a concurrently replaced Codex MCP definition', () => {
  const sandbox = fixtureSandbox('mcp-concurrent-rollback');
  try {
    createSecret(sandbox.home);
    const concurrentCodex = createFakeCodex(path.join(sandbox.root, 'concurrent-codex'));
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ], {
      FAKE_MCP_SWAP_AFTER_GET: '4',
      FAKE_MCP_CONCURRENT_COMMAND: concurrentCodex,
      FAKE_BREAK_BOOTSTRAP_STATE: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rollback incomplete for MCP/);
    assert.match(result.stderr, /no compare-and-swap remove/);
    const state = stateOf(sandbox);
    assert.equal(state.mcp.command, concurrentCodex);
    assert.equal(state.actions.filter((action) => action.type === 'remove').length, 0);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('setup never recreates or removes a concurrently deleted different MCP', () => {
  const sandbox = fixtureSandbox('mcp-concurrent-delete');
  try {
    createSecret(sandbox.home);
    const previousCodex = createFakeCodex(path.join(sandbox.root, 'previous-codex'));
    fs.writeFileSync(sandbox.state, JSON.stringify({
      mcp: {
        present: true,
        scope: 'User config (available in all your projects)',
        type: 'stdio',
        command: previousCodex,
        args: ['mcp-server'],
        hasEnvironment: false,
      },
      actions: [],
    }));
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ], { FAKE_MCP_DELETE_AFTER_GET: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing automatic Codex MCP replacement/);
    assert.deepEqual(backupIds(sandbox.home), []);
    const state = stateOf(sandbox);
    assert.equal(state.mcp.present, false);
    assert.equal(state.actions.filter((action) => action.type === 'add').length, 0);
    assert.equal(state.actions.filter((action) => action.type === 'remove').length, 0);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('MCP mutation lock blocks overlapping bootstrap operations', () => {
  const sandbox = fixtureSandbox('mcp-operation-lock');
  try {
    createSecret(sandbox.home);
    const lockDirectory = path.join(sandbox.home, '.claude', 'portable-bootstrap');
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(path.join(lockDirectory, 'mcp-operation.lock'), 'active\n');
    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another bootstrap MCP operation is active/);
    assert.equal(stateOf(sandbox).mcp.present, false);
    assert.deepEqual(stateOf(sandbox).actions, []);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('restore preflight rejects a managed parent symlink changed outside HOME', () => {
  const sandbox = fixtureSandbox('restore-parent-symlink');
  try {
    createSecret(sandbox.home);
    const installed = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ]);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const backupsBefore = backupIds(sandbox.home);

    const binDir = path.join(sandbox.home, '.claude', 'bin');
    const savedBinDir = path.join(sandbox.home, 'saved-bin');
    const outsideDir = path.join(sandbox.root, 'outside-home');
    fs.renameSync(binDir, savedBinDir);
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideLauncher = path.join(outsideDir, 'claudex');
    fs.writeFileSync(outsideLauncher, 'outside-sentinel\n');
    fs.symlinkSync(outsideDir, binDir);

    const restored = runBootstrap(sandbox, 'restore', ['--dry-run']);
    assert.equal(restored.status, 1);
    assert.match(restored.stderr, /failed restore preflight/);
    assert.equal(fs.readFileSync(outsideLauncher, 'utf8'), 'outside-sentinel\n');
    assert.deepEqual(backupIds(sandbox.home), backupsBefore);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('pinned managed parent keeps relative deletion inside original directory', { skip: process.platform === 'win32' }, () => {
  const sandbox = makeSandbox('pinned-parent');
  try {
    const parent = path.join(sandbox.home, 'managed-parent');
    const savedParent = path.join(sandbox.home, 'saved-parent');
    const outside = path.join(sandbox.root, 'outside-parent');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(parent, 'target'), 'inside\n');
    fs.writeFileSync(path.join(outside, 'target'), 'outside\n');

    withPinnedManagedParent(path.join(parent, 'target'), { home: sandbox.home }, (basename) => {
      fs.renameSync(parent, savedParent);
      fs.symlinkSync(outside, parent);
      fs.unlinkSync(basename);
    });

    assert.equal(fs.existsSync(path.join(savedParent, 'target')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'target'), 'utf8'), 'outside\n');
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('restore rejects dot backup IDs without leaving the backups directory', () => {
  const sandbox = fixtureSandbox('backup-id-boundary');
  try {
    for (const id of ['.', '..']) {
      const result = runBootstrap(sandbox, 'restore', ['--backup', id, '--dry-run']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid backup ID/);
    }
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('setup preserves managed symlinks and existing HOME permissions', {
  // Symlink creation needs elevation on Windows and POSIX modes do not apply.
  skip: process.platform === 'win32',
}, () => {
  const sandbox = fixtureSandbox('symlink-profile');
  try {
    createSecret(sandbox.home);
    fs.chmodSync(sandbox.home, 0o755);
    const dotfiles = path.join(sandbox.home, 'dotfiles');
    const target = path.join(dotfiles, 'zshrc');
    const profile = path.join(sandbox.home, '.zshrc');
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.writeFileSync(target, 'export KEEP=1\n');
    fs.symlinkSync(target, profile);

    const result = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--profile', profile,
      '--yes',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.lstatSync(profile).isSymbolicLink(), true);
    assert.match(fs.readFileSync(target, 'utf8'), /cc-portable-bootstrap PATH/);
    assert.equal(fs.statSync(sandbox.home).mode & 0o777, 0o755);
  } finally {
    cleanupSandbox(sandbox);
  }
});

test('external-only backup restores without Claude and creates a safety backup', () => {
  const sandbox = fixtureSandbox('external-restore');
  try {
    createSecret(sandbox.home);
    const installed = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--yes',
    ]);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    const external = runBootstrap(sandbox, 'setup', [
      '--codex', sandbox.codex,
      '--no-profile',
      '--external-change', 'Windows User PATH',
      '--yes',
    ]);
    assert.equal(external.status, 0, external.stderr || external.stdout);
    const externalId = external.stdout.match(/Setup complete\. Backup: (\S+)/)?.[1];
    assert.ok(externalId);
    const manifest = JSON.parse(fs.readFileSync(path.join(
      sandbox.home, '.claude', 'portable-bootstrap', 'backups', externalId, 'manifest.json',
    ), 'utf8'));
    assert.deepEqual(manifest.externalChanges, ['Windows User PATH']);
    assert.equal(manifest.mcp.changed, false);

    fs.rmSync(sandbox.claude);
    const restored = runBootstrap(sandbox, 'restore', ['--backup', externalId, '--yes']);
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.match(restored.stdout, /Safety backup: pre-restore-/);
  } finally {
    cleanupSandbox(sandbox);
  }
});

function startServer(statusCode, onRequest = () => {}) {
  const server = http.createServer((request, response) => {
    onRequest(request);
    response.statusCode = statusCode;
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

test('POSIX claudex requires HTTP 2xx, falls back, injects env, and redacts check output', {
  // The POSIX launcher is a /bin/sh script; Windows ships claudex.ps1, covered separately.
  skip: process.platform === 'win32',
}, async () => {
  const sandbox = fixtureSandbox('claudex');
  const launcher = path.join(sandbox.root, 'claudex');
  const launchRecord = path.join(sandbox.root, 'launch.json');
  fs.copyFileSync(path.join(ROOT_DIR, 'templates', 'claudex.sh'), launcher);
  fs.chmodSync(launcher, 0o700);
  createSecret(sandbox.home);
  const spacedNodeDir = path.join(sandbox.root, 'node runtime with spaces');
  const spacedNode = path.join(spacedNodeDir, 'node');
  fs.mkdirSync(spacedNodeDir, { recursive: true });
  fs.symlinkSync(process.execPath, spacedNode);

  let authChecks = 0;
  const preferred = await startServer(500, (request) => {
    assert.equal(request.headers.authorization, `Bearer ${SECRET_SENTINEL}`);
    authChecks += 1;
  });
  const fallback = await startServer(204, (request) => {
    assert.equal(request.headers.authorization, `Bearer ${SECRET_SENTINEL}`);
    authChecks += 1;
  });

  try {
    const commonEnv = {
      ...process.env,
      HOME: sandbox.home,
      CLIPROXY_URL: preferred.url,
      CLAUDEX_FALLBACK_URL: fallback.url,
      CLAUDEX_NODE_BIN: spacedNode,
      CLAUDEX_CLAUDE_BIN: sandbox.claude,
      FAKE_CLAUDE_STATE: sandbox.state,
      FAKE_CLAUDE_LAUNCH: launchRecord,
      CURRENT_ENV_MARKER: 'preserved',
      ANTHROPIC_API_KEY: 'inherited-key-that-must-not-reach-claude',
    };

    const check = await runAsync(launcher, ['--check'], { env: commonEnv });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.match(check.stdout, /localhost fallback endpoint returned HTTP 2xx/);
    assert.match(check.stdout, /ANTHROPIC_API_KEY will be removed/);
    assert.doesNotMatch(`${check.stdout}${check.stderr}`, new RegExp(SECRET_SENTINEL));
    assert.equal(fs.existsSync(launchRecord), false);

    const launched = await runAsync(launcher, ['--model', 'gpt-5.6-sol', '--print', 'hello'], { env: commonEnv });
    assert.equal(launched.status, 0, launched.stderr || launched.stdout);
    const record = JSON.parse(fs.readFileSync(launchRecord, 'utf8'));
    assert.deepEqual(record.args.slice(0, 4), ['--permission-mode', 'auto', '--model', 'gpt-5.6-sol[1m]']);
    assert.deepEqual(record.args.slice(4), ['--model', 'gpt-5.6-sol', '--print', 'hello']);
    assert.equal(record.baseUrl, fallback.url);
    assert.equal(record.authPresent, true);
    assert.equal(record.apiKeyPresent, false);
    assert.equal(record.subagentModel, 'gpt-5.6-sol');
    assert.equal(record.concurrency, '3');
    assert.equal(record.compactWindow, '360000');
    assert.equal(record.toolSearch, 'false');
    assert.equal(record.inheritedMarker, 'preserved');
    assert.ok(authChecks >= 4);

    const failedPreferred = await startServer(401);
    const failedFallback = await startServer(503);
    try {
      const failed = await runAsync(launcher, ['--check'], {
        env: {
          ...commonEnv,
          CLIPROXY_URL: failedPreferred.url,
          CLAUDEX_FALLBACK_URL: failedFallback.url,
        },
      });
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /no healthy proxy endpoint returned HTTP 2xx/);
      assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, new RegExp(SECRET_SENTINEL));
    } finally {
      await failedPreferred.close();
      await failedFallback.close();
    }
  } finally {
    await preferred.close();
    await fallback.close();
    cleanupSandbox(sandbox);
  }
});

test('Windows launchers are native PowerShell/CMD and parse when pwsh is available', (t) => {
  const psLauncher = path.join(ROOT_DIR, 'templates', 'claudex.ps1');
  const psSetup = path.join(ROOT_DIR, 'scripts', 'setup-windows.ps1');
  const cmdLauncher = fs.readFileSync(path.join(ROOT_DIR, 'templates', 'claudex.cmd'), 'utf8');
  const psText = fs.readFileSync(psLauncher, 'utf8');
  const setupText = fs.readFileSync(psSetup, 'utf8');

  assert.match(psText, /System\.Net\.Http\.HttpClient/);
  assert.match(psText, /AllowAutoRedirect\s*=\s*\$false/);
  assert.match(psText, /ANTHROPIC_API_KEY.*\$null/s);
  assert.match(psText, /ANTHROPIC_API_KEY will be removed/);
  assert.match(psText, /gpt-5\.6-sol\[1m\]/);
  assert.doesNotMatch(psText, /Git Bash|\bbash\b/i);
  assert.match(cmdLauncher, /powershell\.exe/i);
  assert.match(setupText, /SetEnvironmentVariable\('Path'.*'User'\)/s);
  assert.match(setupText, /--external-change.*Windows User PATH/s);
  assert.match(setupText, /windows-user-path\.json/);
  assert.match(setupText, /\[needs-setup\] Windows User PATH/);
  assert.match(setupText, /'--home', \$homeDir, '--config-dir', \$configDirPath/);
  assert.doesNotMatch(setupText, /Git Bash|\bbash\b/i);

  const planSkip = setupText.indexOf('Windows User PATH: restore skipped by request');
  const planSnapshotRead = setupText.indexOf('$restoreIdForPlan = Resolve-RestoreBackupId');
  assert.ok(planSkip >= 0 && planSkip < planSnapshotRead);
  const applySkip = setupText.indexOf("Write-Output 'Windows User PATH restore skipped by request'");
  const applySnapshotUse = setupText.indexOf('$pathSnapshot = $snapshotForPlan');
  assert.ok(applySkip >= 0 && applySkip < applySnapshotUse);
  const safetySnapshotWrite = setupText.indexOf('Write-PathSnapshot $safetyBackupId $wasPresent $entry', applySnapshotUse);
  const pathRestoreWrite = setupText.indexOf('Set-PathEntryPresence $entry ([bool] $pathSnapshot.present)', applySnapshotUse);
  assert.ok(safetySnapshotWrite >= 0 && safetySnapshotWrite < pathRestoreWrite);

  const setupPathRefresh = setupText.indexOf('$setupPathWasPresent = Test-PathEntry');
  const setupSnapshotWrite = setupText.indexOf('Write-PathSnapshot $setupBackupId $setupPathWasPresent', setupPathRefresh);
  const setupPathWrite = setupText.indexOf('Set-PathEntryPresence $binDir $true', setupPathRefresh);
  assert.ok(setupPathRefresh >= 0 && setupPathRefresh < setupSnapshotWrite && setupSnapshotWrite < setupPathWrite);
  assert.doesNotMatch(setupText, /Write-PathSnapshot \$setupBackupId \$false/);
  assert.match(setupText, /\$coreArguments \+= @\('--backup', \$restoreIdForPlan\)/);
  assert.match(setupText, /\$Id -eq '\.' -or \$Id -eq '\.\.'/);

  const candidates = process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'];
  let powershell = null;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      powershell = candidate;
      break;
    }
  }
  if (!powershell) {
    t.skip('PowerShell is not installed on this host');
    return;
  }
  for (const file of [psLauncher, psSetup]) {
    // The path travels in the environment rather than as an argument: with
    // -Command, trailing arguments are appended to the command text instead of
    // populating $args, so $args[0] was $null and ParseFile got an empty path.
    // This also keeps paths containing spaces out of PowerShell's parser.
    const script = '$errors=$null; '
      + '[System.Management.Automation.Language.Parser]::ParseFile($env:CC_PARSE_TARGET,[ref]$null,[ref]$errors) | Out-Null; '
      + 'if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }';
    const parsed = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, CC_PARSE_TARGET: file },
    });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  }
});

test.after(() => {
  fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
});
