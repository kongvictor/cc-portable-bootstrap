#!/usr/bin/env node
// Installs the status-line runtime at a stable path and points Claude Code at it.
// Replaces the predecessor repository's setup.sh + setup.ps1 pair: the copy,
// launcher selection and node-path pinning are identical on every platform, so
// they live here instead of being duplicated per shell.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getClaudeDir } from './discovery.mjs';
import { configureInstallation } from './configure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

export const RUNTIME_FILES = Object.freeze([
  'net.mjs',
  'layout.mjs',
  'discovery.mjs',
  'snapshot.mjs',
  'configure.mjs',
  'runtime.mjs',
]);

export function installDirFor(claudeDir) {
  return path.join(claudeDir, 'cc-portable-bootstrap');
}

// After `git pull`, the launcher path and the statusLine setting are unchanged,
// so nothing else in the plan notices that the installed runtime is older than
// the repository. Comparing the bytes is what makes an upgrade actually apply.
export function installedRuntimeIsStale({
  installDir,
  sourceRoot = REPO_ROOT,
  platform = process.platform,
} = {}) {
  const launchers = launchersFor(platform);
  const files = [
    ...RUNTIME_FILES.map((name) => [path.join(sourceRoot, 'core', 'statusline', name), name]),
    ...[launchers.primary, ...launchers.extra].map((name) => [path.join(sourceRoot, 'bin', name), name]),
  ];

  for (const [source, name] of files) {
    const installed = path.join(installDir, name);
    try {
      if (!fs.readFileSync(source).equals(fs.readFileSync(installed))) return true;
    } catch {
      // Missing on either side counts as stale; install will put it right.
      return true;
    }
  }
  return false;
}

// The refresh path runs every few seconds, so Windows uses a lightweight .cmd
// that execs node directly; PowerShell is only kept as a compatibility entry.
export function launchersFor(platform = process.platform) {
  return platform === 'win32'
    ? { primary: 'statusline.cmd', extra: ['statusline.ps1'] }
    : { primary: 'statusline', extra: [] };
}

function copyAtomic(source, destination, mode) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temporary);
  try {
    if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
  if (process.platform !== 'win32') fs.chmodSync(destination, mode);
}

function writeAtomicText(destination, contents, mode) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(handle, contents, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

export function installStatusline({
  claudeDir = getClaudeDir(),
  installDir,
  sourceRoot = REPO_ROOT,
  platform = process.platform,
  nodeBin = process.execPath,
  proxyUrl,
  force = false,
  dryRun = false,
  configureHud = true,
} = {}) {
  const target = installDir ? path.resolve(installDir) : installDirFor(claudeDir);
  const launchers = launchersFor(platform);

  const sources = new Map();
  for (const file of RUNTIME_FILES) {
    const source = path.join(sourceRoot, 'core', 'statusline', file);
    if (!fs.existsSync(source)) throw new Error(`Missing installer source: core/statusline/${file}`);
    sources.set(file, { source, mode: 0o600 });
  }
  for (const name of [launchers.primary, ...launchers.extra]) {
    const source = path.join(sourceRoot, 'bin', name);
    if (!fs.existsSync(source)) throw new Error(`Missing installer source: bin/${name}`);
    sources.set(name, { source, mode: 0o700 });
  }

  const launcherPath = path.join(target, launchers.primary);
  if (dryRun) {
    const settings = configureInstallation({
      claudeDir,
      launcherPath,
      proxyUrl,
      platform,
      force,
      dryRun: true,
      configureHud,
      // The launcher is not on disk yet during a dry run.
      requireLauncher: false,
    });
    return { installDir: target, launcherPath, dryRun: true, settings };
  }

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [name, { source, mode }] of sources) {
    copyAtomic(source, path.join(target, name), mode);
  }
  writeAtomicText(path.join(target, '.node-path'), `${nodeBin}\n`, 0o600);

  const settings = configureInstallation({
    claudeDir,
    launcherPath,
    proxyUrl,
    platform,
    force,
    configureHud,
  });
  return { installDir: target, launcherPath, dryRun: false, settings };
}
