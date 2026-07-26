// cliproxyapi installer.
//
// macOS uses Homebrew (an official formula exists). Linux and Windows download a
// release asset and verify its SHA256 — upstream's Linux path is a
// `curl | bash` one-liner, which we decline to wire into a one-command install.
//
// Config generation creates the API key and management key locally with a CSPRNG.
// Those values are written to the cliproxyapi config and to ~/.secrets/*, and are
// never printed, logged, returned, or transmitted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { commandExists, ensurePrivateDir, plan, run, userBinDir } from './common.mjs';
import { downloadVerified, fetchText, parseChecksumManifest } from './download.mjs';

export const RELEASE_API = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest';
export const DEFAULT_PORT = 8317;

export function assetNameFor(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) return null;
  return { os, cpu, suffix: platform === 'win32' ? '.exe' : '' };
}

export function configPathFor({ home, platform = process.platform, brewPrefix } = {}) {
  // Homebrew reads its own etc path; every other install reads the user config.
  if (platform === 'darwin' && brewPrefix) return path.join(brewPrefix, 'etc', 'cliproxyapi.conf');
  return path.join(home, '.cli-proxy-api', 'config.yaml');
}

export function binaryPathFor({ home, platform = process.platform } = {}) {
  return path.join(userBinDir(home), platform === 'win32' ? 'cliproxyapi.exe' : 'cliproxyapi');
}

export function brewPrefix(env = process.env) {
  const brew = commandExists('brew', env);
  if (!brew) return null;
  const result = run(brew, ['--prefix'], { env, timeoutMs: 20_000 });
  return result.ok ? result.stdout.trim() : null;
}

export function detectCliproxyapi({ home, env = process.env, platform = process.platform } = {}) {
  const prefix = platform === 'darwin' ? brewPrefix(env) : null;
  const managed = binaryPathFor({ home, platform });
  const onPath = commandExists('cliproxyapi', env);
  const brewBinary = prefix ? path.join(prefix, 'bin', 'cliproxyapi') : null;

  const binary = [onPath, brewBinary, managed].find((candidate) => candidate && fs.existsSync(candidate)) || null;
  const configFile = configPathFor({ home, platform, brewPrefix: prefix });
  return {
    installed: Boolean(binary),
    binary,
    brewPrefix: prefix,
    configFile,
    configExists: fs.existsSync(configFile),
    viaBrew: Boolean(brewBinary && binary === brewBinary),
  };
}

export function planCliproxyapi(detection, { platform = process.platform, env = process.env } = {}) {
  if (detection.installed) return plan('none', `cliproxyapi present: ${detection.binary}`);
  if (platform === 'darwin' && commandExists('brew', env)) {
    return plan('install', 'brew install cliproxyapi', { channel: 'brew' });
  }
  const asset = assetNameFor(platform);
  if (!asset) return plan('unsupported', `no release asset for ${platform}/${process.arch}`);
  return plan('install', 'download the verified release asset from GitHub', { channel: 'release' });
}

// Picks the asset for this platform and its published checksum. A release that
// ships no checksum manifest is refused rather than trusted.
export async function resolveRelease({ platform = process.platform, arch = process.arch, fetcher = fetchText } = {}) {
  const asset = assetNameFor(platform, arch);
  if (!asset) throw new Error(`Unsupported platform for release download: ${platform}/${arch}`);

  const release = JSON.parse(await fetcher(RELEASE_API));
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const match = assets.find((entry) => {
    const name = String(entry?.name || '').toLowerCase();
    return name.includes(asset.os) && name.includes(asset.cpu) && !name.endsWith('.sha256');
  });
  if (!match?.browser_download_url) {
    throw new Error(`No cliproxyapi release asset found for ${asset.os}/${asset.cpu}`);
  }

  const manifest = assets.find((entry) => /checksums?|sha256/i.test(String(entry?.name || '')));
  let expected = null;
  if (manifest?.browser_download_url) {
    expected = parseChecksumManifest(await fetcher(manifest.browser_download_url), match.name);
  }
  if (!expected) {
    throw new Error('Refusing to install: the release publishes no SHA256 for this asset');
  }
  return { name: match.name, url: match.browser_download_url, sha256: expected, tag: release?.tag_name ?? null };
}

