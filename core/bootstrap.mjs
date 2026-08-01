#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { isManagedStatusCommand, launcherCommand } from './statusline/configure.mjs';
import {
  installDirFor,
  installStatusline,
  installedRuntimeIsStale,
  launchersFor,
} from './statusline/install.mjs';
import {
  applyProvisioning,
  inspectProvisioning,
  pendingManualSteps,
  planProvisioning,
  provisioningReport,
  removeProvisionedService,
} from './provision.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), '..');
const VERSION = fs.readFileSync(path.join(ROOT_DIR, 'VERSION'), 'utf8').trim();

const PRODUCT = 'cc-portable-bootstrap';
const CODEX_BEGIN = `<!-- BEGIN ${PRODUCT}:codex-mode -->`;
const CODEX_END = `<!-- END ${PRODUCT}:codex-mode -->`;
const PATH_BEGIN = `# >>> ${PRODUCT} PATH >>>`;
const PATH_END = `# <<< ${PRODUCT} PATH <<<`;
// Markers written by the two predecessor repositories. Setup rewrites them in
// place so an upgrade never leaves a second, stale managed block behind.
const LEGACY_CODEX_MARKERS = [{
  begin: '<!-- BEGIN claude-portable-bootstrap:codex-mode -->',
  end: '<!-- END claude-portable-bootstrap:codex-mode -->',
}];
const LEGACY_PATH_MARKERS = [{
  begin: '# >>> claude-portable-bootstrap PATH >>>',
  end: '# <<< claude-portable-bootstrap PATH <<<',
}];
const CODEX_HEADING = '# Claude 调度 + Codex 实现模式';
const LEGACY_CODEX_ALIAS_HEADING = '# CodexDev / CodexDevFast 触发词（用户自定义，非 managed block）';
const LEGACY_CODEX_ALIAS_SIGNATURES = Object.freeze([
  'CodexDev` 是上方 managed block',
  'CodexDevFast` = CodexDev',
  'service_tier',
  'gpt-5.6-sol catalog',
]);
const SECRET_BASENAME = 'cliproxy_apikey';
const CODEX_MCP_ARGS = Object.freeze([
  '--sandbox',
  'workspace-write',
  '--ask-for-approval',
  'never',
  'mcp-server',
]);
const LEGACY_CODEX_MCP_ARGS = Object.freeze(['mcp-server']);

function usage() {
  return `${PRODUCT} ${VERSION}

Usage:
  node core/bootstrap.mjs check [options]
  node core/bootstrap.mjs doctor [options]
  node core/bootstrap.mjs setup [--dry-run] [--yes] [options]
  node core/bootstrap.mjs restore [--dry-run] [--yes] [--backup ID] [options]
  node core/bootstrap.mjs uninstall [--dry-run] [--yes] [options]

Options:
  --home PATH          Override the user home (tests and portable installs)
  --config-dir PATH    Override Claude config dir (default: HOME/.claude)
  --profile PATH       Manage the POSIX PATH block in this profile
  --no-profile         Do not manage a POSIX shell profile
  --claude PATH        Use this Claude executable
  --codex PATH         Use this stable Codex executable
  --backup ID          Restore a specific backup
  --dry-run            Print planned changes without writing
  --yes                Apply without an interactive confirmation
  --no-legacy-migrate  Do not remove a recognized legacy claudex function
  --no-statusline      Do not install or configure the statusline
  --no-provision       Do not install or check dependencies (codex, cliproxyapi)
  --no-autostart       Do not enable the cliproxyapi background service
  --force              Replace an unrecognized statusLine (review it first)
  --external-change X  Record a wrapper-owned change in the same backup
  -h, --help           Show this help

The bootstrap never reads ~/.claude.json and never reads or prints the
cliproxy API key. The installed claudex launcher reads the key only at runtime.
`;
}

function parseArgs(argv) {
  const options = {
    action: 'check',
    dryRun: false,
    yes: false,
    home: process.env.HOME || os.homedir(),
    configDir: null,
    profile: undefined,
    claude: process.env.CLAUDE_BIN || null,
    codex: process.env.CODEX_BIN || null,
    backup: null,
    migrateLegacy: true,
    externalChanges: [],
    force: false,
    statusline: true,
    provision: true,
    autostart: true,
    help: false,
  };

  let index = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    options.action = argv[0];
    index = 1;
  }

  const takeValue = (arg, name) => {
    const equals = `${name}=`;
    if (arg.startsWith(equals)) return arg.slice(equals.length);
    index += 1;
    if (index >= argv.length) throw new Error(`${name} requires a value`);
    return argv[index];
  };

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-profile') options.profile = null;
    else if (arg === '--no-legacy-migrate') options.migrateLegacy = false;
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-statusline') options.statusline = false;
    else if (arg === '--no-provision') options.provision = false;
    else if (arg === '--no-autostart') options.autostart = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--home' || arg.startsWith('--home=')) options.home = takeValue(arg, '--home');
    else if (arg === '--config-dir' || arg.startsWith('--config-dir=')) options.configDir = takeValue(arg, '--config-dir');
    else if (arg === '--profile' || arg.startsWith('--profile=')) options.profile = takeValue(arg, '--profile');
    else if (arg === '--claude' || arg.startsWith('--claude=')) options.claude = takeValue(arg, '--claude');
    else if (arg === '--codex' || arg.startsWith('--codex=')) options.codex = takeValue(arg, '--codex');
    else if (arg === '--backup' || arg.startsWith('--backup=')) options.backup = takeValue(arg, '--backup');
    else if (arg === '--external-change' || arg.startsWith('--external-change=')) {
      const label = takeValue(arg, '--external-change').trim();
      if (!label || label.length > 120 || /[\r\n]/.test(label)) throw new Error('Invalid --external-change label');
      options.externalChanges.push(label);
    } else throw new Error(`Unknown option: ${arg}`);
  }

  if (!['check', 'doctor', 'setup', 'restore', 'uninstall'].includes(options.action)) {
    throw new Error(`Unknown action: ${options.action}`);
  }

  options.home = path.resolve(options.home);
  // Managed file paths always need a concrete directory, but the Claude CLI must
  // only be told about one when the user actually chose it — see sanitizedChildEnv.
  options.explicitConfigDir = options.configDir ? path.resolve(options.configDir) : null;
  options.configDir = path.resolve(options.configDir || path.join(options.home, '.claude'));
  if (options.profile === undefined) options.profile = defaultProfile(options.home);
  if (options.profile) options.profile = path.resolve(options.profile);
  return options;
}

