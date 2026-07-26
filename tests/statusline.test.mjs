import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  appendUsageToHud,
  contextDetail,
  isGptModel,
  renderStandalone,
  renderUsageSegments,
  rescaleStatusForModel,
  stripAnsi,
  visibleWidth,
} from '../core/statusline/layout.mjs';
import { discoverClaudeHud } from '../core/statusline/discovery.mjs';
import {
  atomicReplaceJson,
  configureInstallation,
  isManagedStatusCommand,
  launcherCommand,
} from '../core/statusline/configure.mjs';
import {
  installStatusline,
  installedRuntimeIsStale,
  launchersFor,
} from '../core/statusline/install.mjs';
import {
  buildAnthropicSnapshot,
  buildOpenAiSnapshot,
  normalizeManagementBase,
  snapshotConfig,
} from '../core/statusline/snapshot.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function statusFixture(modelId = 'claude-opus-4-6') {
  return {
    model: { id: modelId },
    context_window: {
      used_percentage: 29,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 57000,
      },
    },
  };
}

test('detects GPT and Codex model families', () => {
  assert.equal(isGptModel('gpt-5.6-sol'), true);
  assert.equal(isGptModel('codex-mini'), true);
  assert.equal(isGptModel('o3-pro'), true);
  assert.equal(isGptModel('o4-mini'), true);
  assert.equal(isGptModel('o12-research'), true);
  assert.equal(isGptModel('claude-opus-4-6'), false);
});

test('rescales GPT context to the real 372k window and passes Claude through', () => {
  const gpt = statusFixture('gpt-5.6-sol');
  const scaled = rescaleStatusForModel(gpt, 372000);
  assert.equal(scaled.context_window.context_window_size, 372000);
  assert.equal(scaled.context_window.used_percentage, 15.6);
  assert.equal(gpt.context_window.context_window_size, 200000);

  const claude = statusFixture();
  assert.deepEqual(rescaleStatusForModel(claude, 372000), claude);
});

test('always renders input and total cache details', () => {
  assert.equal(stripAnsi(contextDetail(statusFixture())), '(in:100, cache:60k)');
});

test('renders Claude 5h, weekly, scoped and GPT weekly only', () => {
  const now = Date.parse('2026-07-26T10:00:00Z');
  const snapshot = {
    five_hour: { used_percentage: 13, resets_at: '2026-07-26T13:08:00Z' },
    seven_day: { used_percentage: 95, resets_at: '2026-07-27T19:00:00Z' },
    scoped: [{ name: 'Fable', pct: 100 }],
  };

  const claude = stripAnsi(renderUsageSegments(statusFixture(), snapshot, now).join(' | '));
  assert.match(claude, /5h: 13% \(resets in 3h8m\)/);
  assert.match(claude, /Weekly: 95% \(resets in 1d9h\)/);
  assert.match(claude, /Fable: 100%/);

  const gpt = stripAnsi(
    renderUsageSegments(statusFixture('gpt-5.6-sol'), snapshot, now).join(' | '),
  );
  assert.doesNotMatch(gpt, /5h:/);
  assert.match(gpt, /Weekly: 95%/);
  assert.doesNotMatch(gpt, /Fable:/);
});

test('preserves HUD lines and reflows usage over multiple indented lines', () => {
  const hud = ['Model Opus', 'Context ███░░░░░░░ 29%', 'Git main', 'Tools 2'].join('\n');
  const segments = ['5h: 13% (resets in 3h8m)', 'Weekly: 95% (resets in 1d9h)', 'Fable: 100%'];
  const output = appendUsageToHud(hud, segments, '(in:100, cache:60k)', 48);

  assert.match(output, /Model Opus/);
  assert.match(output, /Git main/);
  assert.match(output, /Tools 2/);
  assert.match(output, /Context .*29% \(in:100, cache:60k\)/);
  assert.equal((output.match(/5h:/g) || []).length, 1);
  assert.equal((output.match(/Weekly:/g) || []).length, 1);
  assert.equal((output.match(/Fable:/g) || []).length, 1);
  assert.ok(output.split('\n').filter((line) => line.startsWith('  ')).length >= 2);
});

