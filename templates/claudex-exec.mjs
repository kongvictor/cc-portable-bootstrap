#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const FAST_POLICY = `This session was launched through claudex with inherited downstream Fast delegation enabled. For generic or otherwise tier-unspecified Codex MCP delegation, include config.service_tier="fast" on the initial mcp__codex__codex call. An explicit non-Fast Codex<Model><Effort> trigger overrides this default and must omit service_tier; an explicit Fast trigger must include it. Bare nested claudex delegation inherits this session default, explicit non-Fast claudex<Model><Effort> triggers must use --standard, and explicit Fast triggers must use --fast. Do not introduce new Fast-selection rules for Claude Code built-in Agent subagents.`;

function fail(message) {
  process.stderr.write(`claudex: ${message}\n`);
  process.exit(1);
}

function parseExtraBody(existing = process.env.CLAUDE_CODE_EXTRA_BODY) {
  if (existing === undefined || existing === null || String(existing).trim() === '') return {};
  let body;
  try {
    body = JSON.parse(existing);
  } catch {
    throw new TypeError('CLAUDE_CODE_EXTRA_BODY is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('CLAUDE_CODE_EXTRA_BODY is not a JSON object');
  }
  return body;
}

export function hasFastExtraBody(existing = process.env.CLAUDE_CODE_EXTRA_BODY) {
  try {
    const body = parseExtraBody(existing);
    return Object.hasOwn(body, 'speed') && body.speed === 'fast';
  } catch {
    return false;
  }
}

export function updateExtraBody(existing, tier) {
  if (tier !== 'fast' && tier !== 'standard') throw new TypeError('invalid extra-body action');
  const body = parseExtraBody(existing);
  if (tier === 'fast') body.speed = 'fast';
  else delete body.speed;
  return Object.keys(body).length === 0 ? null : JSON.stringify(body);
}

export function mergeFastPolicy(args, failWith = fail, separator = '\n\n') {
  const prompts = [];
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      forwarded.push(...args.slice(index));
      break;
    }
    if (argument === '--append-system-prompt') {
      if (index + 1 >= args.length) failWith('--append-system-prompt requires a value');
      prompts.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith('--append-system-prompt=')) {
      prompts.push(argument.slice('--append-system-prompt='.length));
      continue;
    }
    forwarded.push(argument);
  }
  return ['--append-system-prompt', [...prompts, FAST_POLICY].join(separator), ...forwarded];
}

function relayChild(child, description) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try { child.kill(signal); } catch {}
    });
  }

  child.on('error', (error) => fail(`unable to launch ${description}: ${error.message}`));
  child.on('exit', (code, signal) => {
    if (Number.isInteger(code)) process.exit(code);
    const signalNumber = signal ? os.constants.signals[signal] : undefined;
    process.exit(Number.isInteger(signalNumber) ? 128 + signalNumber : 1);
  });
}

function launchPowerShell() {
  const [powerShellBin, launcherPath, ...forwarded] = process.argv.slice(3);
  if (!powerShellBin || !launcherPath) fail('internal PowerShell launcher arguments are missing');

  const payload = Buffer.from(JSON.stringify({ version: 1, args: forwarded }), 'utf8').toString('base64');
  const child = spawn(
    powerShellBin,
    [
      '-NoLogo',
      '-NoProfile',
      '-File', launcherPath,
      '-ForwardArgsBase64', payload,
    ],
    { env: process.env, stdio: 'inherit', windowsHide: true },
  );
  relayChild(child, 'PowerShell');
}

function childEnvironment() {
  const env = { ...process.env };
  const action = env.CLAUDEX_EXTRA_BODY_ACTION;
  delete env.CLAUDEX_EXTRA_BODY_ACTION;
  if (action) {
    let updated;
    try {
      updated = updateExtraBody(env.CLAUDE_CODE_EXTRA_BODY, action);
    } catch {
      fail('CLAUDE_CODE_EXTRA_BODY must be a JSON object when changing delegation tier');
    }
    if (updated === null) delete env.CLAUDE_CODE_EXTRA_BODY;
    else env.CLAUDE_CODE_EXTRA_BODY = updated;
  }
  return env;
}

function launch() {
  const [claudeBin, mainModel, ...nativeArgs] = process.argv.slice(2);
  if (!claudeBin || !mainModel) fail('internal launcher arguments are missing');

  const fast = process.env.CLAUDEX_DELEGATION_TIER === 'fast';
  const commandShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(claudeBin);
  const forwarded = fast
    ? mergeFastPolicy(nativeArgs, fail, commandShim ? ' | ' : '\n\n')
    : nativeArgs;
  const claudeArgs = ['--permission-mode', 'auto', '--model', mainModel, ...forwarded];
  const env = childEnvironment();
  let child;
  if (commandShim) {
    const quoteForCmd = (value) => `"${String(value).replaceAll('"', '""')}"`
      .replaceAll('%', '"^%"');
    const commandLine = [claudeBin, ...claudeArgs].map(quoteForCmd).join(' ');
    child = spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
      {
        env,
        stdio: 'inherit',
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    );
  } else {
    child = spawn(
      claudeBin,
      claudeArgs,
      { env, stdio: 'inherit', windowsHide: true },
    );
  }
  relayChild(child, 'Claude');
}

function validateExtraBodyUpdate() {
  try {
    updateExtraBody(process.env.CLAUDE_CODE_EXTRA_BODY, process.argv[3]);
    process.exit(0);
  } catch {
    process.exit(2);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === '--powershell-launcher') launchPowerShell();
  else if (process.argv[2] === '--has-fast-extra-body') process.exit(hasFastExtraBody() ? 0 : 1);
  else if (process.argv[2] === '--validate-extra-body-update') validateExtraBodyUpdate();
  else launch();
}
