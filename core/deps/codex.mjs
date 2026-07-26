// Codex CLI installer.
//
// Channel order matters. Homebrew cask is preferred on macOS because it yields a
// stable /opt/homebrew/bin entry point. npm is only a fallback: a machine can
// have node without a working npm (this bit us on a real host where npm had been
// renamed years earlier), so npm availability is verified rather than assumed.
// The official install script is the last resort and is never piped into a shell
// from a URL; it is downloaded, then executed from disk.
import fs from 'node:fs';
import path from 'node:path';

import { commandExists, ensurePrivateDir, plan, resolveBrew, run, unstableBinaryReason } from './common.mjs';

export const OFFICIAL_INSTALL_SH = 'https://chatgpt.com/codex/install.sh';
export const OFFICIAL_INSTALL_PS1 = 'https://chatgpt.com/codex/install.ps1';

export function knownCodexPaths(home, platform = process.platform) {
  return platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', 'codex.exe'),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe') : null,
      ].filter(Boolean)
    : [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(home, '.local', 'bin', 'codex'),
      ];
}

// `codex mcp-server --help` is the only proof that matters: the MCP transport is
// what this whole environment depends on, and older builds lack it.
export function verifyCodex(binary, { env = process.env } = {}) {
  if (!binary || !fs.existsSync(binary)) return { ok: false, reason: 'not-found' };
  const unstable = unstableBinaryReason(binary);
  if (unstable) return { ok: false, reason: unstable };

  const help = run(binary, ['mcp-server', '--help'], { env, timeoutMs: 20_000 });
  if (!help.ok) return { ok: false, reason: 'mcp-server unsupported' };
  if (!/mcp\s*server/i.test(`${help.stdout}\n${help.stderr}`)) {
    return { ok: false, reason: 'mcp-server help not recognized' };
  }
  const version = run(binary, ['--version'], { env, timeoutMs: 20_000 });
  return {
    ok: true,
    binary,
    version: version.ok ? version.stdout.trim() : null,
  };
}

export function detectCodex({
  home,
  env = process.env,
  platform = process.platform,
  explicit,
  knownPaths = knownCodexPaths(home, platform),
} = {}) {
  // Explicit first, then PATH, then well-known install locations. A rejected
  // candidate does not stop the search: a broken shim must not mask a good binary.
  const candidates = [explicit, commandExists('codex', env), ...knownPaths].filter(Boolean);
  const seen = new Set();
  const rejected = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const verified = verifyCodex(resolved, { env });
    if (verified.ok) return verified;
    if (fs.existsSync(resolved)) rejected.push({ binary: resolved, reason: verified.reason });
  }
  return { ok: false, reason: 'not-installed', rejected };
}

export function planCodex(detection, { platform = process.platform, env = process.env } = {}) {
  if (detection.ok) return plan('none', `Codex present: ${detection.binary}`);

  if (platform === 'darwin' && resolveBrew(env)) {
    return plan('install', 'brew install --cask codex', { channel: 'brew' });
  }
  // Verify npm actually runs; presence on PATH is not enough.
  const npm = commandExists('npm', env);
  if (npm && run(npm, ['--version'], { env, timeoutMs: 20_000 }).ok) {
    return plan('install', 'npm install -g @openai/codex', { channel: 'npm' });
  }
  return plan('install', 'download the official Codex installer and run it from disk', {
    channel: 'official-script',
  });
}

async function installViaOfficialScript({ home, platform, env, downloader }) {
  const scriptUrl = platform === 'win32' ? OFFICIAL_INSTALL_PS1 : OFFICIAL_INSTALL_SH;
  const stagingDir = ensurePrivateDir(path.join(home, '.cache', 'cc-portable-bootstrap'));
  const script = path.join(stagingDir, platform === 'win32' ? 'codex-install.ps1' : 'codex-install.sh');

  // Downloaded to disk first so the exact bytes that run can be inspected, and
  // so a truncated transfer cannot execute as a partial script.
  const body = await downloader(scriptUrl);
  fs.writeFileSync(script, body, { mode: 0o700 });

  const result = platform === 'win32'
    ? run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { env })
    : run('sh', [script], { env });
  try {
    fs.rmSync(script, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
  if (!result.ok) throw new Error('Official Codex installer failed');
}

export async function installCodex({
  home,
  env = process.env,
  platform = process.platform,
  channel,
  downloader,
} = {}) {
  if (channel === 'brew') {
    const result = run(resolveBrew(env), ['install', '--cask', 'codex'], { env });
    if (!result.ok) throw new Error('brew install --cask codex failed');
  } else if (channel === 'npm') {
    const result = run('npm', ['install', '-g', '@openai/codex'], { env });
    if (!result.ok) throw new Error('npm install -g @openai/codex failed');
  } else if (channel === 'official-script') {
    if (!downloader) throw new Error('The official installer channel requires a downloader');
    await installViaOfficialScript({ home, platform, env, downloader });
  } else {
    throw new Error(`Unknown Codex install channel: ${channel}`);
  }

  const detection = detectCodex({ home, env, platform });
  if (!detection.ok) throw new Error('Codex installed but no stable mcp-server binary was found');
  return detection;
}

// Login is interactive by design (browser/device-code OAuth). We report status
// and hand the user the command; we never attempt to automate or store it.
export function codexLoginStatus({ home, env = process.env } = {}) {
  const authFile = path.join(env.CODEX_HOME?.trim() || path.join(home, '.codex'), 'auth.json');
  return { loggedIn: fs.existsSync(authFile), command: 'codex login' };
}
