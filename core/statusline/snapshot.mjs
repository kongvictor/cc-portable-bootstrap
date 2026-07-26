import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCredentialedBase as normalizeManagementBase } from './net.mjs';

export { normalizeManagementBase };

const LOCK_MAX_AGE_MS = 120_000;

function configuredPath(value, fallback) {
  const selected = value?.trim() || fallback;
  if (selected === '~') return os.homedir();
  if (selected.startsWith('~/') || selected.startsWith('~\\')) {
    return path.join(os.homedir(), selected.slice(2));
  }
  return path.resolve(selected);
}

// Mirrors core/profile.mjs profilePath(). The status-line runtime is installed
// as a standalone copy without that module, so the lookup is duplicated rather
// than imported; both must stay in sync.
function profilePath(env) {
  const override = env.CC_BOOTSTRAP_PROFILE_FILE?.trim();
  if (override) return path.resolve(override);
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const base = configHome ? path.resolve(configHome) : path.join(os.homedir(), '.config');
  return path.join(base, 'cc-portable-bootstrap', 'profile.json');
}

// Claude Code spawns the status line from the user's shell, which normally has
// no CLIPROXY_URL, so the machine profile is the only place these endpoints are
// recorded. Without this fallback the refresh returns immediately every time and
// the usage segments silently freeze at whatever was last written to the cache.
function profileEndpoints(env) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(profilePath(env), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.endpoints)) return [];
  const byPriority = [...parsed.endpoints].sort(
    (left, right) => Number(right?.priority || 0) - Number(left?.priority || 0),
  );
  const active = byPriority.filter((entry) => entry?.label === parsed.activeEndpoint);
  return [...active, ...byPriority].map((entry) => entry?.url).filter(Boolean);
}

export function snapshotConfig(env = process.env) {
  const configuredBase = env.CLIPROXY_URL?.trim();
  const candidates = configuredBase ? [configuredBase] : profileEndpoints(env);
  return {
    dataDir: configuredPath(env.CLIPROXY_USAGE_DIR, '~/.cache/cliproxy-usage'),
    managementKeyFile: configuredPath(
      env.CLIPROXY_MGMTKEY_FILE,
      '~/.secrets/cliproxy_mgmtkey',
    ),
    // An explicit URL is authoritative: never send the key to fallback ports after it fails.
    bases: [...new Set(candidates.map(normalizeManagementBase).filter(Boolean))],
  };
}

