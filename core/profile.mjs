// Machine profile: which proxy endpoints this host may use, and what role it
// plays. Everything here is machine-specific topology, so the profile lives in
// the user's config directory and is never committed. The repository ships only
// templates/profile.example.json with placeholders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeCredentialedBase, probeEndpoint } from './statusline/net.mjs';

export const PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8317';

export function profilePath(env = process.env, homeDir = os.homedir()) {
  const override = env.CC_BOOTSTRAP_PROFILE_FILE?.trim();
  if (override) return path.resolve(override);
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const base = configHome ? path.resolve(configHome) : path.join(homeDir, '.config');
  return path.join(base, 'cc-portable-bootstrap', 'profile.json');
}

export function defaultProfile() {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    // Does this host run its own cliproxyapi instance? True for a hub, for an
    // off-network laptop that cannot reach one, and for a local fallback.
    runsLocalProxy: true,
    // Does this host serve other machines? Only the hub sets this. It controls
    // whether remote management and inbound tunnel access are expected.
    servesOthers: false,
    endpoints: [{ label: 'local', url: DEFAULT_LOCAL_URL, priority: 100 }],
    activeEndpoint: null,
  };
}

function invalid(message) {
  throw new Error(`Invalid profile: ${message}`);
}

function validateLabel(label) {
  if (typeof label !== 'string' || !label.trim()) invalid('endpoint label must be a non-empty string');
  if (label.length > 60 || /[\r\n]/.test(label)) invalid('endpoint label is too long or contains newlines');
  return label.trim();
}

function validateTunnel(tunnel) {
  if (tunnel === undefined || tunnel === null) return null;
  if (typeof tunnel !== 'object' || Array.isArray(tunnel)) invalid('tunnel must be an object');
  const host = tunnel.host;
  if (typeof host !== 'string' || !host.trim()) invalid('tunnel.host must be a non-empty string');
  if (/[\s;&|`$()<>]/.test(host)) invalid('tunnel.host contains shell metacharacters');
  const localPort = Number(tunnel.localPort);
  const remotePort = Number(tunnel.remotePort ?? 8317);
  for (const [name, port] of [['localPort', localPort], ['remotePort', remotePort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) invalid(`tunnel.${name} must be a valid port`);
  }
  return { host: host.trim(), localPort, remotePort };
}

export function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected a JSON object');
  if (value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    invalid(`unsupported schemaVersion ${value.schemaVersion}`);
  }
  if (typeof value.runsLocalProxy !== 'boolean') invalid('runsLocalProxy must be a boolean');
  if (typeof value.servesOthers !== 'boolean') invalid('servesOthers must be a boolean');
  if (!Array.isArray(value.endpoints)) invalid('endpoints must be an array');

  const seen = new Set();
  const endpoints = value.endpoints.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('each endpoint must be an object');
    const label = validateLabel(entry.label);
    const url = normalizeCredentialedBase(entry.url);
    if (!url) {
      invalid(`endpoint "${label}" must be HTTPS, or HTTP with a strict loopback host`);
    }
    if (seen.has(url)) invalid(`duplicate endpoint URL for "${label}"`);
    seen.add(url);
    const priority = entry.priority === undefined ? 100 : Number(entry.priority);
    if (!Number.isFinite(priority)) invalid(`endpoint "${label}" has a non-numeric priority`);
    const tunnel = validateTunnel(entry.tunnel);
    return tunnel ? { label, url, priority, tunnel } : { label, url, priority };
  });

  if (value.activeEndpoint !== null && value.activeEndpoint !== undefined) {
    const active = normalizeCredentialedBase(value.activeEndpoint);
    if (!active) invalid('activeEndpoint is not a usable URL');
    if (!seen.has(active)) invalid('activeEndpoint is not one of the configured endpoints');
  }

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    runsLocalProxy: value.runsLocalProxy,
    servesOthers: value.servesOthers,
    endpoints,
    activeEndpoint: value.activeEndpoint ? normalizeCredentialedBase(value.activeEndpoint) : null,
  };
}

export function readProfile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Invalid profile: ${file} is not valid JSON`);
  }
  return validateProfile(parsed);
}

export function writeProfile(file, profile) {
  const validated = validateProfile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
  return validated;
}

export function orderedEndpoints(profile) {
  return [...profile.endpoints].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.label.localeCompare(b.label);
  });
}

function readApiKey(file) {
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

// Capability probing, not identity detection: the winner is simply the highest
// priority endpoint that answers with HTTP 2xx. Nothing here knows or records
// what any particular endpoint "is".
export async function detectActiveEndpoint(profile, {
  apiKeyFile = path.join(os.homedir(), '.secrets', 'cliproxy_apikey'),
  timeoutMs = 3000,
  probe = probeEndpoint,
} = {}) {
  const apiKey = readApiKey(apiKeyFile);
  const attempts = [];
  if (!apiKey) return { endpoint: null, attempts, reason: 'missing-api-key' };

  for (const endpoint of orderedEndpoints(profile)) {
    const healthy = await probe(endpoint.url, apiKey, timeoutMs);
    attempts.push({ label: endpoint.label, healthy });
    if (healthy) return { endpoint, attempts, reason: 'healthy' };
  }
  return { endpoint: null, attempts, reason: 'no-healthy-endpoint' };
}

// A host is treated as running its own proxy when a local endpoint answers.
// Used to pick sensible defaults during the first-run wizard, never to override
// an explicit profile setting.
export async function detectLocalProxy(options = {}) {
  const localOnly = {
    ...defaultProfile(),
    endpoints: [{ label: 'local', url: DEFAULT_LOCAL_URL, priority: 0 }],
  };
  const result = await detectActiveEndpoint(localOnly, options);
  return result.reason === 'healthy';
}

export function describeProfile(profile, active) {
  const role = profile.servesOthers
    ? 'hub (serves other machines)'
    : (profile.runsLocalProxy ? 'standalone (local proxy only)' : 'client (remote proxy only)');
  return {
    role,
    endpointCount: profile.endpoints.length,
    activeLabel: active?.label ?? null,
  };
}