function defaultProfile(home) {
  if (process.platform === 'win32') return null;
  if (process.env.CLAUDE_BOOTSTRAP_PROFILE) return process.env.CLAUDE_BOOTSTRAP_PROFILE;
  const shell = path.basename(process.env.SHELL || '');
  if (shell === 'zsh') return path.join(home, '.zshrc');
  if (shell === 'bash') return path.join(home, '.bashrc');
  if (fs.existsSync(path.join(home, '.zshrc'))) return path.join(home, '.zshrc');
  if (fs.existsSync(path.join(home, '.bashrc'))) return path.join(home, '.bashrc');
  return path.join(home, '.profile');
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function guardManagedPath(target, options) {
  const secretDir = path.join(options.home, '.secrets');
  if (isWithin(target, secretDir)) throw new Error('Refusing to manage a path inside HOME/.secrets');
  if (path.basename(target).toLowerCase() === '.claude.json') {
    throw new Error('Refusing to read or write ~/.claude.json; use the Claude MCP CLI');
  }
  if (!isWithin(target, options.home)) throw new Error(`Refusing to manage a path outside HOME: ${target}`);
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      return { logical: current, real: fs.realpathSync(current) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function managedTargetPath(target, options) {
  const logical = path.resolve(target);
  guardManagedPath(logical, options);
  try {
    fs.lstatSync(logical);
    const real = fs.realpathSync(logical);
    guardManagedPath(real, options);
    if (!fs.statSync(real).isFile()) throw new Error(`Refusing to manage a non-file path: ${logical}`);
    return real;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      if (fs.lstatSync(logical).isSymbolicLink()) throw new Error(`Refusing to replace a broken symlink: ${logical}`);
    } catch (linkError) {
      if (linkError.code !== 'ENOENT') throw linkError;
    }
    const ancestor = nearestExistingAncestor(path.dirname(logical));
    const suffix = path.relative(ancestor.logical, logical);
    const realTarget = path.join(ancestor.real, suffix);
    guardManagedPath(realTarget, options);
    return realTarget;
  }
}

function assertStableManagedPath(target, options) {
  const expected = path.resolve(target);
  const current = managedTargetPath(expected, options);
  if (normalizePathForCompare(current) !== normalizePathForCompare(expected)) {
    throw new Error(`Managed path changed through a symlink since planning: ${target}`);
  }
  const parent = path.dirname(expected);
  const ancestor = nearestExistingAncestor(parent);
  const currentParent = path.join(ancestor.real, path.relative(ancestor.logical, parent));
  if (normalizePathForCompare(currentParent) !== normalizePathForCompare(parent)) {
    throw new Error(`Managed parent path changed through a symlink since planning: ${target}`);
  }
  guardManagedPath(expected, options);
  return expected;
}

function sanitizedChildEnv(home, configDir = null) {
  const env = { ...process.env, HOME: home };
  if (process.platform === 'win32') env.USERPROFILE = home;

  // Only pin CLAUDE_CONFIG_DIR when the caller asked for a specific directory
  // (tests, portable installs). Setting it unconditionally moves where the CLI
  // looks for user-scope MCP servers: with it set, `claude mcp` reads
  // <configDir>/.claude.json instead of ~/.claude.json. That made check report a
  // registered server as missing, and would have made setup write a shadow
  // registration to the wrong file.
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

function spawnExecutableSync(executable, args, options = {}) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const quoteForCmd = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const commandLine = [executable, ...args].map(quoteForCmd).join(' ');
    // Node quotes arguments with backslash escapes, which cmd.exe does not
    // understand, so the payload has to be handed over verbatim. `/s` then
    // strips exactly the outer quote pair and leaves each argument intact.
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(executable, args, options);
}

function executableNames(name) {
  if (process.platform !== 'win32') return [name];
  if (path.extname(name)) return [name];
  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return extensions.map((extension) => `${name}${extension.toLowerCase()}`);
}

function pathCandidates(name) {
  if (!name) return [];
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return [path.resolve(name)];
  const results = [];
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const executable of executableNames(name)) results.push(path.resolve(directory, executable));
  }
  return results;
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(input) {
  for (const candidate of pathCandidates(input)) {
    if (!isExecutable(candidate)) continue;
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }
  return null;
}

function unstablePathReason(candidate) {
  if (!candidate) return 'empty path';
  const normalized = path.resolve(candidate).replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/cmux-cli-shims/') || normalized.includes('/cmux/')) return 'cmux shim path';

  const tempRoots = new Set([
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp',
    '/private/tmp',
  ].filter(Boolean).map((value) => path.resolve(value)));
  for (const tempRoot of tempRoots) {
    if (isWithin(candidate, tempRoot)) return 'temporary path';
  }

  if (/\/var\/folders\/[^/]+\/[^/]+\/t\//i.test(normalized)) return 'macOS temporary shim path';
  return null;
}

function validateCodexCapability(candidate, home) {
  const result = spawnExecutableSync(candidate, [...CODEX_MCP_ARGS, '--help'], {
    encoding: 'utf8',
    env: sanitizedChildEnv(home),
    timeout: 5000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  const safeText = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /mcp server/i.test(safeText);
}

function parseMcpGet(stdout) {
  const result = {
    present: false,
    scope: null,
    status: null,
    type: null,
    command: null,
    args: [],
    hasEnvironment: false,
  };
  const lines = String(stdout || '').split(/\r?\n/);
  if (!lines.some((line) => /^\s*codex:\s*$/.test(line))) return result;
  result.present = true;

  let inEnvironment = false;
  for (const line of lines) {
    const scope = line.match(/^\s*Scope:\s*(.+?)\s*$/);
    const status = line.match(/^\s*Status:\s*(.+?)\s*$/);
    const type = line.match(/^\s*Type:\s*(.+?)\s*$/);
    const command = line.match(/^\s*Command:\s*(.+?)\s*$/);
    const args = line.match(/^\s*Args:\s*(.*?)\s*$/);
    const environment = line.match(/^\s*Environment:\s*(.*?)\s*$/);
    if (scope) result.scope = scope[1];
    else if (status) result.status = status[1];
    else if (type) result.type = type[1];
    else if (command) result.command = command[1];
    else if (args) result.args = args[1] ? args[1].split(/\s+/) : [];

    if (environment) {
      const summary = environment[1].trim();
      if (summary && !/^(?:none|\(none\)|-|\{\})$/i.test(summary)) result.hasEnvironment = true;
      inEnvironment = true;
      continue;
    }
    if (inEnvironment) {
      if (/^\s*To remove this server/.test(line) || /^\s*[A-Za-z][^=]*:\s*/.test(line) || /^\S/.test(line)) {
        inEnvironment = false;
      } else if (line.trim() && !/^\s*(?:none|\(none\)|-|\{\})\s*$/i.test(line)) {
        result.hasEnvironment = true;
      }
    }
  }
  return result;
}

function inspectMcp(claudeBin, home, configDir = null) {
  const result = spawnExecutableSync(claudeBin, ['mcp', 'get', 'codex'], {
    encoding: 'utf8',
    env: sanitizedChildEnv(home, configDir),
    timeout: 15000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error('Unable to run `claude mcp get codex`');
  const parsed = parseMcpGet(result.stdout);
  if (result.status !== 0) {
    const diagnostic = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (!parsed.present && /(?:not found|does not exist|no mcp server)/i.test(diagnostic)) return parsed;
    throw new Error('Unable to determine the existing Codex MCP registration safely');
  }
  if (!parsed.present) throw new Error('Unexpected `claude mcp get codex` output; refusing to assume the registration is absent');
  return parsed;
}

function findClaude(options) {
  const candidates = [
    options.claude,
    'claude',
    path.join(options.home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function stableCodexCandidate(input, options) {
  const originalCandidates = pathCandidates(input).filter(isExecutable);
  const original = originalCandidates[0];
  if (!original) return null;
  let resolved;
  try {
    resolved = fs.realpathSync(original);
  } catch {
    return null;
  }
  if (unstablePathReason(original) || unstablePathReason(resolved)) return null;
  if (!validateCodexCapability(original, options.home)) return null;
  // Register the stable entry point (for example /opt/homebrew/bin/codex), not
  // its versioned package target. Both paths were checked for temporary shims.
  return path.resolve(original);
}

function findCodex(options, currentMcp) {
  const known = process.platform === 'win32'
    ? [
        path.join(options.home, '.local', 'bin', 'codex.exe'),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe') : null,
      ]
    : [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(options.home, '.local', 'bin', 'codex'),
      ];
  const candidates = [options.codex, currentMcp.command, 'codex', ...known].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    for (const expanded of pathCandidates(candidate)) {
      const key = normalizePathForCompare(expanded);
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = stableCodexCandidate(expanded, options);
      if (resolved) return resolved;
    }
  }
  return null;
}

function canonicalIfPossible(value) {
  if (!value) return null;
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function normalizedMcpScope(scope) {
  const value = String(scope || '').trim().toLowerCase();
  if (/user/.test(value)) return 'user';
  if (/project/.test(value)) return 'project';
  if (/local/.test(value)) return 'local';
  return value;
}

function standardMcpShape(codexBin) {
  return {
    present: true,
    scope: 'user',
    type: 'stdio',
    command: codexBin,
    args: [...CODEX_MCP_ARGS],
    hasEnvironment: false,
  };
}

function mcpDefinitionsEqual(left, right) {
  if (Boolean(left?.present) !== Boolean(right?.present)) return false;
  if (!left?.present) return true;
  if (!left.command || !right.command) return false;
  const leftArgs = Array.isArray(left.args) ? left.args : [];
  const rightArgs = Array.isArray(right.args) ? right.args : [];
  return normalizedMcpScope(left.scope) === normalizedMcpScope(right.scope)
    && String(left.type || '').trim().toLowerCase() === String(right.type || '').trim().toLowerCase()
    && normalizePathForCompare(canonicalIfPossible(left.command))
      === normalizePathForCompare(canonicalIfPossible(right.command))
    && leftArgs.length === rightArgs.length
    && leftArgs.every((value, index) => value === rightArgs[index])
    && Boolean(left.hasEnvironment) === Boolean(right.hasEnvironment);
}

function codexMcpArgsAreKnownSafe(args) {
  if (!Array.isArray(args)) return false;
  return [CODEX_MCP_ARGS, LEGACY_CODEX_MCP_ARGS].some((known) => (
    args.length === known.length
    && args.every((value, index) => value === known[index])
  ));
}

function mcpMatches(current, codexBin) {
  return mcpDefinitionsEqual(current, standardMcpShape(codexBin));
}

function mcpPriorShape(manifest) {
  const prior = manifest.mcp?.prior || {};
  return {
    present: Boolean(prior.present),
    scope: prior.scope,
    type: prior.type,
    command: prior.command,
    args: Array.isArray(prior.args) ? prior.args : [],
    hasEnvironment: Boolean(prior.hadEnvironment),
  };
}

function mcpReplacementIssue(current) {
  if (!current.present) return null;
  if (!/user/i.test(current.scope || '')) return 'the visible Codex MCP is not user scope';
  if (current.hasEnvironment) return 'the Codex MCP contains environment entries';
  if ((current.type || '').toLowerCase() !== 'stdio') return 'the Codex MCP is not stdio';
  if (!current.command) return 'the Codex MCP command is missing';
  if (!codexMcpArgsAreKnownSafe(current.args)) {
    return 'the Codex MCP has nonstandard arguments that may contain sensitive values';
  }
  return null;
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitBom(text) {
  return text.startsWith('﻿') ? { bom: '﻿', body: text.slice(1) } : { bom: '', body: text };
}

function renderManagedBlock(template) {
  return `${CODEX_BEGIN}\n${template.trim()}\n${CODEX_END}`;
}

// Rewrite predecessor markers to the current ones before any counting happens,
// so an upgraded machine keeps exactly one managed block instead of gaining a
// second one next to the old markers.
function adoptLegacyMarkers(text, legacyMarkers, begin, end) {
  let adopted = text;
  for (const marker of legacyMarkers) {
    if (marker.begin === begin && marker.end === end) continue;
    if (!adopted.includes(marker.begin) || !adopted.includes(marker.end)) continue;
    if (adopted.includes(begin) || adopted.includes(end)) {
      throw new Error('Both current and legacy managed markers are present; resolve the duplicate manually');
    }
    adopted = adopted.replaceAll(marker.begin, begin).replaceAll(marker.end, end);
  }
  return adopted;
}

function removeRecognizedLegacyCodexAliasSection(text) {
  const lines = text.split('\n');
  const matches = lines
    .map((line, index) => (line.trim() === LEGACY_CODEX_ALIAS_HEADING ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length > 1) throw new Error('Duplicate legacy CodexDev alias sections in CLAUDE.md');
  if (matches.length === 0) return text;

  const start = matches[0];
  let end = start + 1;
  while (end < lines.length && !/^#\s+/.test(lines[end])) end += 1;
  const section = lines.slice(start, end).join('\n');
  if (!LEGACY_CODEX_ALIAS_SIGNATURES.every((signature) => section.includes(signature))) {
    throw new Error('Unrecognized legacy CodexDev alias section in CLAUDE.md; review it manually');
  }
  lines.splice(start, end - start);
  return lines.join('\n');
}

function updateCodexManagedBlock(original, template) {
  const { bom, body } = splitBom(original);
  const eol = eolOf(body);
  let normalized = adoptLegacyMarkers(
    body.replaceAll('\r\n', '\n'),
    LEGACY_CODEX_MARKERS,
    CODEX_BEGIN,
    CODEX_END,
  );
  const block = renderManagedBlock(template);
  const beginCount = normalized.split(CODEX_BEGIN).length - 1;
  const endCount = normalized.split(CODEX_END).length - 1;

  if (beginCount !== endCount || beginCount > 1) throw new Error('Malformed Codex managed block in CLAUDE.md');
  if (beginCount === 1) {
    const start = normalized.indexOf(CODEX_BEGIN);
    const endMarker = normalized.indexOf(CODEX_END);
    if (endMarker < start) throw new Error('Malformed Codex managed block in CLAUDE.md');
    const end = endMarker + CODEX_END.length;
    normalized = `${normalized.slice(0, start)}${block}${normalized.slice(end)}`;
  } else {
    const lines = normalized.split('\n');
    const start = lines.findIndex((line) => line.trim() === CODEX_HEADING);
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !/^#\s+/.test(lines[end])) end += 1;
      lines.splice(start, end - start, ...block.split('\n'));
      normalized = lines.join('\n');
    } else {
      normalized = normalized.replace(/\s*$/, '');
      normalized = normalized ? `${normalized}\n\n${block}\n` : `${block}\n`;
    }
  }

  normalized = removeRecognizedLegacyCodexAliasSection(normalized);
  return `${bom}${normalized.replaceAll('\n', eol)}`;
}

function findLegacyClaudex(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:function\s+)?claudex\s*\(\s*\)\s*\{\s*$/.test(lines[index])) continue;
    let depth = 0;
    let end = index;
    for (; end < lines.length; end += 1) {
      depth += (lines[end].match(/\{/g) || []).length;
      depth -= (lines[end].match(/\}/g) || []).length;
      if (depth === 0) break;
    }
    if (depth !== 0) return { recognized: false, start: index, end: index };
    const functionText = lines.slice(index, end + 1).join('\n');
    const signatures = [
      'cliproxy_apikey',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'gpt-5.6-sol',
    ];
    if (!signatures.every((signature) => functionText.includes(signature))) {
      return { recognized: false, start: index, end };
    }

    let start = index;
    let commentStart = index;
    while (commentStart > 0 && /^\s*#/.test(lines[commentStart - 1])) commentStart -= 1;
    const commentText = lines.slice(commentStart, index).join('\n');
    if (/claudex/i.test(commentText) && /gpt-5\.6-sol/.test(commentText)) start = commentStart;
    return { recognized: true, start, end };
  }
  return null;
}

function pathBlock(binExpression = '"$HOME/.claude/bin"') {
  return `${PATH_BEGIN}\ncc_portable_bin=${binExpression}\ncase ":$PATH:" in\n  *":$cc_portable_bin:"*) ;;\n  *) export PATH="$cc_portable_bin:$PATH" ;;\nesac\nunset cc_portable_bin\n${PATH_END}`;
}

function posixBinExpression(options) {
  const relative = path.relative(options.home, path.join(options.configDir, 'bin')).split(path.sep).join('/');
  const escaped = relative.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
  return relative ? `"$HOME/${escaped}"` : '"$HOME"';
}

function updateProfile(original, migrateLegacy, binExpression) {
  const { bom, body } = splitBom(original);
  const eol = eolOf(body);
  let normalized = adoptLegacyMarkers(
    body.replaceAll('\r\n', '\n'),
    LEGACY_PATH_MARKERS,
    PATH_BEGIN,
    PATH_END,
  );
  let legacyStatus = 'absent';
  const lines = normalized.split('\n');
  const legacy = findLegacyClaudex(lines);
  if (legacy) {
    legacyStatus = legacy.recognized ? (migrateLegacy ? 'recognized' : 'retained') : 'unrecognized';
    if (legacy.recognized && migrateLegacy) {
      lines.splice(legacy.start, legacy.end - legacy.start + 1);
      normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }

  const block = pathBlock(binExpression);
  const beginCount = normalized.split(PATH_BEGIN).length - 1;
  const endCount = normalized.split(PATH_END).length - 1;
  if (beginCount !== endCount || beginCount > 1) throw new Error('Malformed PATH managed block in shell profile');
  if (beginCount === 1) {
    const start = normalized.indexOf(PATH_BEGIN);
    const endMarker = normalized.indexOf(PATH_END);
    if (endMarker < start) throw new Error('Malformed PATH managed block in shell profile');
    const end = endMarker + PATH_END.length;
    normalized = `${normalized.slice(0, start)}${block}${normalized.slice(end)}`;
  } else {
    normalized = normalized.replace(/\s*$/, '');
    normalized = normalized ? `${normalized}\n\n${block}\n` : `${block}\n`;
  }
  return { content: `${bom}${normalized.replaceAll('\n', eol)}`, legacyStatus };
}

function readOptionalText(file, options) {
  try {
    return readRegularManagedFile(file, options).data.toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function modeOf(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function readRegularManagedFile(file, options) {
  const stablePath = assertStableManagedPath(file, options);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(stablePath, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`Refusing to read a non-file path: ${stablePath}`);
    assertStableManagedPath(stablePath, options);
    const current = fs.lstatSync(stablePath);
    if (current.isSymbolicLink() || !current.isFile()
        || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`Managed path changed while opening: ${stablePath}`);
    }
    return { data: fs.readFileSync(descriptor), mode: opened.mode & 0o777 };
  } finally {
    fs.closeSync(descriptor);
  }
}

const CLAUDEX_MODELS = Object.freeze([
  Object.freeze({ name: 'sol', efforts: Object.freeze(['high', 'xhigh', 'max', 'ultra']) }),
  Object.freeze({ name: 'luna', efforts: Object.freeze(['high', 'xhigh', 'max']) }),
  Object.freeze({ name: 'terra', efforts: Object.freeze(['high', 'xhigh', 'max', 'ultra']) }),
]);

const LEGACY_CLAUDEX_TIERS = Object.freeze(['high', 'xhigh', 'max', 'ultra']);

// Terminal shortcuts carry both model and effort. Bare claudex defaults to
// Sol+xhigh without Fast; claudexfast keeps the matching default Fast alias.
function claudexShortcuts() {
  const shortcuts = [{ name: 'claudexfast', args: ['--fast'] }];
  for (const model of CLAUDEX_MODELS) {
    for (const effort of model.efforts) {
      const prefix = `claudex${model.name}${effort}`;
      const args = ['--gpt-model', model.name, '--effort', effort];
      shortcuts.push({ name: prefix, args });
      shortcuts.push({ name: `${prefix}fast`, args: [...args, '--fast'] });
    }
  }
  return shortcuts;
}

function claudexShortcutContent(shortcut, platform = process.platform) {
  return platform === 'win32'
    ? '@echo off\r\n'
      + `call "%~dp0claudex.cmd" ${shortcut.args.join(' ')} %*\r\n`
      + 'exit /b %ERRORLEVEL%\r\n'
    : '#!/bin/sh\n'
      + `exec "$(dirname "$0")/claudex" ${shortcut.args.join(' ')} "$@"\n`;
}

function legacyClaudexShortcuts() {
  return LEGACY_CLAUDEX_TIERS.flatMap((effort) => {
    const args = ['--effort', effort];
    return [
      { name: `claudex${effort}`, args },
      { name: `claudex${effort}fast`, args: [...args, '--fast'] },
    ];
  });
}

function desiredFiles(options) {
  const template = fs.readFileSync(
    path.join(ROOT_DIR, 'templates', 'modes', 'codex-implementation.md'),
    'utf8',
  );
  const claudeMd = managedTargetPath(path.join(options.configDir, 'CLAUDE.md'), options);
  const currentClaudeMd = readOptionalText(claudeMd, options);
  const files = [{
    path: claudeMd,
    content: updateCodexManagedBlock(currentClaudeMd, template),
    mode: modeOf(claudeMd) ?? 0o600,
    label: 'Codex mode managed block',
  }];

  const binDir = path.join(options.configDir, 'bin');
  if (process.platform === 'win32') {
    files.push(
      {
        path: managedTargetPath(path.join(binDir, 'claudex.ps1'), options),
        content: fs.readFileSync(path.join(ROOT_DIR, 'templates', 'claudex.ps1'), 'utf8'),
        mode: 0o700,
        label: 'Windows claudex PowerShell launcher',
      },
      {
        path: managedTargetPath(path.join(binDir, 'claudex.cmd'), options),
        content: fs.readFileSync(path.join(ROOT_DIR, 'templates', 'claudex.cmd'), 'utf8'),
        mode: 0o700,
        label: 'Windows claudex CMD shim',
      },
    );
    for (const shortcut of claudexShortcuts()) {
      files.push({
        path: managedTargetPath(path.join(binDir, `${shortcut.name}.cmd`), options),
        content: claudexShortcutContent(shortcut),
        mode: 0o700,
        label: `Windows ${shortcut.name} shortcut`,
      });
    }
  } else {
    files.push({
      path: managedTargetPath(path.join(binDir, 'claudex'), options),
      content: fs.readFileSync(path.join(ROOT_DIR, 'templates', 'claudex.sh'), 'utf8'),
      mode: 0o700,
      label: 'POSIX claudex launcher',
    });
    for (const shortcut of claudexShortcuts()) {
      files.push({
        path: managedTargetPath(path.join(binDir, shortcut.name), options),
        content: claudexShortcutContent(shortcut),
        mode: 0o700,
        label: `POSIX ${shortcut.name} shortcut`,
      });
    }
  }

  if (options.profile) {
    const profilePath = managedTargetPath(options.profile, options);
    const currentProfile = readOptionalText(profilePath, options);
    const updated = updateProfile(currentProfile, options.migrateLegacy, posixBinExpression(options));
    files.push({
      path: profilePath,
      content: updated.content,
      mode: modeOf(profilePath) ?? 0o600,
      label: 'shell PATH managed block',
      legacyStatus: updated.legacyStatus,
    });
  }

  for (const file of files) guardManagedPath(file.path, options);
  return files;
}

function inspectObsoleteClaudexShortcuts(options) {
  const binDir = path.join(options.configDir, 'bin');
  const removals = [];
  const warnings = [];
  for (const shortcut of legacyClaudexShortcuts()) {
    const basename = process.platform === 'win32' ? `${shortcut.name}.cmd` : shortcut.name;
    const logicalTarget = path.resolve(path.join(binDir, basename));
    guardManagedPath(logicalTarget, options);
    const expectedContent = claudexShortcutContent(shortcut);
    let target;
    let current;
    try {
      const metadata = fs.lstatSync(logicalTarget);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        warnings.push(`obsolete claudex shortcut was preserved because it is not a regular managed file: ${logicalTarget}`);
        continue;
      }
      target = managedTargetPath(logicalTarget, options);
      if (normalizePathForCompare(target) !== normalizePathForCompare(logicalTarget)) {
        warnings.push(`obsolete claudex shortcut was preserved because its path resolves through a symlink: ${logicalTarget}`);
        continue;
      }
      current = readRegularManagedFile(target, options);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      warnings.push(`obsolete claudex shortcut was preserved because it could not be inspected safely: ${logicalTarget}`);
      continue;
    }
    if (current.data.toString('utf8') !== expectedContent) {
      warnings.push(`obsolete claudex shortcut was preserved because its content was modified: ${target}`);
      continue;
    }
    removals.push({
      action: 'remove',
      path: target,
      expectedContent,
      mode: current.mode,
      label: `obsolete ${shortcut.name} shortcut`,
    });
  }
  return { removals, warnings };
}

function fileNeedsChange(file, options) {
  try {
    const current = readRegularManagedFile(file.path, options);
    if (current.data.toString('utf8') !== file.content) return true;
    if (process.platform !== 'win32' && current.mode !== file.mode) return true;
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function secretStatus(options) {
  const file = path.join(options.home, '.secrets', SECRET_BASENAME);
  try {
    const stat = fs.statSync(file);
    return { file, present: stat.isFile() && stat.size > 0 };
  } catch {
    return { file, present: false };
  }
}

// The status line now ships in this repository, so its state is read from disk
// rather than from a separate plugin listing.
function inspectStatusline(options) {
  const installDir = installDirFor(options.configDir);
  const launcher = path.join(installDir, launchersFor().primary);
  const settingsPath = path.join(options.configDir, 'settings.json');

  let configured = null;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    configured = settings?.statusLine?.command ?? null;
  } catch {
    // A missing or unreadable settings file simply means "not configured yet".
  }

  const installed = fs.existsSync(launcher);
  if (!configured) return { state: installed ? 'installed-not-configured' : 'missing', installDir };
  if (configured === launcherCommand(launcher)) {
    if (!installed) return { state: 'configured-not-installed', installDir };
    // Configured and present, but the repository may have moved on since.
    const stale = installedRuntimeIsStale({ installDir, sourceRoot: ROOT_DIR });
    return { state: stale ? 'stale' : 'current', installDir };
  }
  return {
    state: isManagedStatusCommand(configured) ? 'predecessor' : 'foreign',
    installDir,
  };
}

function buildContext(options) {
  const claudeBin = findClaude(options);
  if (!claudeBin) throw new Error('Claude executable not found; install Claude Code or pass --claude');
  const currentMcp = inspectMcp(claudeBin, options.home, options.explicitConfigDir);
  const codexBin = findCodex(options, currentMcp);
  if (!codexBin) {
    throw new Error('No stable Codex binary with `mcp-server` support found (cmux/TEMP shims are excluded)');
  }
  const files = desiredFiles(options);
  const obsoleteShortcuts = inspectObsoleteClaudexShortcuts(options);
  const statusline = inspectStatusline(options);
  return {
    options,
    claudeBin,
    codexBin,
    currentMcp,
    files,
    changedFiles: [
      ...files.filter((file) => fileNeedsChange(file, options)).map((file) => ({ ...file, action: 'write' })),
      ...obsoleteShortcuts.removals,
    ],
    warnings: obsoleteShortcuts.warnings,
    mcpChange: mcpMatches(currentMcp, codexBin) ? 'none' : (currentMcp.present ? 'replace' : 'add'),
    externalChanges: [...new Set(options.externalChanges)],
    secret: secretStatus(options),
    statusline,
    statuslineChange: statuslineChangeFor(statusline, options),
  };
}

function buildCheckContext(options) {
  const claudeBin = findClaude(options);
  let currentMcp = parseMcpGet('');
  let mcpInspection = claudeBin ? 'ok' : 'unavailable';
  if (claudeBin) {
    try {
      currentMcp = inspectMcp(claudeBin, options.home, options.explicitConfigDir);
    } catch {
      mcpInspection = 'failed';
    }
  }
  const codexBin = findCodex(options, currentMcp);
  const files = desiredFiles(options);
  const obsoleteShortcuts = inspectObsoleteClaudexShortcuts(options);
  const statusline = inspectStatusline(options);
  return {
    options,
    claudeBin,
    codexBin,
    currentMcp,
    mcpInspection,
    files,
    changedFiles: [
      ...files.filter((file) => fileNeedsChange(file, options)).map((file) => ({ ...file, action: 'write' })),
      ...obsoleteShortcuts.removals,
    ],
    warnings: obsoleteShortcuts.warnings,
    mcpChange: claudeBin && mcpInspection === 'ok' && codexBin
      ? (mcpMatches(currentMcp, codexBin) ? 'none' : (currentMcp.present ? 'replace' : 'add'))
      : 'unknown',
    externalChanges: [],
    secret: secretStatus(options),
    statusline,
    statuslineChange: statuslineChangeFor(statusline, options),
  };
}

// A foreign statusLine is never silently replaced; setup reports it and skips
// that single change unless the user passes --force. Every other bootstrap
// change still applies, so one unrecognized setting cannot block the install.
function statuslineChangeFor(statusline, options) {
  if (options.statusline === false) return 'none';
  if (statusline.state === 'current') return 'none';
  if (statusline.state === 'foreign') return options.force ? 'replace' : 'blocked';
  if (statusline.state === 'stale') return 'update';
  return statusline.state === 'predecessor' ? 'upgrade' : 'install';
}

function printCheck(context) {
  let healthy = true;
  console.log(`${PRODUCT} ${VERSION}`);
  console.log(`[ok] Node.js ${process.versions.node}`);
  if (context.claudeBin) console.log(`[ok] Claude CLI: ${context.claudeBin}`);
  else {
    healthy = false;
    console.log('[missing] Claude CLI: install Claude Code or pass --claude');
  }
  if (context.codexBin) console.log(`[ok] Stable Codex: ${context.codexBin}`);
  else {
    healthy = false;
    console.log('[missing] Stable Codex: no non-temporary executable with mcp-server support found');
  }

  if (context.mcpChange === 'none') console.log('[ok] Codex MCP: user-scope stdio registration is current');
  else if (context.mcpChange === 'unknown') {
    healthy = false;
    if (context.mcpInspection === 'failed') {
      console.log('[unknown] Codex MCP: Claude CLI output could not be interpreted safely');
    } else {
      console.log('[unknown] Codex MCP: cannot inspect until Claude and stable Codex are available');
    }
  } else {
    healthy = false;
    const issue = mcpReplacementIssue(context.currentMcp);
    if (context.mcpChange === 'replace') {
      console.log(`[blocked] Codex MCP: ${issue || 'automatic replacement is disabled because Claude MCP remove has no compare-and-swap protection'}`);
    } else console.log(`[needs-setup] Codex MCP: ${context.mcpChange}`);
  }

  for (const file of context.files) {
    if (fileNeedsChange(file, context.options)) {
      healthy = false;
      console.log(`[needs-setup] ${file.label}: ${file.path}`);
    } else console.log(`[ok] ${file.label}: ${file.path}`);
    if (file.legacyStatus === 'unrecognized' || file.legacyStatus === 'retained') {
      healthy = false;
      const reason = file.legacyStatus === 'retained' ? 'retained legacy' : 'unrecognized';
      console.log(`[warning] A ${reason} claudex shell function may shadow the installed executable`);
    }
  }
  for (const file of (context.changedFiles || []).filter((entry) => entry.action === 'remove')) {
    healthy = false;
    console.log(`[needs-setup] remove ${file.label}: ${file.path}`);
  }
  for (const warning of context.warnings || []) {
    healthy = false;
    console.log(`[warning] ${warning}`);
  }

  if (context.secret.present) console.log('[ok] claudex secret file: present and non-empty (value not read)');
  else {
    healthy = false;
    console.log('[missing] claudex secret file: create HOME/.secrets/cliproxy_apikey yourself');
  }

  const statusline = context.statusline || { state: 'unknown' };
  if (statusline.state === 'current') {
    console.log(`[ok] statusline: installed and configured at ${statusline.installDir}`);
  } else if (statusline.state === 'foreign') {
    healthy = false;
    console.log('[warning] statusline: an unrecognized statusLine is configured; review it, then rerun setup with --force');
  } else if (statusline.state === 'stale') {
    healthy = false;
    console.log('[needs-setup] statusline: the installed runtime is older than this checkout; rerun setup');
  } else if (statusline.state === 'predecessor') {
    console.log('[needs-setup] statusline: a predecessor launcher is configured; setup will upgrade it');
  } else {
    healthy = false;
    console.log('[needs-setup] statusline: not installed for this Claude config directory');
  }
  return healthy;
}

function printPlan(context, action) {
  const prefix = action === 'restore' ? 'restore' : 'setup';
  console.log(`${prefix} plan:`);
  for (const file of context.changedFiles || []) {
    console.log(`  - ${file.action || 'write'}: ${file.path} (${file.label})`);
  }
  for (const warning of context.warnings || []) console.log(`  - warning: ${warning}`);
  if (context.mcpChange && context.mcpChange !== 'none') {
    console.log(`  - ${context.mcpChange}: user-scope Codex MCP via \`claude mcp\` CLI`);
  }
  for (const label of context.externalChanges || []) console.log(`  - external wrapper change: ${label}`);
  if (!(context.changedFiles || []).length
      && (!context.mcpChange || context.mcpChange === 'none')
      && !(context.externalChanges || []).length) {
    console.log('  - no bootstrap changes required');
  }
  if (context.statuslineChange && context.statuslineChange !== 'none') {
    console.log(`  - ${context.statuslineChange}: statusline runtime and statusLine setting`);
  }
}

function timestampId(prefix = 'setup') {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', 'Z');
  return `${prefix}-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function withPinnedManagedParent(file, options, callback) {
  const stablePath = options ? assertStableManagedPath(file, options) : path.resolve(file);
  const parent = path.dirname(stablePath);
  const parentLink = fs.lstatSync(parent);
  if (!parentLink.isDirectory() || parentLink.isSymbolicLink()) {
    throw new Error(`Refusing to use an unsafe managed parent: ${parent}`);
  }
  const expectedParent = fs.statSync(parent);
  const previousDirectory = process.cwd();
  process.chdir(parent);
  try {
    const pinnedParent = fs.statSync('.');
    if (!sameFileIdentity(expectedParent, pinnedParent)) {
      throw new Error(`Managed parent changed while opening: ${file}`);
    }
    return callback(path.basename(stablePath));
  } finally {
    process.chdir(previousDirectory);
  }
}

function writeAtomic(file, data, mode = 0o600, options = null) {
  if (options) assertStableManagedPath(file, options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (options) assertStableManagedPath(file, options);
  const nonce = `${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
  withPinnedManagedParent(file, options, (basename) => {
    const temp = `.${basename}.${nonce}.tmp`;
    fs.writeFileSync(temp, data, { mode, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(temp, mode);
    try {
      if (process.platform === 'win32' && fs.existsSync(basename)) {
        const displaced = `.${basename}.${nonce}.previous`;
        fs.renameSync(basename, displaced);
        try {
          fs.renameSync(temp, basename);
        } catch (error) {
          try { fs.renameSync(displaced, basename); } catch {}
          throw error;
        }
        fs.rmSync(displaced, { force: true });
      } else {
        fs.renameSync(temp, basename);
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    if (process.platform !== 'win32') fs.chmodSync(basename, mode);
  });
  if (options) assertStableManagedPath(file, options);
}

function removeManagedFile(file, options) {
  const target = assertStableManagedPath(file, options);
  let expectedTarget;
  try {
    expectedTarget = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!expectedTarget.isFile() || expectedTarget.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-file path: ${target}`);
  }
  withPinnedManagedParent(target, options, (basename) => {
    const pinnedTarget = fs.lstatSync(basename);
    if (!pinnedTarget.isFile() || pinnedTarget.isSymbolicLink()
        || !sameFileIdentity(expectedTarget, pinnedTarget)) {
      throw new Error(`Managed file changed while opening its parent: ${target}`);
    }
    fs.unlinkSync(basename);
  });
  assertStableManagedPath(target, options);
}

function removeManagedFileWithExpectedContent(file, expectedContent, options) {
  const current = readRegularManagedFile(file, options);
  if (current.data.toString('utf8') !== expectedContent) {
    throw new Error(`Refusing to remove a managed file whose content changed after planning: ${file}`);
  }
  removeManagedFile(file, options);
}

function backupRoot(options) {
  return path.join(options.configDir, 'portable-bootstrap', 'backups');
}

function createBackup(options, context, label = 'setup') {
  const id = timestampId(label);
  const directory = path.join(backupRoot(options), id);
  const filesDirectory = path.join(directory, 'files');
  assertStableManagedPath(path.join(filesDirectory, '.boundary-check'), options);
  ensurePrivateDir(filesDirectory);
  assertStableManagedPath(path.join(filesDirectory, '.boundary-check'), options);

  const fileEntries = [];
  context.changedFiles.forEach((file, index) => {
    const stablePath = assertStableManagedPath(file.path, options);
    const entry = {
      path: stablePath,
      existed: false,
      backup: null,
      mode: null,
    };
    let original = null;
    try {
      original = readRegularManagedFile(stablePath, options);
      entry.existed = true;
      entry.mode = original.mode;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assertStableManagedPath(stablePath, options);
    }
    if (entry.existed) {
      const name = String(index).padStart(4, '0');
      const destination = path.join(filesDirectory, name);
      writeAtomic(destination, original.data, 0o600, options);
      entry.backup = path.relative(directory, destination);
    }
    fileEntries.push(entry);
  });

  const mcp = {
    changed: context.mcpChange !== 'none',
    prior: {
      present: context.currentMcp.present,
      scope: context.currentMcp.scope,
      type: context.currentMcp.type,
      command: context.currentMcp.command,
      args: context.currentMcp.args,
      hadEnvironment: context.currentMcp.hasEnvironment,
    },
  };
  const manifest = {
    schemaVersion: 1,
    id,
    label,
    createdAt: new Date().toISOString(),
    bootstrapVersion: VERSION,
    files: fileEntries,
    mcp,
    externalChanges: context.externalChanges || [],
  };
  writeAtomic(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600, options);
  return { id, directory, manifest };
}

function runClaudeMcp(claudeBin, args, home, configDir = null) {
  const result = spawnExecutableSync(claudeBin, ['mcp', ...args], {
    encoding: 'utf8',
    env: sanitizedChildEnv(home, configDir),
    timeout: 30000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return { invoked: !result.error, succeeded: !result.error && result.status === 0 };
}

function withMcpOperationLock(options, callback) {
  const directory = path.join(options.configDir, 'portable-bootstrap');
  const lockFile = path.join(directory, 'mcp-operation.lock');
  assertStableManagedPath(lockFile, options);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertStableManagedPath(lockFile, options);
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another bootstrap MCP operation is active; remove stale lock only after checking no bootstrap is running: ${lockFile}`);
    }
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return callback();
  } finally {
    fs.closeSync(descriptor);
    removeManagedFile(lockFile, options);
  }
}

function addCodexMcp(claudeBin, codexBin, home, args = CODEX_MCP_ARGS, configDir = null) {
  return runClaudeMcp(
    claudeBin,
    ['add', '--scope', 'user', '--transport', 'stdio', 'codex', '--', codexBin, ...args],
    home,
    configDir,
  );
}

function addCodexMcpWithPostcondition(
  claudeBin,
  codexBin,
  home,
  args,
  configDir,
  expected,
  mutation,
) {
  const command = addCodexMcp(claudeBin, codexBin, home, args, configDir);
  let current;
  try {
    current = inspectMcp(claudeBin, home, configDir);
  } catch {
    throw new Error('Unable to verify Codex MCP after add; definition was not removed');
  }
  if (mcpDefinitionsEqual(current, expected)) {
    mutation.added = true;
    return;
  }
  if (current.present) {
    throw new Error('Codex MCP changed concurrently during add; the visible definition was preserved');
  }
  const reason = command.invoked ? 'Claude MCP add did not reach its required postcondition' : 'Unable to invoke Claude MCP add';
  throw new Error(`${reason}; no automatic remove was attempted`);
}

function applyMcpDesired(context, options, mutation) {
  if (context.mcpChange === 'none') return;
  if (context.mcpChange === 'replace') {
    throw new Error('Refusing automatic Codex MCP replacement because `claude mcp remove` has no compare-and-swap protection; remove the old user-scope definition manually, then rerun setup');
  }
  withMcpOperationLock(options, () => {
    const current = inspectMcp(context.claudeBin, options.home, options.explicitConfigDir);
    if (!mcpDefinitionsEqual(current, context.currentMcp)) {
      throw new Error('Codex MCP changed concurrently after planning; refusing setup');
    }
    if (current.present) throw new Error('Codex MCP appeared concurrently before registration; refusing setup');
    addCodexMcpWithPostcondition(
      context.claudeBin,
      context.codexBin,
      options.home,
      CODEX_MCP_ARGS,
      options.explicitConfigDir,
      standardMcpShape(context.codexBin),
      mutation,
    );
  });
}

function validateRestoreManifest(manifest, directory, options) {
  if (!Array.isArray(manifest.files)) throw new Error('Invalid backup file list');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
        || typeof entry.existed !== 'boolean') {
      throw new Error('Invalid backup file entry');
    }
    const target = assertStableManagedPath(entry.path, options);
    const key = normalizePathForCompare(target);
    if (seen.has(key)) throw new Error('Duplicate backup file target');
    seen.add(key);
    if (entry.existed) {
      if (typeof entry.backup !== 'string') throw new Error('Invalid backup file reference');
      const source = path.resolve(directory, entry.backup);
      if (!isWithin(source, directory)) throw new Error('Invalid backup file path');
      readRegularManagedFile(source, options);
      const mode = entry.mode ?? 0o600;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid backup file mode');
    } else if (entry.backup !== null && entry.backup !== undefined) {
      throw new Error('Unexpected backup file reference');
    }
  }
}

function restoreFiles(manifest, directory, options) {
  validateRestoreManifest(manifest, directory, options);
  for (const entry of manifest.files) {
    const target = assertStableManagedPath(entry.path, options);
    if (entry.existed) {
      const source = path.resolve(directory, entry.backup);
      const original = readRegularManagedFile(source, options);
      const mode = entry.mode ?? 0o600;
      assertStableManagedPath(target, options);
      writeAtomic(target, original.data, mode, options);
    } else {
      removeManagedFile(target, options);
    }
  }
}

function restoreMcp(
  manifest,
  claudeBin,
  options,
  expectedCurrent = undefined,
  allowAbsentCurrent = false,
  mutation = { removed: false, added: false },
) {
  if (!manifest.mcp?.changed) return;
  const priorShape = mcpPriorShape(manifest);
  const issue = mcpReplacementIssue(priorShape);
  if (issue) throw new Error(`Backup MCP cannot be safely restored because ${issue}`);

  withMcpOperationLock(options, () => {
    const current = inspectMcp(claudeBin, options.home, options.explicitConfigDir);
    if (mcpDefinitionsEqual(current, priorShape)) return;
    if (expectedCurrent !== undefined
        && !mcpDefinitionsEqual(current, expectedCurrent)
        && !(allowAbsentCurrent && !current.present)) {
      throw new Error('Codex MCP changed concurrently; refusing to overwrite the new definition');
    }
    if (current.present) {
      throw new Error('Refusing automatic Codex MCP removal during restore because the Claude CLI has no compare-and-swap remove; the visible definition was preserved for manual handling');
    }
    if (priorShape.present) {
      addCodexMcpWithPostcondition(
        claudeBin,
        priorShape.command,
        options.home,
        priorShape.args,
        options.explicitConfigDir,
        priorShape,
        mutation,
      );
    }
  });
}

function rollbackFromBackup(
  backup,
  context,
  options,
  expectedMcpCurrent = undefined,
  allowAbsentCurrent = false,
) {
  const failures = [];
  try {
    restoreFiles(backup.manifest, backup.directory, options);
  } catch {
    failures.push('files');
  }
  try {
    restoreMcp(
      backup.manifest,
      context.claudeBin,
      options,
      expectedMcpCurrent,
      allowAbsentCurrent,
    );
  } catch (error) {
    failures.push(`MCP (${error.message})`);
  }
  return failures;
}

function statePath(options) {
  return path.join(options.configDir, 'portable-bootstrap', 'state.json');
}

function readState(options) {
  try {
    const raw = readRegularManagedFile(statePath(options), options).data.toString('utf8');
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, history: [] };
    throw new Error('Invalid portable-bootstrap state.json');
  }
}

function writeState(options, update) {
  const state = readState(options);
  const next = {
    ...state,
    schemaVersion: 1,
    bootstrapVersion: VERSION,
    ...update,
  };
  writeAtomic(statePath(options), `${JSON.stringify(next, null, 2)}\n`, 0o600, options);
}

async function confirmApply(options, message) {
  if (options.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Confirmation required; rerun with --yes after reviewing --dry-run output');
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${message} [y/N] `)).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) throw new Error('Cancelled');
  } finally {
    prompt.close();
  }
}

async function setup(options) {
  const context = buildContext(options);
  printPlan(context, 'setup');

  // Dependency provisioning is planned alongside the file/MCP changes so a
  // dry-run shows the whole install, not just the parts this core owns.
  const provisionState = options.provision
    ? await inspectProvisioning({
      home: options.home,
      claudeBin: context.claudeBin,
      explicitCodex: options.codex,
    })
    : null;
  const provisionSteps = provisionState ? planProvisioning(provisionState) : [];
  for (const step of provisionSteps) console.log(`  - ${step.action}: ${step.detail}`);
  const statuslineApplies = context.statuslineChange !== 'none' && context.statuslineChange !== 'blocked';
  const hasChanges = context.changedFiles.length > 0
    || context.mcpChange !== 'none'
    || context.externalChanges.length > 0
    || statuslineApplies
    || provisionSteps.length > 0;
  if (!hasChanges) {
    console.log('Setup is already current.');
    if (context.statuslineChange === 'blocked') {
      console.log('Note: an unrecognized statusLine was left untouched; rerun with --force after reviewing it.');
    }
    return;
  }
  const replacementIssue = context.mcpChange === 'replace' ? mcpReplacementIssue(context.currentMcp) : null;
  if (replacementIssue) throw new Error(`Refusing to replace the Codex MCP because ${replacementIssue}`);
  if (context.mcpChange === 'replace') {
    throw new Error('Refusing automatic Codex MCP replacement because the Claude CLI has no compare-and-swap remove; remove the old user-scope definition manually, then rerun setup');
  }
  if (context.statuslineChange === 'blocked') {
    console.log('[warning] statusline: an unrecognized statusLine is configured and will be left untouched; rerun with --force after reviewing it.');
  }
  if (options.dryRun) {
    console.log('Dry-run complete; no files, MCP settings, or statusline changed.');
    return;
  }
  await confirmApply(options, 'Apply this setup plan?');

  const backup = createBackup(options, context);
  const mcpMutation = { removed: false, added: false };
  try {
    for (const file of context.changedFiles) {
      if (file.action === 'remove') {
        removeManagedFileWithExpectedContent(file.path, file.expectedContent, options);
      } else {
        writeAtomic(file.path, file.content, file.mode, options);
      }
    }
    applyMcpDesired(context, options, mcpMutation);
    if (statuslineApplies) {
      // configure.mjs performs its own atomic write, backup and rollback for
      // settings.json, so a failure here leaves that file untouched.
      // Deliberately no proxyUrl: pinning CLIPROXY_URL into settings.env would
      // override the shell's value in every child process, breaking the
      // switch-endpoint helpers. The status line reads it from the environment.
      const installed = installStatusline({
        claudeDir: options.configDir,
        sourceRoot: ROOT_DIR,
        force: options.force,
      });
      console.log(`statusline installed: ${installed.installDir}`);
    }
    const state = readState(options);
    const history = [...(state.history || []), backup.id].slice(-50);
    writeState(options, {
      history,
      lastBackupId: backup.id,
      lastSetupAt: new Date().toISOString(),
    });

    // Dependency installs run last: they are the slowest and least reversible,
    // and a failure here must not roll back a otherwise-good core install.
    if (provisionSteps.length) {
      const result = await applyProvisioning(provisionState, provisionSteps, {
        home: options.home,
        claudeBin: context.claudeBin,
        autostart: options.autostart,
        log: (message) => console.log(message),
      });
      for (const warning of result.warnings) console.log(`[warning] ${warning}`);
    }
  } catch (error) {
    const expectedMcpCurrent = mcpMutation.added
      ? standardMcpShape(context.codexBin)
      : (mcpMutation.removed ? parseMcpGet('') : context.currentMcp);
    const rollbackFailures = rollbackFromBackup(
      backup,
      context,
      options,
      expectedMcpCurrent,
      mcpMutation.removed,
    );
    const outcome = rollbackFailures.length === 0
      ? `setup rolled back from backup ${backup.id}`
      : `rollback incomplete for ${rollbackFailures.join(' and ')}; use backup ${backup.id}`;
    throw new Error(`${error.message}; ${outcome}`);
  }
  console.log(`Setup complete. Backup: ${backup.id}`);

  if (provisionState) {
    const after = await inspectProvisioning({ home: options.home, claudeBin: context.claudeBin });
    for (const step of pendingManualSteps(after)) {
      console.log(`[action required] ${step.why}: run \`${step.command}\``);
    }
  }
}

function loadBackup(options) {
  const state = readState(options);
  const id = options.backup || state.lastBackupId;
  if (!id) throw new Error('No setup backup is recorded; pass --backup ID if one exists');
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error('Invalid backup ID');
  }
  const root = path.resolve(backupRoot(options));
  const directory = path.resolve(root, id);
  if (path.dirname(directory) !== root) throw new Error('Invalid backup ID');
  const manifestPath = path.join(directory, 'manifest.json');
  let manifest;
  try {
    const raw = readRegularManagedFile(manifestPath, options).data.toString('utf8');
    manifest = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Backup manifest not found or invalid: ${id}`);
  }
  if (manifest.schemaVersion !== 1 || manifest.id !== id) throw new Error(`Unsupported backup manifest: ${id}`);
  return { id, directory, manifest };
}

function buildPreRestoreContext(backup, claudeBin, options) {
  validateRestoreManifest(backup.manifest, backup.directory, options);
  const mcpChanged = Boolean(backup.manifest.mcp?.changed);
  const currentMcp = mcpChanged ? inspectMcp(claudeBin, options.home, options.explicitConfigDir) : parseMcpGet('');
  const issue = mcpChanged ? mcpReplacementIssue(currentMcp) : null;
  if (issue) throw new Error(`Refusing restore because the current Codex MCP cannot be safely backed up: ${issue}`);
  return {
    claudeBin,
    currentMcp,
    changedFiles: backup.manifest.files.map((entry) => ({ path: entry.path })),
    mcpChange: mcpChanged ? 'replace' : 'none',
    externalChanges: [],
  };
}

async function restore(options) {
  const backup = loadBackup(options);
  try {
    validateRestoreManifest(backup.manifest, backup.directory, options);
  } catch (error) {
    throw new Error(`Backup ${backup.id} failed restore preflight: ${error.message}`);
  }

  console.log(`restore plan from backup ${backup.id}:`);
  for (const entry of backup.manifest.files) {
    console.log(`  - ${entry.existed ? 'restore' : 'remove'}: ${entry.path}`);
  }
  if (backup.manifest.mcp?.changed) console.log('  - restore: user-scope Codex MCP via `claude mcp` CLI');
  console.log('  - create: pre-restore safety backup');
  console.log('  - statusline: the statusLine setting is restored with the other managed files');
  if (options.dryRun) {
    console.log('Dry-run complete; nothing restored.');
    return;
  }
  await confirmApply(options, `Restore backup ${backup.id}?`);

  const claudeBin = backup.manifest.mcp?.changed ? findClaude(options) : null;
  if (backup.manifest.mcp?.changed && !claudeBin) {
    throw new Error('Claude executable not found; this backup needs the Claude MCP CLI');
  }
  const rollbackContext = buildPreRestoreContext(backup, claudeBin, options);
  const safetyBackup = createBackup(options, rollbackContext, 'pre-restore');
  const mcpMutation = { removed: false, added: false };
  try {
    restoreMcp(
      backup.manifest,
      claudeBin,
      options,
      rollbackContext.currentMcp,
      false,
      mcpMutation,
    );
    restoreFiles(backup.manifest, backup.directory, options);
    const state = readState(options);
    const history = [...(state.history || []), safetyBackup.id].slice(-50);
    writeState(options, {
      history,
      lastBackupId: safetyBackup.id,
      lastRestoreAt: new Date().toISOString(),
      lastRestoredBackupId: backup.id,
    });
  } catch (error) {
    const expectedMcpCurrent = mcpMutation.added
      ? mcpPriorShape(backup.manifest)
      : (mcpMutation.removed ? parseMcpGet('') : rollbackContext.currentMcp);
    const rollbackFailures = rollbackFromBackup(
      safetyBackup,
      rollbackContext,
      options,
      expectedMcpCurrent,
      mcpMutation.removed,
    );
    const outcome = rollbackFailures.length === 0
      ? `restore rolled back from safety backup ${safetyBackup.id}`
      : `restore rollback incomplete for ${rollbackFailures.join(' and ')}; use safety backup ${safetyBackup.id}`;
    throw new Error(`${error.message}; ${outcome}`);
  }
  console.log(`Restore complete: ${backup.id}`);
  console.log(`Safety backup: ${safetyBackup.id}`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) throw new Error(`Node.js 18+ is required; found ${process.versions.node}`);

  if (options.action === 'check' || options.action === 'doctor') {
    const context = buildCheckContext(options);
    const coreHealthy = printCheck(context);
    // check covers what this core owns. doctor additionally walks dependencies,
    // the background service, endpoint reachability and pending logins.
    if (options.action !== 'doctor' || !options.provision) return coreHealthy ? 0 : 2;
    const provisionHealthy = await reportProvisioning(options, context);
    return coreHealthy && provisionHealthy ? 0 : 2;
  }
  if (options.action === 'setup') {
    await setup(options);
    return 0;
  }
  if (options.action === 'uninstall') {
    await uninstall(options);
    return 0;
  }
  await restore(options);
  return 0;
}

// doctor is check plus the provisioning view: dependencies, service, endpoint
// reachability and pending interactive logins. Everything is redacted.
async function reportProvisioning(options, context) {
  const state = await inspectProvisioning({
    home: options.home,
    platform: process.platform,
    claudeBin: context.claudeBin,
    explicitCodex: options.codex,
  });
  for (const line of provisioningReport(state)) console.log(line);

  const manual = pendingManualSteps(state);
  for (const step of manual) {
    console.log(`[action required] ${step.why}: run \`${step.command}\``);
  }
  return !provisioningReport(state).some((line) => line.startsWith('[needs-setup]'));
}

async function uninstall(options) {
  const context = buildCheckContext(options);
  const managed = context.files.map((file) => file.path);
  console.log('uninstall plan:');
  for (const file of managed) console.log(`  - remove managed content: ${file}`);
  console.log('  - remove: statusline runtime and statusLine setting');
  console.log('  - remove: cliproxyapi autostart service');
  console.log('  - keep: secrets, upstream credentials, cliproxyapi config, Codex MCP registration');

  if (options.dryRun) {
    console.log('Dry-run complete; nothing removed.');
    return;
  }
  await confirmApply(options, 'Remove the bootstrap-managed configuration?');

  // Restore is the reversible path; uninstall only removes what setup added and
  // deliberately leaves credentials and the MCP registration to the user.
  const state = await inspectProvisioning({ home: options.home, claudeBin: context.claudeBin });
  if (state.profile?.runsLocalProxy) {
    const removed = removeProvisionedService({
      home: options.home,
      viaBrew: state.cliproxy.viaBrew,
    });
    console.log(`service ${removed.action} via ${removed.backend}`);
  }

  const installDir = installDirFor(options.configDir);
  fs.rmSync(installDir, { recursive: true, force: true });
  console.log(`removed statusline runtime: ${installDir}`);
  console.log('Codex MCP was left registered; remove it with `claude mcp remove codex -s user` if desired.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  CODEX_MCP_ARGS,
  CODEX_BEGIN,
  CODEX_END,
  PATH_BEGIN,
  PATH_END,
  findLegacyClaudex,
  parseMcpGet,
  unstablePathReason,
  updateCodexManagedBlock,
  updateProfile,
  withPinnedManagedParent,
};
