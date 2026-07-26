// Provisioning layer: turns profile + dependency + service state into a plan,
// then applies it. Kept separate from bootstrap.mjs so the file-and-MCP core
// stays independent of anything that touches the network or installs software.
//
// Interactive logins are never automated. They are detected, reported, and the
// exact command is handed back for the user to run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultProfile,
  describeProfile,
  detectActiveEndpoint,
  detectLocalProxy,
  profilePath,
  readProfile,
  writeProfile,
} from './profile.mjs';
import {
  codexLoginStatus,
  detectCodex,
  installCodex,
  planCodex,
} from './deps/codex.mjs';
import {
  detectCliproxyapi,
  ensureConfig,
  installCliproxyapi,
  planCliproxyapi,
  secretPaths,
  upstreamLoginStatus,
} from './deps/cliproxyapi.mjs';
import { detectPlugins, installPlugins, planPlugins } from './deps/plugins.mjs';
import { installService, removeService, serviceStatus } from './service/index.mjs';

export async function inspectProvisioning({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  claudeBin,
  explicitCodex,
} = {}) {
  const file = profilePath(env, home);
  let profile = null;
  let profileError = null;
  try {
    profile = readProfile(file);
  } catch (error) {
    profileError = error.message;
  }

  const codex = detectCodex({ home, env, platform, explicit: explicitCodex });
  const cliproxy = detectCliproxyapi({ home, env, platform });
  const plugins = claudeBin ? detectPlugins(claudeBin, { env }) : { known: false, installed: [], missing: [] };
  // Before a profile exists the planner assumes this host runs a local proxy,
  // so the probe has to use the same assumption. Otherwise an already-running
  // service is reported as absent and setup proposes installing it again.
  const assumeLocalProxy = profile ? profile.runsLocalProxy : true;
  const service = assumeLocalProxy
    ? serviceStatus({ home, platform, viaBrew: cliproxy.viaBrew, env })
    : { backend: 'n/a', installed: false, running: false };

  const active = profile
    ? await detectActiveEndpoint(profile, { apiKeyFile: secretPaths(home).apiKeyFile })
    : { endpoint: null, attempts: [], reason: 'no-profile' };

  const { apiKeyFile, managementKeyFile } = secretPaths(home);
  return {
    profileFile: file,
    profile,
    profileError,
    codex,
    codexLogin: codexLoginStatus({ home, env }),
    cliproxy,
    cliproxyLogin: upstreamLoginStatus({ home, binary: cliproxy.binary }),
    plugins,
    service,
    active,
    secrets: {
      apiKey: fs.existsSync(apiKeyFile),
      managementKey: fs.existsSync(managementKeyFile),
    },
    description: profile ? describeProfile(profile, active.endpoint) : null,
  };
}

export function planProvisioning(state, { platform = process.platform, env = process.env } = {}) {
  const steps = [];
  if (!state.profile) {
    steps.push({ id: 'profile', action: 'create', detail: `write a default profile to ${state.profileFile}` });
  }

  const codexPlan = planCodex(state.codex, { platform, env });
  if (codexPlan.action !== 'none') {
    steps.push({ id: 'codex', ...codexPlan });
  }

  const runsLocal = state.profile ? state.profile.runsLocalProxy : true;
  if (runsLocal) {
    const proxyPlan = planCliproxyapi(state.cliproxy, { platform, env });
    if (proxyPlan.action !== 'none') steps.push({ id: 'cliproxyapi', ...proxyPlan });
    if (!state.cliproxy.configExists || !state.secrets.apiKey || !state.secrets.managementKey) {
      steps.push({
        id: 'cliproxy-config',
        action: 'create',
        detail: 'generate the cliproxyapi config and local keys (values never printed)',
      });
    }
    if (!state.service.installed) {
      steps.push({ id: 'service', action: 'install', detail: 'enable cliproxyapi autostart' });
    }
  }

  const pluginPlan = planPlugins(state.plugins);
  if (pluginPlan.action === 'install') steps.push({ id: 'plugins', ...pluginPlan });

  return steps;
}

// Interactive steps the user must perform. Reported separately so a caller can
// never mistake them for something the installer handled.
export function pendingManualSteps(state) {
  const manual = [];
  if (state.codex.ok && !state.codexLogin.loggedIn) {
    manual.push({ id: 'codex-login', command: state.codexLogin.command, why: 'Codex CLI is not signed in' });
  }
  const runsLocal = state.profile ? state.profile.runsLocalProxy : true;
  if (runsLocal && state.cliproxy.installed && !state.cliproxyLogin.hasCredentials) {
    manual.push({
      id: 'cliproxy-login',
      command: state.cliproxyLogin.commands.codex,
      why: 'cliproxyapi has no upstream credentials yet',
    });
  }
  return manual;
}

