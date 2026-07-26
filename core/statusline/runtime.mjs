#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { discoverClaudeHud, getClaudeDir } from './discovery.mjs';
import {
  appendUsageToHud,
  contextDetail,
  isGptModel,
  renderStandalone,
  renderUsageSegments,
  rescaleStatusForModel,
} from './layout.mjs';
import { snapshotConfig } from './snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readStandardInput() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input.replace(/^﻿/, '')));
    process.stdin.on('error', reject);
  });
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function terminalColumns(env = process.env) {
  const configured = positiveInteger(env.COLUMNS, 0);
  if (configured >= 20) return configured;
  if (Number.isInteger(process.stdout.columns) && process.stdout.columns >= 20) {
    return process.stdout.columns;
  }
  if (Number.isInteger(process.stderr.columns) && process.stderr.columns >= 20) {
    return process.stderr.columns;
  }

  if (process.platform !== 'win32') {
    let terminal;
    try {
      terminal = fs.openSync('/dev/tty', 'r');
      const result = spawnSync('stty', ['size'], {
        encoding: 'utf8',
        stdio: [terminal, 'pipe', 'ignore'],
        timeout: 250,
      });
      const columns = positiveInteger(String(result.stdout || '').trim().split(/\s+/)[1], 0);
      if (columns >= 20) return columns;
    } catch {
      // A status line often has no controlling TTY; fall back without emitting errors.
    } finally {
      if (terminal !== undefined) {
        try {
          fs.closeSync(terminal);
        } catch {
          // Ignore cleanup failures.
        }
      }
    }
  }

  return 120;
}

function newestRefreshArtifact(dataDir) {
  const names = [
    '.refresh-attempt',
    'cliproxy-usage-openai.json',
    'cliproxy-usage-anthropic.json',
  ];
  let newest = 0;
  for (const name of names) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dataDir, name)).mtimeMs);
    } catch {
      // Missing artifacts make the refresh immediately eligible.
    }
  }
  return newest;
}

function refreshInBackground(env = process.env) {
  if (env.CLIPROXY_DISABLE_REFRESH === '1') return;
  const config = snapshotConfig(env);
  if (!config.bases.length) return;
  const intervalMs = positiveInteger(env.CLIPROXY_REFRESH_SECONDS, 55) * 1000;
  const newest = newestRefreshArtifact(config.dataDir);
  if (newest && Date.now() - newest < intervalMs) return;

  try {
    const child = spawn(process.execPath, [path.join(HERE, 'snapshot.mjs')], {
      detached: true,
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Usage refresh must never delay or break the status line.
  }
}

function loadSnapshot(dataDir, fileName, staleSeconds) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, fileName), 'utf8'));
    if (snapshot?.updated_at) {
      const ageMs = Date.now() - Date.parse(snapshot.updated_at);
      if (!Number.isFinite(ageMs) || ageMs > staleSeconds * 1000) return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function runClaudeHud(entry, status) {
  try {
    const result = spawnSync(process.execPath, [entry], {
      input: JSON.stringify(status),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: positiveInteger(process.env.CLIPROXY_HUD_TIMEOUT_MS, 2500),
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) return result.stdout;
  } catch {
    // Fall through to the standalone renderer.
  }
  return '';
}

export async function renderStatusLine(rawInput, env = process.env) {
  let status;
  try {
    status = JSON.parse(String(rawInput || '').replace(/^﻿/, ''));
  } catch {
    return '';
  }

  const gptWindow = positiveInteger(env.CLIPROXY_GPT_WINDOW, 372000);
  const effectiveStatus = rescaleStatusForModel(status, gptWindow);
  const config = snapshotConfig(env);
  const staleSeconds = positiveInteger(env.CLIPROXY_USAGE_STALE, 600);
  const gpt = isGptModel(status?.model?.id);
  const snapshot = loadSnapshot(
    config.dataDir,
    gpt ? 'cliproxy-usage-openai.json' : 'cliproxy-usage-anthropic.json',
    staleSeconds,
  );
  const columns = terminalColumns(env);
  const hud = discoverClaudeHud(getClaudeDir(env), env);

  if (hud) {
    const hudOutput = runClaudeHud(hud.entry, effectiveStatus);
    if (hudOutput) {
      return appendUsageToHud(
        hudOutput,
        renderUsageSegments(status, snapshot),
        contextDetail(status),
        columns,
      );
    }
  }

  return renderStandalone(effectiveStatus, snapshot, columns);
}

async function main() {
  const rawInput = await readStandardInput();
  refreshInBackground(process.env);
  const output = await renderStatusLine(rawInput, process.env);
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
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
  main().catch(() => {
    // Invalid input or an unavailable optional dependency should render nothing, not an error.
  });
}
