#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getClaudeDir } from './discovery.mjs';
import { normalizeManagementBase } from './snapshot.mjs';

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function readJsonDocument(filePath) {
  let original = '';
  let exists = false;
  let mode = 0o600;

  try {
    original = fs.readFileSync(filePath, 'utf8');
    exists = true;
    mode = fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let value = {};
  if (original.trim()) {
    try {
      value = JSON.parse(original);
    } catch {
      throw new Error(`Refusing to overwrite invalid JSON: ${filePath}`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${filePath}`);
  }

  return { filePath, original, exists, mode, value };
}

function nextBackupPath(filePath) {
  const base = `${filePath}.backup-${compactTimestamp()}`;
  if (!fs.existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate backup path for ${filePath}`);
}

function writeTemporary(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`,
  );
  const handle = fs.openSync(temporary, 'wx', mode || 0o600);
  try {
    fs.writeFileSync(handle, contents, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return temporary;
}

function assertDocumentUnchanged(document) {
  if (document.exists) {
    const current = fs.readFileSync(document.filePath, 'utf8');
    if (current !== document.original) {
      throw new Error(`File changed during configuration: ${document.filePath}`);
    }
  } else if (fs.existsSync(document.filePath)) {
    throw new Error(`File appeared during configuration: ${document.filePath}`);
  }
}

function writeBackup(document) {
  const backup = nextBackupPath(document.filePath);
  const handle = fs.openSync(backup, 'wx', document.mode || 0o600);
  try {
    fs.writeFileSync(handle, document.original, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  if (process.platform !== 'win32') fs.chmodSync(backup, document.mode);
  return backup;
}

export function atomicReplaceJson(document, value, { dryRun = false } = {}) {
  const nextContents = `${JSON.stringify(value, null, 2)}\n`;
  if (document.exists && document.original === nextContents) {
    return { changed: false, backup: null, writtenContents: nextContents };
  }
  if (dryRun) {
    return { changed: true, backup: null, writtenContents: nextContents };
  }

  const temporary = writeTemporary(document.filePath, nextContents, document.mode);
  let backup = null;
  try {
    assertDocumentUnchanged(document);
    if (document.exists) backup = writeBackup(document);
    // Recheck after the backup so a concurrent non-installer edit fails closed.
    assertDocumentUnchanged(document);

    fs.renameSync(temporary, document.filePath);
    if (process.platform !== 'win32') fs.chmodSync(document.filePath, document.mode);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }

  return { changed: true, backup, writtenContents: nextContents };
}

function restoreJsonDocument(document, result) {
  if (!result?.changed) return;
  const current = fs.readFileSync(document.filePath, 'utf8');
  if (current !== result.writtenContents) {
    throw new Error(`Refusing unsafe rollback after another edit: ${document.filePath}`);
  }

  if (!document.exists) {
    fs.unlinkSync(document.filePath);
    return;
  }

  const temporary = writeTemporary(document.filePath, document.original, document.mode);
  try {
    fs.renameSync(temporary, document.filePath);
    if (process.platform !== 'win32') fs.chmodSync(document.filePath, document.mode);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function acquireConfigurationLock(claudeDir) {
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(claudeDir, '.cc-portable-bootstrap-config.lock');
  const attempt = () => {
    const handle = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, `${process.pid}\n`, 'utf8');
      return { path: lockPath, handle };
    } catch (error) {
      fs.closeSync(handle);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Best-effort cleanup only.
      }
      throw error;
    }
  };

  try {
    return attempt();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs <= 300_000) {
      throw new Error('Another cc-portable-bootstrap configuration is already running.');
    }
    fs.unlinkSync(lockPath);
    return attempt();
  } catch (error) {
    if (error?.message?.startsWith('Another cc-portable-bootstrap')) throw error;
    throw new Error('Could not acquire the cc-portable-bootstrap configuration lock.');
  }
}

function releaseConfigurationLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.handle);
  } finally {
    try {
      fs.unlinkSync(lock.path);
    } catch {
      // A stale lock is recoverable on the next setup run.
    }
  }
}

// Commands this installer is allowed to replace without --force: the current
// cc-portable-bootstrap launchers plus every launcher shipped by the two
// predecessor repositories, so an upgrade is not treated as a foreign statusLine.
export function isManagedStatusCommand(command) {
  const normalized = String(command || '').trim().replace(/\\/g, '/').toLowerCase();
  const unquoted = normalized.replace(/^(['"])(.*)\1$/, '$2');
  const dir = '(?:cc-portable-bootstrap|cliproxy-usage-statusline)';
  const base = '(?:statusline|cliproxy-usage)';
  const legacyShell = /^(?:[a-z]:)?\/(?:.*\/)?cliproxy-usage(?:-statusline)?\/(?:[^/'"]+\/)?statusline\/statusline\.sh$/;
  const stablePosix = new RegExp(`^(?:[a-z]:)?/(?:.*/)?${dir}/${base}(?:\\.cmd)?$`);
  const stableCmd = new RegExp(`^cmd\\.exe /d /s /c ""[^"]*/${dir}/${base}\\.cmd""$`);
  const stablePowerShell = new RegExp(
    `^powershell\\.exe -nologo -noprofile -executionpolicy bypass -file "[^"]*/${dir}/${base}\\.ps1"$`,
  );
  return (
    legacyShell.test(unquoted) ||
    stablePosix.test(unquoted) ||
    stableCmd.test(normalized) ||
    stablePowerShell.test(normalized)
  );
}

export { isManagedStatusCommand as isCliproxyStatusCommand };

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

// Claude Code runs the status line through Git Bash whenever Git Bash is
// installed, and only falls back to PowerShell otherwise. That choice decides
// how the recorded command is parsed: Git Bash rewrites `/d` and `/s` into
// filesystem paths, so `cmd.exe /d /s /c ...` starts an interactive cmd.exe that
// prints its banner and echoes the status-line JSON instead of rendering it.
// System32\bash.exe is the WSL launcher, not Git Bash, so it does not count.
export function hasGitBash(env = process.env) {
  // Explicit override: set CC_BOOTSTRAP_GIT_BASH to 1 or 0 when detection gets it
  // wrong for a host, and so tests can pin either branch deterministically.
  const override = env.CC_BOOTSTRAP_GIT_BASH?.trim();
  if (override === '1') return true;
  if (override === '0') return false;

  const known = [
    env.ProgramFiles ? path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe') : null,
    env['ProgramFiles(x86)'] ? path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : null,
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  ].filter(Boolean);
  if (known.some((candidate) => fs.existsSync(candidate))) return true;

  const found = spawnSync('where', ['bash'], { encoding: 'utf8', env, windowsHide: true });
  if (found.error || found.status !== 0) return false;
  return String(found.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => /bash\.exe$/i.test(line) && !/[\\/]system32[\\/]/i.test(line));
}

function toPosixPath(windowsPath) {
  const forward = windowsPath.replace(/\\/g, '/');
  const drive = forward.match(/^([A-Za-z]):\//);
  return drive ? `/${drive[1].toLowerCase()}/${forward.slice(3)}` : forward;
}

export function launcherCommand(launcherPath, platform = process.platform, env = process.env) {
  const resolved = platform === 'win32' ? path.win32.resolve(launcherPath) : path.resolve(launcherPath);
  if (resolved.toLowerCase().endsWith('.ps1')) {
    return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${resolved}"`;
  }
  if (platform === 'win32') {
    // Git Bash executes a .cmd shim directly, so the bare quoted path is both
    // the shortest form and the only one that survives MSYS path rewriting.
    if (hasGitBash(env)) return quotePosix(toPosixPath(resolved));
    return `cmd.exe /d /s /c ""${resolved}""`;
  }
  if (resolved.toLowerCase().endsWith('.cmd')) {
    return `cmd.exe /d /s /c ""${resolved}""`;
  }
  return quotePosix(resolved);
}

function configuredSettings(document, command, force, proxyUrl) {
  const current = document.value.statusLine;
  const currentCommand = current?.command;
  if (current && currentCommand !== command && !isManagedStatusCommand(currentCommand) && !force) {
    throw new Error(
      'Existing statusLine is not managed by cc-portable-bootstrap; rerun with --force only after reviewing it.',
    );
  }

  const configured = {
    ...document.value,
    statusLine: {
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      type: 'command',
      command,
      refreshInterval: 3,
    },
  };
  if (proxyUrl) {
    const currentEnv = document.value.env;
    configured.env = {
      ...(currentEnv && typeof currentEnv === 'object' && !Array.isArray(currentEnv)
        ? currentEnv
        : {}),
      CLIPROXY_URL: proxyUrl,
    };
  }
  return configured;
}

function configuredHud(document) {
  const display = document.value.display;
  return {
    ...document.value,
    display: {
      ...(display && typeof display === 'object' && !Array.isArray(display) ? display : {}),
      showUsage: false,
      showContextBar: true,
      showTokenBreakdown: false,
    },
  };
}

export function configureInstallation({
  claudeDir = getClaudeDir(),
  settingsPath = path.join(claudeDir, 'settings.json'),
  hudConfigPath = path.join(claudeDir, 'plugins', 'claude-hud', 'config.json'),
  launcherPath,
  proxyUrl,
  platform = process.platform,
  env = process.env,
  force = false,
  dryRun = false,
  configureHud = true,
  // install.mjs plans a dry run before copying the launcher into place, so it
  // opts out explicitly. Every other caller keeps the existence check.
  requireLauncher = true,
  writeJson = atomicReplaceJson,
} = {}) {
  if (!launcherPath) throw new Error('--launcher is required');
  if (requireLauncher && !fs.existsSync(launcherPath)) {
    throw new Error(`Launcher not found: ${launcherPath}`);
  }
  const normalizedProxyUrl = proxyUrl ? normalizeManagementBase(proxyUrl) : null;
  if (proxyUrl && !normalizedProxyUrl) {
    throw new Error('Unsafe --proxy-url: use HTTPS, or HTTP only with a strict loopback host.');
  }

  const lock = dryRun ? null : acquireConfigurationLock(claudeDir);
  try {
    // Read and validate every file while holding the installer lock, before changing either one.
    const settingsDocument = readJsonDocument(settingsPath);
    const hudDocument = configureHud ? readJsonDocument(hudConfigPath) : null;
    const command = launcherCommand(launcherPath, platform, env);
    const nextSettings = configuredSettings(
      settingsDocument,
      command,
      force,
      normalizedProxyUrl,
    );
    const nextHud = hudDocument ? configuredHud(hudDocument) : null;

    let settingsResult;
    let hudResult = { changed: false, backup: null };
    try {
      settingsResult = writeJson(settingsDocument, nextSettings, { dryRun, target: 'settings' });
      if (hudDocument) {
        hudResult = writeJson(hudDocument, nextHud, { dryRun, target: 'hud' });
      }
    } catch (error) {
      if (!dryRun && settingsResult?.changed) {
        try {
          restoreJsonDocument(settingsDocument, settingsResult);
        } catch (rollbackError) {
          throw new Error(`${error.message}; settings rollback failed: ${rollbackError.message}`);
        }
      }
      throw error;
    }

    const publicResult = (result) => ({
      changed: Boolean(result.changed),
      backup: result.backup || null,
    });
    return {
      command,
      settings: { path: settingsPath, ...publicResult(settingsResult) },
      hud: { path: hudConfigPath, ...publicResult(hudResult) },
      proxyConfigured: Boolean(normalizedProxyUrl),
      dryRun,
    };
  } finally {
    releaseConfigurationLock(lock);
  }
}

function parseArguments(argv) {
  const options = {
    claudeDir: getClaudeDir(),
    force: false,
    dryRun: false,
    configureHud: true,
    platform: process.platform,
    proxyUrl: process.env.CLIPROXY_URL?.trim() || undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${argument}`);
      return argv[index];
    };

    switch (argument) {
      case '--claude-dir':
        options.claudeDir = path.resolve(value());
        break;
      case '--settings':
        options.settingsPath = path.resolve(value());
        break;
      case '--hud-config':
        options.hudConfigPath = path.resolve(value());
        break;
      case '--launcher':
        options.launcherPath = path.resolve(value());
        break;
      case '--platform':
        options.platform = value();
        break;
      case '--proxy-url':
        options.proxyUrl = value();
        break;
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-hud':
        options.configureHud = false;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  options.settingsPath ||= path.join(options.claudeDir, 'settings.json');
  options.hudConfigPath ||= path.join(
    options.claudeDir,
    'plugins',
    'claude-hud',
    'config.json',
  );
  return options;
}

function printResult(result) {
  const state = result.dryRun ? 'would update' : 'updated';
  if (result.settings.changed) console.log(`settings.json ${state}: ${result.settings.path}`);
  else console.log(`settings.json unchanged: ${result.settings.path}`);
  if (result.settings.backup) console.log(`settings backup: ${result.settings.backup}`);

  if (result.hud.changed) console.log(`claude-hud config ${state}: ${result.hud.path}`);
  else console.log(`claude-hud config unchanged: ${result.hud.path}`);
  if (result.hud.backup) console.log(`claude-hud backup: ${result.hud.backup}`);
  if (result.proxyConfigured) console.log('explicit management URL persisted');
  console.log(`stable statusLine launcher configured`);
}

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node.js 18+ is required; found ${process.versions.node}`);
  }
  const result = configureInstallation(parseArguments(process.argv.slice(2)));
  printResult(result);
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`cc-portable-bootstrap statusline setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