test('measures ANSI and wide characters without truncating segments', () => {
  assert.equal(visibleWidth('\u001b[31mFable\u001b[0m'), 5);
  assert.equal(visibleWidth('模型'), 4);
  const output = renderStandalone(
    rescaleStatusForModel(statusFixture('gpt-5.6-sol')),
    { seven_day: { used_percentage: 66 } },
    120,
  );
  const plain = stripAnsi(output);
  assert.match(plain, /Ctx .* 16% \(in:100, cache:60k\)/);
  assert.match(plain, /Weekly: 66%/);
  assert.doesNotMatch(plain, /GPTCtx/);
});

test('maps provider payloads to legacy-compatible snapshots', () => {
  const now = new Date('2026-07-26T10:00:00Z');
  const openai = buildOpenAiSnapshot(
    {
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 12,
          reset_at: 1785067200,
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used_percent: 34,
          reset_at: 1785672000,
          limit_window_seconds: 604800,
        },
      },
    },
    now,
  );
  assert.equal(openai.five_hour.used_percentage, 12);
  assert.equal(openai.seven_day.used_percentage, 34);
  assert.equal(openai.balance_label, 'gpt plus');

  const anthropic = buildAnthropicSnapshot(
    {
      five_hour: { utilization: 21, resets_at: '2026-07-26T12:00:00Z' },
      seven_day: { utilization: 43, resets_at: '2026-08-01T00:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped',
          scope: { model: { display_name: 'Fable' } },
          percent: 88,
        },
      ],
    },
    now,
  );
  assert.deepEqual(anthropic.scoped, [{ name: 'Fable', pct: 88 }]);
  assert.equal(anthropic.balance_label, 'claude Fable:88%');
});

test('restricts management-key transport and makes an explicit URL authoritative', () => {
  assert.equal(normalizeManagementBase('http://127.0.0.1:18080/'), 'http://127.0.0.1:18080');
  assert.equal(normalizeManagementBase('http://localhost:8317'), 'http://localhost:8317');
  assert.equal(normalizeManagementBase('http://127.255.255.255:8317'), 'http://127.255.255.255:8317');
  assert.equal(normalizeManagementBase('http://127.attacker.example:8317'), null);
  assert.equal(normalizeManagementBase('http://127.0.0.1.attacker.example:8317'), null);
  assert.equal(normalizeManagementBase('http://192.168.1.10:8317'), null);
  assert.equal(normalizeManagementBase('https://proxy.example.test'), 'https://proxy.example.test');
  assert.equal(normalizeManagementBase('https://user:pass@example.test'), null);

  // Point the profile lookup at a path that cannot exist, so these assertions
  // describe the code rather than whichever profile this machine happens to have.
  const noProfile = { CC_BOOTSTRAP_PROFILE_FILE: path.join(os.tmpdir(), 'cc-absent-profile.json') };

  const explicit = snapshotConfig({ ...noProfile, CLIPROXY_URL: 'http://127.0.0.1:8317' });
  assert.deepEqual(explicit.bases, ['http://127.0.0.1:8317']);
  const unsafe = snapshotConfig({ ...noProfile, CLIPROXY_URL: 'http://192.168.1.10:8317' });
  assert.deepEqual(unsafe.bases, []);
  // With neither an explicit URL nor a profile there is nowhere safe to send the
  // management key, so the refresh must not run at all.
  assert.deepEqual(snapshotConfig(noProfile).bases, []);
});

test('discovers the newest claude-hud cache entry', () => {
  const root = temporaryDirectory('cliproxy-discovery');
  const older = path.join(root, 'plugins/cache/market/claude-hud/1.9.0/dist');
  const newer = path.join(root, 'plugins/cache/market/claude-hud/1.10.0/dist');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'index.js'), '');
  fs.writeFileSync(path.join(newer, 'index.js'), '');

  assert.equal(discoverClaudeHud(root).version, '1.10.0');
});

test('recognizes only exact legacy and stable cliproxy status commands', () => {
  assert.equal(
    isManagedStatusCommand('/cache/cliproxy-usage/0.2.0/statusline/statusline.sh'),
    true,
  );
  assert.equal(
    isManagedStatusCommand("'/Users/me/.claude/cliproxy-usage-statusline/cliproxy-usage'"),
    true,
  );
  assert.equal(
    isManagedStatusCommand(
      'cmd.exe /d /s /c ""C:\\Users\\me\\.claude\\cliproxy-usage-statusline\\cliproxy-usage.cmd""',
    ),
    true,
  );
  assert.equal(
    isManagedStatusCommand(
      'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\me\\.claude\\cliproxy-usage-statusline\\cliproxy-usage.ps1"',
    ),
    true,
  );
  assert.equal(
    isManagedStatusCommand('sh /cache/cliproxy-usage/0.2.0/statusline/statusline.sh'),
    false,
  );
  assert.equal(
    isManagedStatusCommand('/custom/cliproxy-usage-statusline/wrapper.sh'),
    false,
  );
});

