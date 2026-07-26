// Release downloads with mandatory checksum verification.
//
// The upstream Linux installer is a `curl ... | bash` one-liner. We deliberately
// do not pipe a remote script into a shell: a release asset plus a published
// SHA256 is auditable and pinnable, a mutable remote script is not.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const DOWNLOAD_TIMEOUT_MS = 120_000;

export function assertHttps(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('Download URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('Refusing to download over plaintext HTTP');
  if (parsed.username || parsed.password) throw new Error('Refusing a download URL carrying credentials');
  return parsed.href;
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function verifyChecksum(file, expected) {
  const normalized = String(expected || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Expected a 64-character hex SHA256 checksum');
  }
  const actual = sha256File(file);
  if (actual !== normalized) {
    throw new Error(`Checksum mismatch: expected ${normalized}, got ${actual}`);
  }
  return actual;
}

// Parses the `sha256sum`-style manifest published alongside most releases.
export function parseChecksumManifest(text, assetName) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    if (path.basename(match[2].trim()) === assetName) return match[1].toLowerCase();
  }
  return null;
}

export async function fetchText(url, timeoutMs = 30_000) {
  const target = assertHttps(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${target}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// Downloads to a temporary file, verifies, and only then moves into place, so a
// failed or tampered download can never leave a runnable binary behind.
export async function downloadVerified(url, destination, expectedSha256, {
  mode = 0o700,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const target = assertHttps(url);
  if (!expectedSha256) throw new Error('Refusing to install a download without an expected checksum');

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.download-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading asset`);
    if (!response.body) throw new Error('Download produced no body');
    await pipeline(response.body, fs.createWriteStream(temporary, { mode }));

    verifyChecksum(temporary, expectedSha256);
    if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
