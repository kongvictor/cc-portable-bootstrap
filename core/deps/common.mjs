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

// `where` also lists extensionless siblings of a shim (npm ships a POSIX script
// next to codex.cmd). Windows cannot execute those, so only PATHEXT candidates
// count, in the order PATHEXT itself declares.
function pickWindowsExecutable(lines, env) {
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const extension of extensions) {
    const match = lines.find((line) => line.toLowerCase().endsWith(extension));
    if (match) return match;
  }
  return lines[0] || null;
}

export function commandExists(command, env = process.env) {
  const finder = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = process.platform === 'win32'
    ? spawnSync(finder, args, { encoding: 'utf8', env, windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) return null;
  const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform === 'win32') return pickWindowsExecutable(lines, env);
  return lines[0] || null;
}

// CreateProcess cannot launch a batch file, so npm-installed shims (`codex.cmd`,
// `claude.cmd`) have to go through cmd.exe. Every argument is wrapped in quotes
// and the whole payload is passed verbatim, so cmd.exe strips only the outer
// pair and never re-parses separators inside an argument.
const WINDOWS_BATCH_PATTERN = /\.(?:cmd|bat)$/i;

function buildCmdCommandLine(command, args) {
  const parts = [command, ...args].map((part) => String(part));
  // A quote ends the quoted run and `%` starts an expansion; neither can be
  // escaped reliably inside `cmd /c`, so such an argument is refused instead of
  // being silently mangled into a different command.
  const unsafe = parts.find((part) => /["%\r\n]/.test(part));
  if (unsafe) return null;
  return `"${parts.map((part) => `"${part}"`).join(' ')}"`;
}

export function run(command, args, { env = process.env, timeoutMs = 600_000, cwd } = {}) {
  const useCmd = process.platform === 'win32' && WINDOWS_BATCH_PATTERN.test(String(command));
  let target = command;
  let targetArgs = args;
  const options = {
    encoding: 'utf8',
    env,
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };

  if (useCmd) {
    const commandLine = buildCmdCommandLine(command, args);
    if (!commandLine) {
      return {
        ok: false,
        status: null,
        stdout: '',
        stderr: `Refusing to run ${command}: an argument contains a character cmd.exe cannot quote safely`,
      };
    }
    target = process.env.COMSPEC || 'cmd.exe';
    targetArgs = ['/d', '/s', '/c', commandLine];
    options.windowsVerbatimArguments = true;
  }

  const result = spawnSync(target, targetArgs, options);
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

// Non-interactive shells (ssh, launchd, scheduled tasks) routinely lack Homebrew
// on PATH. Resolving it by well-known prefix keeps detection honest there, which
// otherwise reports brew-managed software as missing and reinstalls it.
export function resolveBrew(env = process.env) {
  const onPath = commandExists('brew', env);
  if (onPath) return onPath;
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((candidate) => fs.existsSync(candidate)) || null;
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
