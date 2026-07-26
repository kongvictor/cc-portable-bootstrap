import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LOCAL_URL,
  defaultProfile,
  describeProfile,
  detectActiveEndpoint,
  orderedEndpoints,
  profilePath,
  readProfile,
  validateProfile,
  writeProfile,
} from '../core/profile.mjs';
import { isStrictLoopbackHost, normalizeCredentialedBase } from '../core/statusline/net.mjs';
import { snapshotConfig } from '../core/statusline/snapshot.mjs';

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function profileWith(endpoints, overrides = {}) {
  return { ...defaultProfile(), endpoints, ...overrides };
}

test('credentialed transport is loopback-only over HTTP', () => {
  assert.equal(isStrictLoopbackHost('127.0.0.1'), true);
  assert.equal(isStrictLoopbackHost('127.255.255.255'), true);
  assert.equal(isStrictLoopbackHost('localhost'), true);
  assert.equal(isStrictLoopbackHost('::1'), true);
  // A hostname that merely starts with "127." is not loopback.
  assert.equal(isStrictLoopbackHost('127.attacker.example'), false);
  assert.equal(isStrictLoopbackHost('127.0.0.1.attacker.example'), false);
  assert.equal(isStrictLoopbackHost('10.0.0.1'), false);

  assert.equal(normalizeCredentialedBase('http://127.0.0.1:8317/'), 'http://127.0.0.1:8317');
  assert.equal(normalizeCredentialedBase('http://10.0.0.1:8317'), null);
  assert.equal(normalizeCredentialedBase('https://proxy.example.test'), 'https://proxy.example.test');
  assert.equal(normalizeCredentialedBase('https://user:pass@example.test'), null);
  assert.equal(normalizeCredentialedBase('ftp://127.0.0.1'), null);
});

