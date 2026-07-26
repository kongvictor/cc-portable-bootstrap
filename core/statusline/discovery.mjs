import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getClaudeDir(env = process.env, homeDir = os.homedir()) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return path.resolve(configured || path.join(homeDir, '.claude'));
}

export function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function directoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function candidateFrom(root, version, marketplace) {
  const entry = path.join(root, 'dist', 'index.js');
  if (!fs.existsSync(entry)) return null;

  let modified = 0;
  try {
    modified = fs.statSync(entry).mtimeMs;
  } catch {
    // A valid file with an unreadable mtime is still a usable candidate.
  }

  return { entry, root, version, marketplace, modified };
}

export function discoverClaudeHud(claudeDir = getClaudeDir(), env = process.env) {
  const override = env.CLAUDE_HUD_DIST?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (fs.existsSync(resolved)) {
      return {
        entry: resolved,
        root: path.dirname(path.dirname(resolved)),
        version: 'override',
        marketplace: 'override',
        modified: 0,
      };
    }
  }

  const cacheDir = path.join(claudeDir, 'plugins', 'cache');
  const candidates = [];

  for (const marketplace of directoryEntries(cacheDir)) {
    if (!marketplace.isDirectory() && !marketplace.isSymbolicLink()) continue;
    const pluginRoot = path.join(cacheDir, marketplace.name, 'claude-hud');

    const direct = candidateFrom(pluginRoot, '', marketplace.name);
    if (direct) candidates.push(direct);

    for (const version of directoryEntries(pluginRoot)) {
      if (!version.isDirectory() && !version.isSymbolicLink()) continue;
      const candidate = candidateFrom(
        path.join(pluginRoot, version.name),
        version.name,
        marketplace.name,
      );
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => {
    const versionOrder = naturalCompare(a.version, b.version);
    if (versionOrder !== 0) return versionOrder;
    if (a.modified !== b.modified) return a.modified - b.modified;
    return naturalCompare(a.entry, b.entry);
  });

  return candidates.at(-1) || null;
}
