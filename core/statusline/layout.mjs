const RESET = '[0m';
const DIM = '[2m';
const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[1;31m';
const ANSI_PATTERN = /(?:\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\))/g;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rounded(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(finiteNumber(value) * factor) / factor;
}

export function isGptModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return id.startsWith('gpt-') || id.includes('codex') || /^o\d+(?:-|$)/.test(id);
}

export function colorFor(percentage) {
  const value = finiteNumber(percentage);
  if (value >= 88) return RED;
  if (value >= 75) return YELLOW;
  return GREEN;
}

export function formatTokens(value) {
  const number = Math.trunc(finiteNumber(value));
  return number >= 1000 ? `${Math.round(number / 1000)}k` : String(number);
}

export function contextDetail(status) {
  const usage = status?.context_window?.current_usage || {};
  const input = formatTokens(usage.input_tokens);
  const cache = formatTokens(
    finiteNumber(usage.cache_creation_input_tokens) +
      finiteNumber(usage.cache_read_input_tokens),
  );
  return `${DIM}(in:${input}, cache:${cache})${RESET}`;
}

export function rescaleStatusForModel(status, gptWindow = 372000) {
  const copy = JSON.parse(JSON.stringify(status || {}));
  const modelId = copy?.model?.id;
  if (!isGptModel(modelId)) return copy;

  const context = copy.context_window || {};
  const advertisedSize = finiteNumber(context.context_window_size);
  const realSize = Math.max(1, Math.trunc(finiteNumber(gptWindow, 372000)));
  if (advertisedSize > 0) {
    const estimatedTokens = (finiteNumber(context.used_percentage) / 100) * advertisedSize;
    context.used_percentage = rounded((estimatedTokens / realSize) * 100, 1);
    context.context_window_size = realSize;
    copy.context_window = context;
  }
  return copy;
}

function progressBar(percentage, width = 10) {
  const value = finiteNumber(percentage);
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return `${colorFor(value)}${'='.repeat(filled)}${DIM}${'·'.repeat(width - filled)}${RESET}`;
}

export function resetCountdown(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return '';

  let targetMs;
  if (typeof value === 'number') {
    targetMs = value * 1000;
  } else {
    targetMs = Date.parse(String(value));
  }
  if (!Number.isFinite(targetMs)) return '';

  const seconds = Math.floor((targetMs - nowMs) / 1000);
  if (seconds <= 0) return 'now';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function usageWindow(window, nowMs) {
  if (!window || window.used_percentage === null || window.used_percentage === undefined) {
    return null;
  }
  return {
    percentage: Math.round(finiteNumber(window.used_percentage)),
    reset: resetCountdown(window.resets_at, nowMs),
  };
}

function formatUsageWindow(label, value) {
  const reset = value.reset ? ` ${DIM}(resets in ${value.reset})${RESET}` : '';
  return `${DIM}${label}:${RESET} ${colorFor(value.percentage)}${value.percentage}%${RESET}${reset}`;
}

export function renderUsageSegments(status, snapshot, nowMs = Date.now()) {
  const modelId = status?.model?.id;
  const gpt = isGptModel(modelId);
  const rateLimits = status?.rate_limits || {};
  const segments = [];

  if (!gpt) {
    const fiveHour =
      usageWindow(snapshot?.five_hour, nowMs) || usageWindow(rateLimits.five_hour, nowMs);
    if (fiveHour) segments.push(formatUsageWindow('5h', fiveHour));
  }

  const weekly =
    usageWindow(snapshot?.seven_day, nowMs) || usageWindow(rateLimits.seven_day, nowMs);
  if (weekly) segments.push(formatUsageWindow('Weekly', weekly));

  if (!gpt) {
    for (const scoped of snapshot?.scoped || []) {
      if (scoped?.name === null || scoped?.name === undefined) continue;
      if (scoped?.pct === null || scoped?.pct === undefined) continue;
      const percentage = Math.round(finiteNumber(scoped.pct));
      segments.push(
        `${DIM}${String(scoped.name)}:${RESET} ${colorFor(percentage)}${percentage}%${RESET}`,
      );
    }
  }

  return segments;
}

export function stripAnsi(value) {
  return String(value || '').replace(ANSI_PATTERN, '');
}

function isCombining(codePoint) {
  return /\p{Mark}/u.test(String.fromCodePoint(codePoint));
}

function isFullWidth(codePoint) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

export function visibleWidth(value) {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (isCombining(codePoint)) continue;
    width += isFullWidth(codePoint) ? 2 : 1;
  }
  return width;
}

function packIndentedLines(segments, columns) {
  const separator = ` ${DIM}|${RESET} `;
  const separatorWidth = 3;
  const lines = [];
  let current = [];
  let currentWidth = 2;

  for (const segment of segments) {
    const addition = (current.length ? separatorWidth : 0) + visibleWidth(segment);
    if (current.length && currentWidth + addition > columns) {
      lines.push(`  ${current.join(separator)}`);
      current = [segment];
      currentWidth = 2 + visibleWidth(segment);
    } else {
      current.push(segment);
      currentWidth += addition;
    }
  }

  if (current.length) lines.push(`  ${current.join(separator)}`);
  return lines;
}

function normalizedColumns(columns) {
  const number = Math.trunc(finiteNumber(columns, 120));
  return number >= 20 ? number : 120;
}

export function appendUsageToHud(hudOutput, segments, detail, columns = 120) {
  const lines = String(hudOutput || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();

  const width = normalizedColumns(columns);
  const separator = ` ${DIM}|${RESET} `;
  const inlineSeparator = `  ${DIM}│${RESET}  `;
  const contextIndex = lines.findIndex(
    (line) =>
      line.includes('█') ||
      line.includes('░') ||
      /\b(?:Context|Ctx)\b.*\d+(?:\.\d+)?%/.test(stripAnsi(line)),
  );

  if (contextIndex >= 0 && detail) lines[contextIndex] += ` ${detail}`;
  if (!segments.length) return lines.join('\n');

  const segmentsWidth =
    segments.reduce((total, segment) => total + visibleWidth(segment), 0) +
    Math.max(0, segments.length - 1) * 3;

  if (
    contextIndex >= 0 &&
    visibleWidth(lines[contextIndex]) + 5 + segmentsWidth <= width
  ) {
    lines[contextIndex] += inlineSeparator + segments.join(separator);
    return lines.join('\n');
  }

  const wrapped = packIndentedLines(segments, width);
  if (contextIndex >= 0) {
    lines.splice(contextIndex + 1, 0, ...wrapped);
  } else {
    lines.push(...wrapped);
  }
  return lines.join('\n');
}

export function renderStandalone(status, snapshot, columns = 120, nowMs = Date.now()) {
  const context = status?.context_window || {};
  const percentage = Math.round(finiteNumber(context.used_percentage));
  const contextLine = `Ctx ${progressBar(percentage)} ${colorFor(percentage)}${percentage}%${RESET} ${contextDetail(status)}`;
  return appendUsageToHud(
    contextLine,
    renderUsageSegments(status, snapshot, nowMs),
    '',
    columns,
  );
}

export const ansi = Object.freeze({ RESET, DIM, GREEN, YELLOW, RED });