test('generates a lightweight Windows cmd command and keeps PowerShell compatibility', () => {
  const cmdPath =
    'C:\\Users\\Example User\\.claude\\cliproxy-usage-statusline\\cliproxy-usage.cmd';
  const powershellPath =
    'C:\\Users\\Example User\\.claude\\cliproxy-usage-statusline\\cliproxy-usage.ps1';

  assert.equal(
    launcherCommand(cmdPath, 'win32'),
    `cmd.exe /d /s /c ""${cmdPath}""`,
  );
  assert.equal(
    launcherCommand(powershellPath, 'win32'),
    `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${powershellPath}"`,
  );

  const launcherBytes = fs.readFileSync(path.join(repository, 'bin/statusline.cmd'));
  assert.equal(launcherBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  const launcherText = launcherBytes.toString('utf8');
  assert.match(launcherText, /\r\n/);
  assert.equal(launcherText.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(launcherText, /"%NodeBin%" "%Runtime%"\r\n/);
  assert.doesNotMatch(launcherText, /powershell/i);
});

test('refuses unsafe proxy URLs before touching settings', () => {
  const root = temporaryDirectory('cliproxy-unsafe-url');
  const claudeDir = path.join(root, '.claude');
  const launcher = path.join(root, 'cliproxy-usage');
  const settings = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(launcher, '');
  const original = JSON.stringify({ theme: 'dark' });
  fs.writeFileSync(settings, original);

  assert.throws(
    () =>
      configureInstallation({
        claudeDir,
        launcherPath: launcher,
        proxyUrl: 'http://127.attacker.example:18080',
        configureHud: false,
      }),
    /Unsafe --proxy-url/,
  );
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(claudeDir, '.cc-portable-bootstrap-config.lock')), false);
});

test('configures settings atomically, preserves keys, and creates backups', () => {
  const root = temporaryDirectory('cliproxy-configure');
  const claudeDir = path.join(root, '.claude');
  const launcher = path.join(root, 'cliproxy-usage');
  const settings = path.join(claudeDir, 'settings.json');
  const hud = path.join(claudeDir, 'plugins/claude-hud/config.json');
  fs.mkdirSync(path.dirname(hud), { recursive: true });
  fs.writeFileSync(launcher, '#!/bin/sh\n');
  fs.writeFileSync(
    settings,
    JSON.stringify({
      theme: 'dark',
      env: { EXISTING: 'keep' },
      statusLine: {
        type: 'command',
        command: '/cache/cliproxy-usage/0.2.0/statusline/statusline.sh',
        padding: 1,
      },
    }),
  );
  fs.writeFileSync(hud, JSON.stringify({ display: { showGit: true }, custom: 7 }));

  const result = configureInstallation({
    claudeDir,
    launcherPath: launcher,
    proxyUrl: 'http://127.0.0.1:18080',
  });
  const updated = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const updatedHud = JSON.parse(fs.readFileSync(hud, 'utf8'));

  assert.equal(updated.theme, 'dark');
  assert.equal(updated.env.EXISTING, 'keep');
  assert.equal(updated.env.CLIPROXY_URL, 'http://127.0.0.1:18080');
  assert.equal(result.proxyConfigured, true);
  assert.equal(updated.statusLine.padding, 1);
  assert.equal(updated.statusLine.refreshInterval, 3);
  assert.equal(updated.statusLine.command, launcherCommand(launcher));
  assert.equal(updatedHud.custom, 7);
  assert.equal(updatedHud.display.showGit, true);
  assert.equal(updatedHud.display.showUsage, false);
  assert.ok(result.settings.backup && fs.existsSync(result.settings.backup));
  assert.ok(result.hud.backup && fs.existsSync(result.hud.backup));
});