export async function applyProvisioning(state, steps, {
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  claudeBin,
  autostart = true,
  downloader,
  log = () => {},
} = {}) {
  const applied = [];
  const warnings = [];
  let profile = state.profile;

  for (const step of steps) {
    if (step.id === 'profile') {
      const detected = await detectLocalProxy({ apiKeyFile: secretPaths(home).apiKeyFile });
      profile = writeProfile(state.profileFile, { ...defaultProfile(), runsLocalProxy: detected || true });
      applied.push('profile');
      log(`profile written: ${state.profileFile}`);
    } else if (step.id === 'codex') {
      await installCodex({ home, env, platform, channel: step.channel, downloader });
      applied.push('codex');
      log('codex installed');
    } else if (step.id === 'cliproxyapi') {
      if (step.action === 'unsupported') {
        warnings.push(`cliproxyapi: ${step.detail}`);
        continue;
      }
      state.cliproxy = await installCliproxyapi({ home, env, platform, channel: step.channel });
      applied.push('cliproxyapi');
      log('cliproxyapi installed');
    } else if (step.id === 'cliproxy-config') {
      ensureConfig({
        home,
        platform,
        detection: state.cliproxy,
        servesOthers: profile?.servesOthers ?? false,
      });
      applied.push('cliproxy-config');
      log('cliproxyapi config and local keys generated (values not shown)');
    } else if (step.id === 'service') {
      if (!state.cliproxy.binary) {
        warnings.push('service: skipped because no cliproxyapi binary is installed');
        continue;
      }
      const result = installService({
        home,
        platform,
        binary: state.cliproxy.binary,
        configFile: state.cliproxy.configFile,
        viaBrew: state.cliproxy.viaBrew,
        env,
        autostart,
      });
      applied.push('service');
      log(`service ${result.action} via ${result.backend}`);
    } else if (step.id === 'plugins') {
      // A plugin failure degrades the status line but must not fail bootstrap.
      const results = installPlugins(claudeBin, step.missing, { env });
      const failed = results.filter((entry) => !entry.ok).map((entry) => entry.name);
      if (failed.length) warnings.push(`plugins not installed: ${failed.join(', ')}`);
      else applied.push('plugins');
    }
  }

  return { applied, warnings, profile };
}

export function removeProvisionedService(options) {
  return removeService(options);
}

export function provisioningReport(state) {
  const lines = [];
  const mark = (ok, label) => `${ok ? '[ok]' : '[needs-setup]'} ${label}`;

  lines.push(state.profile
    ? `[ok] profile: ${state.description.role} (${state.description.endpointCount} endpoint(s))`
    : `[needs-setup] profile: not created yet (${state.profileFile})`);
  if (state.profileError) lines.push(`[warning] profile: ${state.profileError}`);

  lines.push(state.codex.ok
    ? `[ok] codex: ${state.codex.binary}${state.codex.version ? ` (${state.codex.version})` : ''}`
    : '[needs-setup] codex: no stable binary with mcp-server support');
  lines.push(mark(state.codexLogin.loggedIn, `codex login: ${state.codexLogin.loggedIn ? 'signed in' : `run \`${state.codexLogin.command}\``}`));

  const runsLocal = state.profile ? state.profile.runsLocalProxy : true;
  if (runsLocal) {
    lines.push(state.cliproxy.installed
      ? `[ok] cliproxyapi: ${state.cliproxy.binary}`
      : '[needs-setup] cliproxyapi: not installed');
    lines.push(mark(state.cliproxy.configExists, `cliproxyapi config: ${state.cliproxy.configFile}`));
    lines.push(mark(
      state.cliproxyLogin.hasCredentials,
      state.cliproxyLogin.hasCredentials
        ? 'cliproxyapi upstream: credentials present'
        : `cliproxyapi upstream: run \`${state.cliproxyLogin.commands.codex}\``,
    ));
    lines.push(mark(state.service.running, `cliproxyapi service: ${state.service.backend}`));
  } else {
    lines.push('[ok] cliproxyapi: not required on this host (client role)');
  }

  // Secrets are reported by existence only; values are never read here.
  lines.push(mark(state.secrets.apiKey, 'proxy API key file present (value not read)'));
  lines.push(mark(state.secrets.managementKey, 'management key file present (value not read)'));

  if (state.active.endpoint) lines.push(`[ok] active endpoint: ${state.active.endpoint.label}`);
  else lines.push(`[needs-setup] active endpoint: ${state.active.reason}`);

  if (state.plugins.known) {
    lines.push(state.plugins.missing.length
      ? `[needs-setup] plugins missing: ${state.plugins.missing.join(', ')}`
      : '[ok] required plugins installed');
  }
  return lines;
}
