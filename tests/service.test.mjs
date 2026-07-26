import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  SERVICE_LABEL,
  TASK_NAME,
  backendFor,
  installService,
  launchAgentPath,
  removeService,
  renderLaunchAgent,
  renderSystemdUnit,
  systemdUnitPath,
} from '../core/service/index.mjs';

const SANDBOX_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '.sandbox-service');

function temporaryDirectory(name) {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SANDBOX_ROOT, `${name}-`));
}

test.after(() => {
  fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
});

test('each platform maps to its only viable autostart mechanism', () => {
  // Windows has no upstream service integration; a logon task is the one option
  // that works without administrator rights.
  assert.equal(backendFor('win32'), 'schtasks');
  assert.equal(backendFor('linux'), 'systemd');
  assert.equal(backendFor('darwin', { viaBrew: false }), 'launchd');
  assert.equal(backendFor('sunos'), 'unsupported');
});

test('generated service definitions quote paths and escape XML', () => {
  const plist = renderLaunchAgent({
    binary: '/opt/my tools/cliproxyapi',
    configFile: '/home/me/config & backup.yaml',
    logFile: '/home/me/log.txt',
  });
  assert.match(plist, /<string>\/opt\/my tools\/cliproxyapi<\/string>/);
  assert.match(plist, /config &amp; backup\.yaml/);
  assert.doesNotMatch(plist, /config & backup/);
  assert.match(plist, new RegExp(SERVICE_LABEL));

  const unit = renderSystemdUnit({ binary: '/usr/bin/cliproxyapi', configFile: '/etc/c.yaml' });
  assert.match(unit, /ExecStart=\/usr\/bin\/cliproxyapi -config \/etc\/c\.yaml/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('autostart can be declined without failing setup', () => {
  const root = temporaryDirectory('service-skip');
  const result = installService({
    home: root,
    platform: 'linux',
    binary: '/usr/bin/cliproxyapi',
    configFile: '/tmp/c.yaml',
    autostart: false,
  });
  assert.equal(result.action, 'skipped');
  assert.equal(fs.existsSync(systemdUnitPath(root)), false);
});

test('dry run reports the backend without writing any unit', () => {
  const root = temporaryDirectory('service-dry');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const result = installService({
      home: root,
      platform,
      binary: '/usr/bin/cliproxyapi',
      configFile: '/tmp/c.yaml',
      dryRun: true,
    });
    assert.equal(result.action, 'would-install');
  }
  assert.equal(fs.existsSync(launchAgentPath(root)), false);
  assert.equal(fs.existsSync(systemdUnitPath(root)), false);

  const removal = removeService({ home: root, platform: 'linux', dryRun: true });
  assert.equal(removal.action, 'would-remove');
});

test('an unsupported platform is reported, never silently skipped', () => {
  const root = temporaryDirectory('service-unsupported');
  assert.equal(installService({ home: root, platform: 'sunos' }).action, 'unsupported');
  assert.equal(removeService({ home: root, platform: 'sunos' }).action, 'unsupported');
});

test('installing without a binary fails loudly instead of writing a broken unit', () => {
  const root = temporaryDirectory('service-nobinary');
  assert.throws(
    () => installService({ home: root, platform: 'linux', configFile: '/tmp/c.yaml' }),
    /binary is required/,
  );
  assert.equal(fs.existsSync(systemdUnitPath(root)), false);
});

test('the Windows task name and service label are stable identifiers', () => {
  // Uninstall matches on these exact strings; drift would orphan a running task.
  assert.equal(TASK_NAME, 'cc-portable-bootstrap cliproxyapi');
  assert.equal(SERVICE_LABEL, 'com.cc-portable-bootstrap.cliproxyapi');
});