test('refuses foreign statusLine and malformed JSON without overwriting', () => {
  const root = temporaryDirectory('cliproxy-refusal');
  const claudeDir = path.join(root, '.claude');
  const launcher = path.join(root, 'cliproxy-usage');
  const settings = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(launcher, '');
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { command: '/other/tool' } }));
  const before = fs.readFileSync(settings, 'utf8');

  assert.throws(
    () => configureInstallation({ claudeDir, launcherPath: launcher, configureHud: false }),
    /not managed by cc-portable-bootstrap/,
  );
  assert.equal(fs.readFileSync(settings, 'utf8'), before);

  fs.writeFileSync(settings, '{broken');
  assert.throws(
    () => configureInstallation({ claudeDir, launcherPath: launcher, configureHud: false }),
    /invalid JSON/,
  );
  assert.equal(fs.readFileSync(settings, 'utf8'), '{broken');
});

test('rolls settings back when the HUD commit fails', () => {
  const root = temporaryDirectory('cliproxy-rollback');
  const claudeDir = path.join(root, '.claude');
  const launcher = path.join(root, 'cliproxy-usage');
  const settings = path.join(claudeDir, 'settings.json');
  const hud = path.join(claudeDir, 'plugins/claude-hud/config.json');
  fs.mkdirSync(path.dirname(hud), { recursive: true });
  fs.writeFileSync(launcher, '');
  const originalSettings = JSON.stringify({ theme: 'dark' });
  const originalHud = JSON.stringify({ display: { showUsage: true } });
  fs.writeFileSync(settings, originalSettings);
  fs.writeFileSync(hud, originalHud);

  assert.throws(
    () =>
      configureInstallation({
        claudeDir,
        launcherPath: launcher,
        writeJson(document, value, options) {
          if (options.target === 'hud') throw new Error('simulated HUD write failure');
          return atomicReplaceJson(document, value, options);
        },
      }),
    /simulated HUD write failure/,
  );
  assert.equal(fs.readFileSync(settings, 'utf8'), originalSettings);
  assert.equal(fs.readFileSync(hud, 'utf8'), originalHud);
  assert.equal(fs.existsSync(path.join(claudeDir, '.cc-portable-bootstrap-config.lock')), false);
});

test('fails closed on an active installer lock or a non-cooperating concurrent edit', () => {
  const root = temporaryDirectory('cliproxy-concurrency');
  const claudeDir = path.join(root, '.claude');
  const launcher = path.join(root, 'cliproxy-usage');
  const settings = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(launcher, '');
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));

  const lock = path.join(claudeDir, '.cc-portable-bootstrap-config.lock');
  fs.writeFileSync(lock, 'other installer');
  assert.throws(
    () => configureInstallation({ claudeDir, launcherPath: launcher, configureHud: false }),
    /already running/,
  );
  fs.unlinkSync(lock);

  assert.throws(
    () =>
      configureInstallation({
        claudeDir,
        launcherPath: launcher,
        configureHud: false,
        writeJson(document, value, options) {
          fs.writeFileSync(document.filePath, JSON.stringify({ externalEdit: true }));
          return atomicReplaceJson(document, value, options);
        },
      }),
    /changed during configuration/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { externalEdit: true });
});

test('force mode replaces only the foreign statusLine fields it owns', () => {
  const root = temporaryDirectory('cliproxy-force');
  const claudeDir = path.join(root, '.claude');
  const launcher = path.join(root, 'cliproxy-usage.cmd');
  const settings = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(launcher, '');
  fs.writeFileSync(
    settings,
    JSON.stringify({ statusLine: { command: '/other/tool', padding: 2 }, verbose: true }),
  );

  configureInstallation({
    claudeDir,
    launcherPath: launcher,
    platform: 'win32',
    force: true,
    configureHud: false,
  });
  const updated = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(updated.verbose, true);
  assert.equal(updated.statusLine.padding, 2);
  assert.match(updated.statusLine.command, /^cmd\.exe \/d \/s \/c "".*cliproxy-usage\.cmd""$/);
});

