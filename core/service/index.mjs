// Keeping a local cliproxyapi running across reboots, per platform.
//
// macOS  : brew services when the formula owns the binary, else a user LaunchAgent.
// Linux  : systemctl --user.
// Windows: schtasks /sc onlogon. Upstream ships no Windows service integration,
//          and a logon-triggered scheduled task is the only option that does not
//          require administrator rights.
//
// Every backend is idempotent and fully removable, so uninstall leaves nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandExists, ensurePrivateDir, run } from '../deps/common.mjs';

export const SERVICE_LABEL = 'com.cc-portable-bootstrap.cliproxyapi';
export const TASK_NAME = 'cc-portable-bootstrap cliproxyapi';

export function backendFor(platform = process.platform, { viaBrew = false, env = process.env } = {}) {
  if (platform === 'darwin') return viaBrew && commandExists('brew', env) ? 'brew' : 'launchd';
  if (platform === 'linux') return 'systemd';
  if (platform === 'win32') return 'schtasks';
  return 'unsupported';
}

export function launchAgentPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(home = os.homedir()) {
  return path.join(home, '.config', 'systemd', 'user', 'cc-portable-bootstrap-cliproxyapi.service');
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderLaunchAgent({ binary, configFile, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(binary)}</string>
        <string>-config</string>
        <string>${xmlEscape(configFile)}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ binary, configFile }) {
  return `[Unit]
Description=cliproxyapi (cc-portable-bootstrap)
After=network-online.target

[Service]
Type=simple
ExecStart=${binary} -config ${configFile}
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
`;
}

function writePrivateFile(file, contents) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

export function serviceStatus({ home = os.homedir(), platform = process.platform, viaBrew = false, env = process.env } = {}) {
  const backend = backendFor(platform, { viaBrew, env });
  if (backend === 'brew') {
    const result = run('brew', ['services', 'list'], { env, timeoutMs: 30_000 });
    const line = result.stdout.split(/\r?\n/).find((row) => /^cliproxyapi\s/.test(row.trim()));
    return { backend, installed: Boolean(line), running: Boolean(line && /\bstarted\b/i.test(line)) };
  }
  if (backend === 'launchd') {
    const file = launchAgentPath(home);
    const installed = fs.existsSync(file);
    const loaded = installed && run('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], { env, timeoutMs: 20_000 }).ok;
    return { backend, installed, running: loaded, file };
  }
  if (backend === 'systemd') {
    const file = systemdUnitPath(home);
    const active = run('systemctl', ['--user', 'is-active', path.basename(file)], { env, timeoutMs: 20_000 });
    return { backend, installed: fs.existsSync(file), running: active.stdout.trim() === 'active', file };
  }
  if (backend === 'schtasks') {
    const query = run('schtasks', ['/query', '/tn', TASK_NAME], { env, timeoutMs: 30_000 });
    return { backend, installed: query.ok, running: query.ok };
  }
  return { backend, installed: false, running: false };
}

export function installService({
  home = os.homedir(),
  platform = process.platform,
  binary,
  configFile,
  viaBrew = false,
  env = process.env,
  autostart = true,
  dryRun = false,
} = {}) {
  const backend = backendFor(platform, { viaBrew, env });
  if (backend === 'unsupported') return { backend, action: 'unsupported' };
  if (!autostart) return { backend, action: 'skipped' };
  if (dryRun) return { backend, action: 'would-install' };
  if (!binary) throw new Error('A cliproxyapi binary is required to install the service');

  if (backend === 'brew') {
    const result = run('brew', ['services', 'start', 'cliproxyapi'], { env, timeoutMs: 120_000 });
    if (!result.ok) throw new Error('brew services start cliproxyapi failed');
    return { backend, action: 'installed' };
  }

  if (backend === 'launchd') {
    const logDir = ensurePrivateDir(path.join(home, '.cache', 'cc-portable-bootstrap'));
    const file = writePrivateFile(
      launchAgentPath(home),
      renderLaunchAgent({ binary, configFile, logFile: path.join(logDir, 'cliproxyapi.log') }),
    );
    const uid = process.getuid?.() ?? '';
    // bootout first so a reinstall replaces the old definition cleanly.
    run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { env, timeoutMs: 20_000 });
    const result = run('launchctl', ['bootstrap', `gui/${uid}`, file], { env, timeoutMs: 30_000 });
    if (!result.ok) throw new Error('launchctl bootstrap failed');
    return { backend, action: 'installed', file };
  }

  if (backend === 'systemd') {
    const file = writePrivateFile(systemdUnitPath(home), renderSystemdUnit({ binary, configFile }));
    run('systemctl', ['--user', 'daemon-reload'], { env, timeoutMs: 30_000 });
    const result = run('systemctl', ['--user', 'enable', '--now', path.basename(file)], { env, timeoutMs: 60_000 });
    if (!result.ok) throw new Error('systemctl --user enable --now failed');
    return { backend, action: 'installed', file };
  }

  // schtasks: user-scope, logon-triggered, no administrator rights required.
  const command = `"${binary}" -config "${configFile}"`;
  run('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { env, timeoutMs: 30_000 });
  const result = run(
    'schtasks',
    ['/create', '/tn', TASK_NAME, '/tr', command, '/sc', 'onlogon', '/rl', 'limited', '/f'],
    { env, timeoutMs: 60_000 },
  );
  if (!result.ok) throw new Error('schtasks /create failed');
  run('schtasks', ['/run', '/tn', TASK_NAME], { env, timeoutMs: 30_000 });
  return { backend, action: 'installed' };
}

export function removeService({
  home = os.homedir(),
  platform = process.platform,
  viaBrew = false,
  env = process.env,
  dryRun = false,
} = {}) {
  const backend = backendFor(platform, { viaBrew, env });
  if (backend === 'unsupported') return { backend, action: 'unsupported' };
  if (dryRun) return { backend, action: 'would-remove' };

  if (backend === 'brew') {
    run('brew', ['services', 'stop', 'cliproxyapi'], { env, timeoutMs: 120_000 });
    return { backend, action: 'removed' };
  }
  if (backend === 'launchd') {
    const file = launchAgentPath(home);
    run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], { env, timeoutMs: 20_000 });
    fs.rmSync(file, { force: true });
    return { backend, action: 'removed', file };
  }
  if (backend === 'systemd') {
    const file = systemdUnitPath(home);
    run('systemctl', ['--user', 'disable', '--now', path.basename(file)], { env, timeoutMs: 60_000 });
    fs.rmSync(file, { force: true });
    run('systemctl', ['--user', 'daemon-reload'], { env, timeoutMs: 30_000 });
    return { backend, action: 'removed', file };
  }
  run('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { env, timeoutMs: 30_000 });
  return { backend, action: 'removed' };
}