async function fetchJson(url, headers = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function managementUrl(base, endpoint) {
  return `${base.replace(/\/+$/, '')}/v0/management/${endpoint}`;
}

async function getManagement(base, managementKey, endpoint) {
  return fetchJson(
    managementUrl(base, endpoint),
    { 'X-Management-Key': managementKey },
    6000,
  );
}

async function pickBase(bases, managementKey) {
  for (const base of bases) {
    try {
      await getManagement(base, managementKey, 'usage-statistics-enabled');
      return base;
    } catch {
      // Try the next configured local endpoint without exposing credentials or responses.
    }
  }
  return null;
}

async function providerCredential(base, managementKey, files, provider) {
  const authFile = files.find((item) => item?.provider === provider);
  if (!authFile) return { token: null, accountId: null };

  const name = authFile.name || authFile.id;
  if (!name) return { token: null, accountId: null };
  const downloaded = await getManagement(
    base,
    managementKey,
    `auth-files/download?name=${encodeURIComponent(name)}`,
  );
  const idToken = downloaded?.id_token;
  const accountId =
    downloaded?.account_id ||
    (idToken && typeof idToken === 'object' ? idToken.chatgpt_account_id : null);
  return { token: downloaded?.access_token || null, accountId: accountId || null };
}

function resetIso(epochSeconds) {
  const value = Number(epochSeconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

export function buildOpenAiSnapshot(payload, now = new Date()) {
  const rateLimit = payload?.rate_limit || {};
  const snapshot = { updated_at: now.toISOString() };

  for (const window of [rateLimit.primary_window, rateLimit.secondary_window]) {
    if (!window) continue;
    const duration = Number(window.limit_window_seconds) || 0;
    const key = duration <= 6 * 3600 ? 'five_hour' : 'seven_day';
    snapshot[key] = {
      used_percentage: window.used_percent,
      resets_at: resetIso(window.reset_at),
    };
  }

  snapshot.balance_label = payload?.plan_type ? `gpt ${payload.plan_type}` : 'gpt';
  return snapshot;
}

export function buildAnthropicSnapshot(payload, now = new Date()) {
  const snapshot = { updated_at: now.toISOString() };
  const fiveHour = payload?.five_hour || {};
  const sevenDay = payload?.seven_day || {};

  if (fiveHour.utilization !== null && fiveHour.utilization !== undefined) {
    snapshot.five_hour = {
      used_percentage: fiveHour.utilization,
      resets_at: fiveHour.resets_at || null,
    };
  }
  if (sevenDay.utilization !== null && sevenDay.utilization !== undefined) {
    snapshot.seven_day = {
      used_percentage: sevenDay.utilization,
      resets_at: sevenDay.resets_at || null,
    };
  }

  const labels = [];
  snapshot.scoped = [];
  for (const limit of payload?.limits || []) {
    const modelName = limit?.scope?.model?.display_name;
    if (limit?.kind !== 'weekly_scoped' || !modelName) continue;
    snapshot.scoped.push({ name: modelName, pct: limit.percent });
    labels.push(`${modelName}:${limit.percent}%`);
  }
  snapshot.balance_label = `claude ${labels.join(' ')}`.trim().slice(0, 50);
  return snapshot;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, filePath);
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function touchAttempt(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const marker = path.join(dataDir, '.refresh-attempt');
  const now = new Date();
  try {
    fs.closeSync(fs.openSync(marker, 'a', 0o600));
    fs.utimesSync(marker, now, now);
  } catch {
    // The marker only throttles retries; snapshot collection can continue without it.
  }
}

function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, '.snapshot.lock');

  try {
    return { path: lockPath, handle: fs.openSync(lockPath, 'wx', 0o600) };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age <= LOCK_MAX_AGE_MS) return null;
    fs.unlinkSync(lockPath);
    return { path: lockPath, handle: fs.openSync(lockPath, 'wx', 0o600) };
  } catch {
    return null;
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.handle);
  } catch {
    // Ignore cleanup failures.
  }
  try {
    fs.unlinkSync(lock.path);
  } catch {
    // Ignore cleanup failures.
  }
}

async function updateOpenAi(base, managementKey, files, dataDir) {
  const { token, accountId } = await providerCredential(
    base,
    managementKey,
    files,
    'codex',
  );
  if (!token) return;

  const headers = { Authorization: `Bearer ${token}` };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  const usage = await fetchJson(
    'https://chatgpt.com/backend-api/wham/usage',
    headers,
  );
  atomicWriteJson(
    path.join(dataDir, 'cliproxy-usage-openai.json'),
    buildOpenAiSnapshot(usage),
  );
}

async function updateAnthropic(base, managementKey, files, dataDir) {
  const { token } = await providerCredential(base, managementKey, files, 'claude');
  if (!token) return;

  const usage = await fetchJson(
    'https://api.anthropic.com/api/oauth/usage',
    {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  );
  atomicWriteJson(
    path.join(dataDir, 'cliproxy-usage-anthropic.json'),
    buildAnthropicSnapshot(usage),
  );
}

export async function refreshSnapshots(env = process.env) {
  const config = snapshotConfig(env);
  if (!config.bases.length) return;
  const lock = acquireLock(config.dataDir);
  if (!lock) return;

  try {
    touchAttempt(config.dataDir);
    let managementKey;
    try {
      managementKey = fs.readFileSync(config.managementKeyFile, 'utf8').trim();
    } catch {
      return;
    }
    if (!managementKey) return;

    const base = await pickBase(config.bases, managementKey);
    if (!base) return;
    const response = await getManagement(base, managementKey, 'auth-files');
    const files = Array.isArray(response?.files) ? response.files : [];

    for (const update of [updateOpenAi, updateAnthropic]) {
      try {
        await update(base, managementKey, files, config.dataDir);
      } catch {
        // Keep the other provider usable when one account or endpoint fails.
      }
    }
  } finally {
    releaseLock(lock);
  }
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
  refreshSnapshots().catch(() => {
    // Status-line refresh is deliberately silent and non-blocking.
  });
}