test('runtime integrates with HUD while passing it rescaled GPT context', () => {
  const root = temporaryDirectory('cliproxy-runtime');
  const claudeDir = path.join(root, '.claude');
  const usageDir = path.join(root, 'usage');
  const capture = path.join(root, 'hud-input.json');
  const hudDir = path.join(claudeDir, 'plugins/cache/market/claude-hud/1.0.0/dist');
  fs.mkdirSync(hudDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(
    path.join(hudDir, 'index.js'),
    `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(process.env.HUD_CAPTURE,raw);process.stdout.write('Model GPT\\nContext ███░░░░░░░ 16%\\nGit main\\n');});`,
  );
  fs.writeFileSync(
    path.join(usageDir, 'cliproxy-usage-openai.json'),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      seven_day: { used_percentage: 66 },
    }),
  );

  const result = spawnSync(process.execPath, [path.join(repository, 'core/statusline/runtime.mjs')], {
    input: JSON.stringify(statusFixture('gpt-5.6-sol')),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeDir,
      CLIPROXY_USAGE_DIR: usageDir,
      CLIPROXY_DISABLE_REFRESH: '1',
      HUD_CAPTURE: capture,
      COLUMNS: '120',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const plain = stripAnsi(result.stdout);
  assert.match(plain, /Context .*16% \(in:100, cache:60k\)/);
  assert.match(plain, /Weekly: 66%/);
  assert.match(plain, /Git main/);
  assert.doesNotMatch(plain, /GPTCtx/);
  const hudInput = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(hudInput.context_window.context_window_size, 372000);
  assert.equal(hudInput.context_window.used_percentage, 15.6);
});

test('missing CLIPROXY_URL skips refresh but still renders existing snapshots', () => {
  const root = temporaryDirectory('cliproxy-no-url');
  const claudeDir = path.join(root, '.claude');
  const usageDir = path.join(root, 'usage');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(
    path.join(usageDir, 'cliproxy-usage-openai.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), seven_day: { used_percentage: 42 } }),
  );
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeDir,
    CLIPROXY_USAGE_DIR: usageDir,
    // No explicit URL and no profile: there is no endpoint to send the
    // management key to, so the refresh must stay off. Pointing at an absent
    // profile keeps this independent of the machine running the test.
    CC_BOOTSTRAP_PROFILE_FILE: path.join(root, 'absent-profile.json'),
    COLUMNS: '120',
  };
  delete env.CLIPROXY_URL;
  delete env.CLIPROXY_DISABLE_REFRESH;

  const result = spawnSync(process.execPath, [path.join(repository, 'core/statusline/runtime.mjs')], {
    input: JSON.stringify(statusFixture('gpt-5.6-sol')),
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /Weekly: 42%/);
  assert.equal(fs.existsSync(path.join(usageDir, '.refresh-attempt')), false);
});

test('POSIX install places a stable launcher in an isolated Claude directory', {
  skip: process.platform === 'win32',
}, () => {
  const root = temporaryDirectory('statusline-install');
  const claudeDir = path.join(root, '.claude');
  const installDir = path.join(root, 'stable install');

  const planned = installStatusline({
    claudeDir,
    installDir,
    sourceRoot: repository,
    proxyUrl: 'http://127.0.0.1:18080',
    dryRun: true,
  });
  assert.equal(planned.dryRun, true);
  assert.equal(fs.existsSync(installDir), false, 'a dry run must not create the install directory');
  assert.equal(fs.existsSync(path.join(claudeDir, 'settings.json')), false);

  const result = installStatusline({
    claudeDir,
    installDir,
    sourceRoot: repository,
    proxyUrl: 'http://127.0.0.1:18080',
  });
  assert.equal(result.launcherPath, path.join(installDir, 'statusline'));

  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.match(settings.statusLine.command, /stable install\/statusline/);
  assert.equal(settings.statusLine.refreshInterval, 3);
  assert.equal(settings.env.CLIPROXY_URL, 'http://127.0.0.1:18080');
  assert.ok(fs.existsSync(path.join(installDir, 'runtime.mjs')));
  assert.ok(fs.existsSync(path.join(installDir, 'statusline')));
  assert.equal(
    fs.readFileSync(path.join(installDir, '.node-path'), 'utf8').trim(),
    process.execPath,
  );

  // Re-running must converge instead of rewriting or duplicating configuration.
  const again = installStatusline({
    claudeDir,
    installDir,
    sourceRoot: repository,
    proxyUrl: 'http://127.0.0.1:18080',
  });
  assert.equal(again.settings.settings.changed, false);

  const launch = spawnSync(path.join(installDir, 'statusline'), {
    input: JSON.stringify(statusFixture('gpt-5.6-sol')),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeDir,
      CLIPROXY_USAGE_DIR: path.join(root, 'empty-usage'),
      CLIPROXY_DISABLE_REFRESH: '1',
    },
  });
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(stripAnsi(launch.stdout), /16% \(in:100, cache:60k\)/);
});

test('an installed runtime older than the checkout is detected as stale', {
  skip: process.platform === 'win32',
}, () => {
  // After `git pull` the launcher path and the statusLine setting are unchanged,
  // so without a content comparison an upgrade would silently keep running the
  // old runtime — which is exactly how a fix fails to reach a deployed machine.
  const root = temporaryDirectory('statusline-stale');
  const claudeDir = path.join(root, '.claude');
  const installDir = path.join(root, 'install');
  installStatusline({ claudeDir, installDir, sourceRoot: repository });

  assert.equal(installedRuntimeIsStale({ installDir, sourceRoot: repository }), false);

  const installed = path.join(installDir, 'snapshot.mjs');
  fs.writeFileSync(installed, `${fs.readFileSync(installed, 'utf8')}\n// stale\n`);
  assert.equal(installedRuntimeIsStale({ installDir, sourceRoot: repository }), true);

  // Reinstalling converges it again.
  installStatusline({ claudeDir, installDir, sourceRoot: repository });
  assert.equal(installedRuntimeIsStale({ installDir, sourceRoot: repository }), false);

  // A missing file counts as stale rather than passing silently.
  fs.rmSync(path.join(installDir, 'layout.mjs'));
  assert.equal(installedRuntimeIsStale({ installDir, sourceRoot: repository }), true);
});

test('native Windows setup installs cmd and preserves BOM/CRLF stdin through spaced paths', {
  skip: process.platform !== 'win32',
}, () => {
  const root = temporaryDirectory('statusline-windows');
  const claudeDir = path.join(root, 'Claude 配置');
  const installDir = path.join(root, 'stable install 状态栏');
  installStatusline({
    claudeDir,
    installDir,
    sourceRoot: repository,
    proxyUrl: 'http://127.0.0.1:18080',
  });
  const configured = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  const cmdLauncher = path.join(installDir, 'statusline.cmd');
  const powershellLauncher = path.join(installDir, 'statusline.ps1');
  assert.deepEqual(launchersFor('win32'), {
    primary: 'statusline.cmd',
    extra: ['statusline.ps1'],
  });
  assert.equal(configured.env.CLIPROXY_URL, 'http://127.0.0.1:18080');
  assert.equal(configured.statusLine.command, launcherCommand(cmdLauncher, 'win32'));
  assert.match(configured.statusLine.command, /^cmd\.exe \/d \/s \/c /);
  assert.ok(fs.existsSync(cmdLauncher));
  assert.ok(fs.existsSync(powershellLauncher));

  const cmdBytes = fs.readFileSync(cmdLauncher);
  assert.equal(cmdBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  const cmdText = cmdBytes.toString('utf8');
  assert.match(cmdText, /\r\n/);
  assert.equal(cmdText.replace(/\r\n/g, '').includes('\n'), false);

  const hudDir = path.join(claudeDir, 'plugins/cache/market/claude-hud/1.0.0/dist');
  const usageDir = path.join(root, 'usage');
  fs.mkdirSync(hudDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(
    path.join(hudDir, 'index.js'),
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('模型 GPT\\nContext ███░░░░░░░ 16%\\nGit 主分支\\n'));",
    'utf8',
  );
  fs.writeFileSync(
    path.join(usageDir, 'cliproxy-usage-openai.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), seven_day: { used_percentage: 66 } }),
  );

  const commandPrompt = process.env.ComSpec || 'cmd.exe';
  const launch = spawnSync(
    commandPrompt,
    ['/d', '/s', '/c', `""${cmdLauncher}""`],
    {
      input: `﻿${JSON.stringify(statusFixture('gpt-5.6-sol'))}\r\n`,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeDir,
        CLIPROXY_USAGE_DIR: usageDir,
        CLIPROXY_DISABLE_REFRESH: '1',
        COLUMNS: '45',
      },
    },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const plain = stripAnsi(launch.stdout);
  assert.match(plain, /模型 GPT/);
  assert.match(plain, /█/);
  assert.match(plain, /Git 主分支/);
  assert.match(plain, /\(in:100, cache:60k\)/);
  assert.match(plain, /Weekly: 66%/);
  assert.ok(plain.split(/\r?\n/).filter((line) => line.startsWith('  ')).length >= 1);
});