test('the shipped example profile is valid and carries no real topology', () => {
  const raw = fs.readFileSync(path.join(repository, 'templates/profile.example.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.doesNotThrow(() => validateProfile(parsed));
  // Placeholders only: no resolvable host, no private address, no real alias.
  assert.doesNotMatch(raw, /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./);
  for (const endpoint of parsed.endpoints) {
    assert.equal(isStrictLoopbackHost(new URL(endpoint.url).hostname), true);
  }
});

test('profile validation rejects unsafe endpoints and malformed tunnels', () => {
  assert.throws(() => validateProfile({ schemaVersion: 99 }), /unsupported schemaVersion/);
  assert.throws(
    () => validateProfile(profileWith([{ label: 'lan', url: 'http://192.168.1.10:8317' }])),
    /strict loopback host/,
  );
  assert.throws(
    () => validateProfile(profileWith([{ label: '', url: DEFAULT_LOCAL_URL }])),
    /label must be a non-empty string/,
  );
  assert.throws(
    () => validateProfile(profileWith([
      { label: 'a', url: DEFAULT_LOCAL_URL },
      { label: 'b', url: `${DEFAULT_LOCAL_URL}/` },
    ])),
    /duplicate endpoint URL/,
  );
  // A tunnel host reaches a shell one day; refuse metacharacters up front.
  assert.throws(
    () => validateProfile(profileWith([{
      label: 'hub',
      url: 'http://127.0.0.1:19001',
      tunnel: { host: 'host; rm -rf /', localPort: 19001 },
    }])),
    /shell metacharacters/,
  );
  assert.throws(
    () => validateProfile(profileWith([{
      label: 'hub',
      url: 'http://127.0.0.1:19001',
      tunnel: { host: 'alias', localPort: 99999 },
    }])),
    /must be a valid port/,
  );
  assert.throws(
    () => validateProfile(profileWith(
      [{ label: 'local', url: DEFAULT_LOCAL_URL }],
      { activeEndpoint: 'http://127.0.0.1:9999' },
    )),
    /not one of the configured endpoints/,
  );
});

test('profiles round-trip on disk with owner-only permissions', () => {
  const root = temporaryDirectory('profile-io');
  const file = path.join(root, 'nested', 'profile.json');
  assert.equal(readProfile(file), null);

  const written = writeProfile(file, profileWith([
    { label: 'hub', url: 'http://127.0.0.1:19001', priority: 10, tunnel: { host: 'alias', localPort: 19001 } },
    { label: 'local', url: DEFAULT_LOCAL_URL, priority: 100 },
  ]));
  assert.equal(written.endpoints.length, 2);
  assert.equal(written.endpoints[0].tunnel.remotePort, 8317);

  const loaded = readProfile(file);
  assert.deepEqual(loaded, written);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readProfile(file), /not valid JSON/);
});

test('profile path honours explicit override and XDG_CONFIG_HOME', () => {
  assert.equal(
    profilePath({ CC_BOOTSTRAP_PROFILE_FILE: '/tmp/custom.json' }),
    path.resolve('/tmp/custom.json'),
  );
  assert.equal(
    profilePath({ XDG_CONFIG_HOME: '/xdg' }, '/home/me'),
    path.join('/xdg', 'cc-portable-bootstrap', 'profile.json'),
  );
  assert.equal(
    profilePath({}, '/home/me'),
    path.join('/home/me', '.config', 'cc-portable-bootstrap', 'profile.json'),
  );
});

test('endpoint detection picks the highest priority healthy endpoint', async () => {
  const root = temporaryDirectory('profile-probe');
  const apiKeyFile = path.join(root, 'apikey');
  fs.writeFileSync(apiKeyFile, 'test-key\n', { mode: 0o600 });

  const profile = validateProfile(profileWith([
    { label: 'hub', url: 'http://127.0.0.1:19001', priority: 10 },
    { label: 'local', url: DEFAULT_LOCAL_URL, priority: 100 },
  ]));
  assert.deepEqual(orderedEndpoints(profile).map((e) => e.label), ['hub', 'local']);

  const probed = [];
  const fallback = await detectActiveEndpoint(profile, {
    apiKeyFile,
    probe: async (url, key) => {
      assert.equal(key, 'test-key');
      probed.push(url);
      return url === DEFAULT_LOCAL_URL;
    },
  });
  assert.equal(fallback.endpoint.label, 'local');
  assert.deepEqual(probed, ['http://127.0.0.1:19001', DEFAULT_LOCAL_URL]);

  // First healthy endpoint wins and later ones are never contacted.
  const preferred = await detectActiveEndpoint(profile, {
    apiKeyFile,
    probe: async () => true,
  });
  assert.equal(preferred.endpoint.label, 'hub');
  assert.equal(preferred.attempts.length, 1);

  const none = await detectActiveEndpoint(profile, { apiKeyFile, probe: async () => false });
  assert.equal(none.endpoint, null);
  assert.equal(none.reason, 'no-healthy-endpoint');
});

test('detection never probes without a key, so no endpoint is offered one', async () => {
  const root = temporaryDirectory('profile-nokey');
  const profile = validateProfile(defaultProfile());
  let probes = 0;
  const result = await detectActiveEndpoint(profile, {
    apiKeyFile: path.join(root, 'absent'),
    probe: async () => {
      probes += 1;
      return true;
    },
  });
  assert.equal(result.reason, 'missing-api-key');
  assert.equal(result.endpoint, null);
  assert.equal(probes, 0);
});

test('the status line resolves endpoints exactly like the profile module', () => {
  // snapshot.mjs duplicates this lookup because the status-line runtime is
  // installed flat, without core/profile.mjs. The copy has already drifted once
  // (descending priority, and matching activeEndpoint against label instead of
  // URL), so the two orderings are pinned against each other here.
  const root = temporaryDirectory('profile-parity');
  const file = path.join(root, 'profile.json');
  const hub = 'http://127.0.0.1:19001';
  const local = DEFAULT_LOCAL_URL;

  const profile = writeProfile(file, profileWith([
    { label: 'local', url: local, priority: 100 },
    { label: 'hub', url: hub, priority: 10 },
  ]));
  const env = { CC_BOOTSTRAP_PROFILE_FILE: file };

  // Lower priority first, in both implementations.
  assert.deepEqual(orderedEndpoints(profile).map((e) => e.url), [hub, local]);
  assert.deepEqual(snapshotConfig(env).bases, [hub, local]);

  // activeEndpoint is a URL and must be tried first, whatever its priority.
  writeProfile(file, { ...profile, activeEndpoint: local });
  assert.deepEqual(snapshotConfig(env).bases, [local, hub]);

  // An explicit CLIPROXY_URL still overrides the profile entirely.
  assert.deepEqual(
    snapshotConfig({ ...env, CLIPROXY_URL: hub }).bases,
    [hub],
  );

  // No profile and no variable means no credentialed request at all.
  assert.deepEqual(snapshotConfig({ CC_BOOTSTRAP_PROFILE_FILE: path.join(root, 'absent.json') }).bases, []);
});

test('role description follows the two independent role flags', () => {
  const hub = validateProfile(profileWith(
    [{ label: 'local', url: DEFAULT_LOCAL_URL }],
    { runsLocalProxy: true, servesOthers: true },
  ));
  const standalone = validateProfile(profileWith(
    [{ label: 'local', url: DEFAULT_LOCAL_URL }],
    { runsLocalProxy: true, servesOthers: false },
  ));
  const client = validateProfile(profileWith(
    [{ label: 'hub', url: 'http://127.0.0.1:19001' }],
    { runsLocalProxy: false, servesOthers: false },
  ));

  assert.match(describeProfile(hub, hub.endpoints[0]).role, /^hub/);
  assert.match(describeProfile(standalone, null).role, /^standalone/);
  assert.match(describeProfile(client, null).role, /^client/);
});
