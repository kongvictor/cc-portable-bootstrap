// Shared plumbing for dependency installers. Every installer exposes the same
// detect -> plan -> install -> verify shape so the command layer can treat them
// uniformly and always show a truthful dry-run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UNSTABLE_PATH_PATTERN = /(?:^|[\\/])(?:cmux|tmp|temp)(?:[\\/]|$)|[\\/]T[\\/]|[\\/]var[\\/]folders[\\/]/i;

// A binary under a temp or session-scoped directory disappears between reboots;
// registering one produces an MCP server that silently stops working.
export function unstableBinaryReason(candidate) {
  if (!candidate) return 'no path';
  const normalized = path.resolve(candidate);
  if (UNSTABLE_PATH_PATTERN.test(normalized)) return `unstable location: ${normalized}`;
  return null;
}

export function commandExists(command, env = process.env) {
  const finder = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = process.platform === 'win32'
    ? spawnSync(finder, args, { encoding: 'utf8', env, windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) return null;
  const first = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return first || null;
}

export function run(command, args, { env = process.env, timeoutMs = 600_000, cwd } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function userBinDir(home = os.homedir()) {
  return path.join(home, '.local', 'share', 'cc-portable-bootstrap', 'bin');
}

export function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // A pre-existing directory owned by the user is good enough.
    }
  }
  return directory;
}

// Installers report a plan rather than acting, so --dry-run is always accurate.
export function plan(action, detail, extra = {}) {
  return { action, detail, ...extra };
}