export async function installCliproxyapi({
  home,
  env = process.env,
  platform = process.platform,
  channel,
  fetcher = fetchText,
  download = downloadVerified,
} = {}) {
  if (channel === 'brew') {
    const result = run('brew', ['install', 'cliproxyapi'], { env });
    if (!result.ok) throw new Error('brew install cliproxyapi failed');
    return detectCliproxyapi({ home, env, platform });
  }
  if (channel !== 'release') throw new Error(`Unknown cliproxyapi install channel: ${channel}`);

  const release = await resolveRelease({ platform, fetcher });
  const destination = binaryPathFor({ home, platform });
  ensurePrivateDir(path.dirname(destination));
  await download(release.url, destination, release.sha256, { mode: 0o700 });
  return detectCliproxyapi({ home, env, platform });
}

// URL-safe, high-entropy, and generated locally. Never echoed to the console.
function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function writeSecretFile(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${value}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function secretPaths(home) {
  return {
    apiKeyFile: path.join(home, '.secrets', 'cliproxy_apikey'),
    managementKeyFile: path.join(home, '.secrets', 'cliproxy_mgmtkey'),
  };
}

export function renderConfig({ apiKey, managementKey, port = DEFAULT_PORT, servesOthers = false, authDir }) {
  // Bind to loopback always. A hub is reached through an SSH tunnel, never by
  // listening on a LAN interface.
  return [
    '# Generated by cc-portable-bootstrap. Secrets are local to this machine.',
    'host: "127.0.0.1"',
    `port: ${port}`,
    `auth-dir: "${authDir}"`,
    'debug: false',
    'usage-statistics-enabled: true',
    `remote-management: ${servesOthers ? 'true' : 'false'}`,
    'api-keys:',
    `  - "${apiKey}"`,
    'management-key: ' + `"${managementKey}"`,
    '',
  ].join('\n');
}

// Generates config + secrets only when absent. An existing config is never
// rewritten: it may hold credentials shared with other machines.
export function ensureConfig({
  home,
  platform = process.platform,
  detection,
  servesOthers = false,
  port = DEFAULT_PORT,
  dryRun = false,
} = {}) {
  const configFile = detection?.configFile || configPathFor({ home, platform });
  const { apiKeyFile, managementKeyFile } = secretPaths(home);
  const missing = [];
  if (!fs.existsSync(configFile)) missing.push('config');
  if (!fs.existsSync(apiKeyFile)) missing.push('api key');
  if (!fs.existsSync(managementKeyFile)) missing.push('management key');

  if (!missing.length) return { created: false, configFile, missing: [] };
  if (dryRun) return { created: false, configFile, missing, wouldCreate: true };

  // Reuse an existing key so a partially provisioned machine converges instead
  // of silently rotating a credential other machines already use.
  const apiKey = fs.existsSync(apiKeyFile)
    ? fs.readFileSync(apiKeyFile, 'utf8').trim()
    : generateSecret();
  const managementKey = fs.existsSync(managementKeyFile)
    ? fs.readFileSync(managementKeyFile, 'utf8').trim()
    : generateSecret();

  if (!fs.existsSync(apiKeyFile)) writeSecretFile(apiKeyFile, apiKey);
  if (!fs.existsSync(managementKeyFile)) writeSecretFile(managementKeyFile, managementKey);

  if (!fs.existsSync(configFile)) {
    const authDir = path.join(home, '.cli-proxy-api');
    ensurePrivateDir(authDir);
    ensurePrivateDir(path.dirname(configFile));
    const contents = renderConfig({ apiKey, managementKey, port, servesOthers, authDir });
    const temporary = `${configFile}.tmp-${process.pid}-${Date.now()}`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, contents, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, configFile);
    if (process.platform !== 'win32') fs.chmodSync(configFile, 0o600);
  }

  return { created: true, configFile, missing };
}

// Upstream OAuth is interactive for every provider. Report what is missing and
// print the exact command; never attempt to drive the flow.
export function upstreamLoginStatus({ home, binary } = {}) {
  const authDir = path.join(home, '.cli-proxy-api');
  let files = [];
  try {
    files = fs.readdirSync(authDir).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }
  const executable = binary || 'cliproxyapi';
  return {
    hasCredentials: files.length > 0,
    commands: {
      codex: `${executable} -codex-device-login`,
      claude: `${executable} -claude-login`,
    },
  };
}
