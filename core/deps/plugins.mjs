// Claude Code plugin dependencies (claude-hud powers the status line's bar).
//
// A missing plugin degrades the status line but must never fail the whole
// bootstrap, so every failure here is reported as a warning, not an error.
import { plan, run } from './common.mjs';

export const MARKETPLACE = 'kongvictor/cc-portable-bootstrap';

// claude-hud, caveman and dmd are bundled in this repository's marketplace, so a
// plain name resolves. context7 lives in the official marketplace and is
// installed by its qualified id.
export const REQUIRED_PLUGINS = Object.freeze([
  'claude-hud',
  'caveman',
  'dmd',
  'context7@claude-plugins-official',
]);

// `claude plugin list` prints the bare plugin name, not the qualified id.
function pluginName(id) {
  return String(id).split('@')[0];
}

export function detectPlugins(claudeBin, { env = process.env } = {}) {
  const result = run(claudeBin, ['plugin', 'list'], { env, timeoutMs: 30_000 });
  if (!result.ok) return { known: false, installed: [], missing: [...REQUIRED_PLUGINS] };

  const text = `${result.stdout}\n${result.stderr}`;
  const installed = REQUIRED_PLUGINS.filter((id) => new RegExp(`\\b${pluginName(id)}\\b`).test(text));
  return {
    known: true,
    installed,
    missing: REQUIRED_PLUGINS.filter((id) => !installed.includes(id)),
  };
}

export function planPlugins(detection) {
  if (!detection.known) return plan('unknown', 'could not read the installed plugin list');
  if (!detection.missing.length) return plan('none', 'required plugins are installed');
  return plan('install', `install ${detection.missing.join(', ')}`, { missing: detection.missing });
}

export function installPlugins(claudeBin, missing, { env = process.env } = {}) {
  const results = [];
  // Adding the marketplace is idempotent and may legitimately fail if it is
  // already registered, so its outcome does not gate the installs.
  run(claudeBin, ['plugin', 'marketplace', 'add', MARKETPLACE], { env, timeoutMs: 60_000 });

  for (const name of missing) {
    const result = run(claudeBin, ['plugin', 'install', name], { env, timeoutMs: 120_000 });
    results.push({ name, ok: result.ok });
  }
  return results;
}
