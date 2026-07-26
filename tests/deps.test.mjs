import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertHttps,
  downloadVerified,
  parseChecksumManifest,
  sha256File,
  verifyChecksum,
} from '../core/deps/download.mjs';
import { unstableBinaryReason } from '../core/deps/common.mjs';
import { detectCodex, planCodex, verifyCodex } from '../core/deps/codex.mjs';
import {
  assetNameFor,
  detectCliproxyapi,
  ensureConfig,
  planCliproxyapi,
  renderConfig,
  resolveRelease,
  secretPaths,
  upstreamLoginStatus,
} from '../core/deps/cliproxyapi.mjs';
import { planPlugins } from '../core/deps/plugins.mjs';

// Deliberately not os.tmpdir(): on macOS that is /var/folders/..., which the
// unstable-binary rule correctly rejects. Fixtures live in the repository so
// they exercise the stable-path branch.
const SANDBOX_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '.sandbox-deps');

function temporaryDirectory(name) {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SANDBOX_ROOT, `${name}-`));
}

test.after(() => {
  fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
});

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function fakeCodex(dir, { supportsMcp = true, version = 'codex-cli 0.145.0' } = {}) {
  return writeExecutable(
    path.join(dir, 'codex'),
    [
      '#!/bin/sh',
      'if [ "$1" = "mcp-server" ] && [ "$2" = "--help" ]; then',
      supportsMcp
        ? '  echo "Start Codex as an MCP server (stdio)"; exit 0'
        : '  echo "unknown subcommand" >&2; exit 1',
      'fi',
      'if [ "$1" = "--version" ]; then',
      `  echo "${version}"; exit 0`,
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
}

test('downloads refuse plaintext, credentials, and unverified assets', async () => {
  assert.throws(() => assertHttps('http://example.test/a'), /plaintext HTTP/);
  assert.throws(() => assertHttps('https://user:pw@example.test/a'), /carrying credentials/);
  assert.equal(assertHttps('https://example.test/a'), 'https://example.test/a');

  const root = temporaryDirectory('download');
  const file = path.join(root, 'payload');
  fs.writeFileSync(file, 'hello');
  const digest = crypto.createHash('sha256').update('hello').digest('hex');
  assert.equal(sha256File(file), digest);
  assert.equal(verifyChecksum(file, digest.toUpperCase()), digest);
  assert.throws(() => verifyChecksum(file, 'deadbeef'), /64-character hex/);
  assert.throws(() => verifyChecksum(file, digest.replace(/.$/, '0')), /Checksum mismatch/);

  await assert.rejects(
    downloadVerified('https://example.test/a', path.join(root, 'out'), ''),
    /without an expected checksum/,
  );
});

test('a tampered download leaves no runnable binary behind', async () => {
  const root = temporaryDirectory('download-tamper');
  const server = http.createServer((request, response) => response.end('malicious payload'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const destination = path.join(root, 'bin', 'tool');

  try {
    // Bypass the HTTPS guard only to exercise the checksum path over a local server.
    const expected = crypto.createHash('sha256').update('expected payload').digest('hex');
    const response = await fetch(`http://127.0.0.1:${port}/asset`);
    const body = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = `${destination}.download`;
    fs.writeFileSync(staging, body, { mode: 0o700 });
    assert.throws(() => verifyChecksum(staging, expected), /Checksum mismatch/);
    fs.rmSync(staging, { force: true });
    assert.equal(fs.existsSync(destination), false);
  } finally {
    server.close();
  }
});

test('checksum manifests are matched by asset basename', () => {
  const manifest = [
    'aaaa  other-asset.tar.gz',
    `${'b'.repeat(64)}  ./dist/cliproxyapi-linux-amd64`,
    `${'c'.repeat(64)} *cliproxyapi-windows-amd64.exe`,
  ].join('\n');
  assert.equal(parseChecksumManifest(manifest, 'cliproxyapi-linux-amd64'), 'b'.repeat(64));
  assert.equal(parseChecksumManifest(manifest, 'cliproxyapi-windows-amd64.exe'), 'c'.repeat(64));
  assert.equal(parseChecksumManifest(manifest, 'absent'), null);
});

test('a release without a published checksum is refused', async () => {
  const fetcher = async (url) => {
    if (url.includes('api.github.com')) {
      return JSON.stringify({
        tag_name: 'v1.2.3',
        assets: [{ name: 'cliproxyapi-linux-amd64', browser_download_url: 'https://example.test/a' }],
      });
    }
    throw new Error('unexpected fetch');
  };
  await assert.rejects(
    resolveRelease({ platform: 'linux', arch: 'x64', fetcher }),
    /publishes no SHA256/,
  );
});

test('release resolution pairs the platform asset with its checksum', async () => {
  const sha = 'd'.repeat(64);
  const fetcher = async (url) => {
    if (url.includes('api.github.com')) {
      return JSON.stringify({
        tag_name: 'v1.2.3',
        assets: [
          { name: 'cliproxyapi-darwin-arm64', browser_download_url: 'https://example.test/darwin' },
          { name: 'cliproxyapi-linux-amd64', browser_download_url: 'https://example.test/linux' },
          { name: 'checksums.txt', browser_download_url: 'https://example.test/sums' },
        ],
      });
    }
    return `${sha}  cliproxyapi-linux-amd64\n`;
  };
  const release = await resolveRelease({ platform: 'linux', arch: 'x64', fetcher });
  assert.equal(release.name, 'cliproxyapi-linux-amd64');
  assert.equal(release.sha256, sha);

  assert.equal(assetNameFor('win32', 'x64').os, 'windows');
  assert.equal(assetNameFor('linux', 'arm64').cpu, 'arm64');
  assert.equal(assetNameFor('sunos', 'x64'), null);
});

test('Codex detection requires mcp-server support and a stable location', {
  skip: process.platform === 'win32',
}, () => {
  const root = temporaryDirectory('codex-detect');
  const good = fakeCodex(path.join(root, 'opt', 'bin'));
  assert.equal(verifyCodex(good).ok, true);
  assert.equal(verifyCodex(good).version, 'codex-cli 0.145.0');

  const legacy = fakeCodex(path.join(root, 'legacy'), { supportsMcp: false });
  assert.equal(verifyCodex(legacy).ok, false);

  // Session-scoped shims vanish on reboot and must never be registered.
  assert.ok(unstableBinaryReason('/private/var/folders/ab/T/cmux-cli-shims/x/codex'));
  assert.ok(unstableBinaryReason('/tmp/codex'));
  assert.equal(unstableBinaryReason('/opt/homebrew/bin/codex'), null);

  const detected = detectCodex({ home: root, explicit: good, env: { PATH: '' }, knownPaths: [] });
  assert.equal(detected.ok, true);
  assert.equal(detected.binary, good);

  // With no usable candidate anywhere, detection reports why each was rejected.
  const none = detectCodex({ home: root, explicit: legacy, env: { PATH: '' }, knownPaths: [] });
  assert.equal(none.ok, false);
  assert.equal(none.rejected.some((entry) => entry.binary === legacy), true);

  // A rejected explicit candidate must not mask a good one found later.
  const recovered = detectCodex({
    home: root,
    explicit: legacy,
    env: { PATH: '' },
    knownPaths: [good],
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.binary, good);
});

test('install plans avoid npm when npm cannot run', () => {
  const detected = planCodex({ ok: true, binary: '/opt/homebrew/bin/codex' });
  assert.equal(detected.action, 'none');

  // No brew, no working npm anywhere on PATH: fall through to the official script.
  const plan = planCodex({ ok: false }, { platform: 'linux', env: { PATH: '/nonexistent' } });
  assert.equal(plan.action, 'install');
  assert.equal(plan.channel, 'official-script');
});

test('cliproxyapi planning reports unsupported platforms instead of guessing', () => {
  assert.equal(planCliproxyapi({ installed: true, binary: '/x/cliproxyapi' }).action, 'none');
  const unsupported = planCliproxyapi({ installed: false }, { platform: 'sunos', env: { PATH: '' } });
  assert.equal(unsupported.action, 'unsupported');
});

test('an existing install is found even when PATH lacks Homebrew', {
  skip: process.platform === 'win32',
}, () => {
  // Reproduces a real miss: over ssh, PATH had no /opt/homebrew, so a
  // brew-installed cliproxyapi looked absent and setup planned to download a
  // second copy from GitHub.
  const root = temporaryDirectory('cliproxy-path');
  const managed = path.join(root, '.local', 'share', 'cc-portable-bootstrap', 'bin', 'cliproxyapi');
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const detection = detectCliproxyapi({
    home: root,
    env: { PATH: '' },
    platform: 'linux',
    knownPaths: [managed],
  });
  assert.equal(detection.installed, true);
  assert.equal(detection.binary, managed);
  assert.equal(planCliproxyapi(detection, { platform: 'linux', env: { PATH: '' } }).action, 'none');

  const empty = detectCliproxyapi({
    home: temporaryDirectory('cliproxy-empty'),
    env: { PATH: '' },
    platform: 'linux',
    knownPaths: [],
  });
  assert.equal(empty.installed, false);
});

test('config generation creates local secrets without exposing them', () => {
  const root = temporaryDirectory('cliproxy-config');
  const detection = { configFile: path.join(root, '.cli-proxy-api', 'config.yaml') };

  const planned = ensureConfig({ home: root, detection, dryRun: true });
  assert.equal(planned.created, false);
  assert.equal(planned.wouldCreate, true);
  assert.equal(fs.existsSync(detection.configFile), false);

  const created = ensureConfig({ home: root, detection, servesOthers: true });
  assert.equal(created.created, true);

  const { apiKeyFile, managementKeyFile } = secretPaths(root);
  const apiKey = fs.readFileSync(apiKeyFile, 'utf8').trim();
  const managementKey = fs.readFileSync(managementKeyFile, 'utf8').trim();
  assert.ok(apiKey.length >= 32);
  assert.notEqual(apiKey, managementKey);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(apiKeyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(detection.configFile).mode & 0o777, 0o600);
  }

  const config = fs.readFileSync(detection.configFile, 'utf8');
  assert.match(config, /host: "127\.0\.0\.1"/);
  assert.match(config, /remote-management: true/);
  assert.ok(config.includes(apiKey));

  // Rerunning must converge, not rotate a key other machines may already use.
  const again = ensureConfig({ home: root, detection });
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(apiKeyFile, 'utf8').trim(), apiKey);
});

test('generated config always binds loopback, never a LAN interface', () => {
  const rendered = renderConfig({
    apiKey: 'k',
    managementKey: 'm',
    authDir: '/tmp/auth',
    servesOthers: true,
  });
  assert.match(rendered, /host: "127\.0\.0\.1"/);
  assert.doesNotMatch(rendered, /0\.0\.0\.0/);
});

test('upstream login is reported, never automated', () => {
  const root = temporaryDirectory('cliproxy-login');
  const status = upstreamLoginStatus({ home: root, binary: '/x/cliproxyapi' });
  assert.equal(status.hasCredentials, false);
  assert.match(status.commands.codex, /-codex-device-login$/);
  assert.match(status.commands.claude, /-claude-login$/);
});

test('missing plugins are a warning, not a failure', () => {
  assert.equal(planPlugins({ known: true, missing: [] }).action, 'none');
  assert.equal(planPlugins({ known: false, missing: ['claude-hud'] }).action, 'unknown');
  const install = planPlugins({ known: true, missing: ['claude-hud'] });
  assert.equal(install.action, 'install');
  assert.deepEqual(install.missing, ['claude-hud']);
});
