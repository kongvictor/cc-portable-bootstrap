#!/bin/sh
set -eu
set +x

NODE_BIN=${CLAUDEX_NODE_BIN:-node}
CLAUDE_BIN=${CLAUDEX_CLAUDE_BIN:-claude}
KEY_FILE=${CLAUDEX_API_KEY_FILE:-"$HOME/.secrets/cliproxy_apikey"}
PREFERRED_URL=${CLIPROXY_URL:-http://127.0.0.1:8317}
FALLBACK_URL=${CLAUDEX_FALLBACK_URL:-http://127.0.0.1:8317}
CHECK_ONLY=0
FAST_MODE=0
EFFORT='xhigh'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      shift
      ;;
    --fast)
      FAST_MODE=1
      shift
      ;;
    --effort)
      if [ "$#" -lt 2 ]; then
        printf '%s\n' 'claudex: --effort requires a value (high|xhigh|max|ultra)' >&2
        exit 1
      fi
      EFFORT=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

case "$EFFORT" in
  high|xhigh|max|ultra) ;;
  *)
    printf 'claudex: invalid --effort value %s (expected high|xhigh|max|ultra)\n' "$EFFORT" >&2
    exit 1
    ;;
esac

# The proxy strips the "(effort)" suffix and writes reasoning.effort upstream;
# Claude Code strips the trailing "[1m]" client-side before sending, so the
# combined form keeps the 1M context budget AND selects the reasoning tier.
MAIN_MODEL="gpt-5.6-sol(${EFFORT})[1m]"
SUBAGENT_MODEL="gpt-5.6-sol(${EFFORT})"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  printf '%s\n' 'claudex: Node.js 18+ is required' >&2
  exit 1
fi

node_major=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')
if [ "$node_major" -lt 18 ]; then
  printf '%s\n' 'claudex: Node.js 18+ is required' >&2
  exit 1
fi

if [ ! -f "$KEY_FILE" ] || [ ! -s "$KEY_FILE" ]; then
  printf '%s\n' 'claudex: secret file is missing or empty; create ~/.secrets/cliproxy_apikey yourself' >&2
  exit 1
fi

health_check() {
  "$NODE_BIN" - "$1" "$KEY_FILE" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs');
const [base, keyFile] = process.argv.slice(2);
let key;
try {
  key = fs.readFileSync(keyFile, 'utf8').trim();
} catch {
  process.exit(1);
}
if (!key) process.exit(1);
let url;
try {
  url = new URL(base.replace(/\/+$/, '') + '/v1/models');
} catch {
  process.exit(1);
}
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
fetch(url, {
  method: 'GET',
  headers: { Authorization: `Bearer ${key}` },
  redirect: 'manual',
  signal: controller.signal,
}).then((response) => {
  clearTimeout(timer);
  process.exit(response.status >= 200 && response.status < 300 ? 0 : 1);
}).catch(() => {
  clearTimeout(timer);
  process.exit(1);
});
NODE
}

selected_url=''
selected_label=''
if health_check "$PREFERRED_URL"; then
  selected_url=$PREFERRED_URL
  selected_label='preferred'
elif [ "$PREFERRED_URL" != "$FALLBACK_URL" ] && health_check "$FALLBACK_URL"; then
  selected_url=$FALLBACK_URL
  selected_label='localhost fallback'
else
  printf '%s\n' 'claudex: no healthy proxy endpoint returned HTTP 2xx; refusing to launch' >&2
  exit 1
fi

if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  printf '%s\n' 'claudex: Claude executable not found' >&2
  exit 1
fi

fast_extra_body=''
if [ "$FAST_MODE" -eq 1 ]; then
  if ! fast_extra_body=$("$NODE_BIN" <<'NODE'
let body = {};
const existing = process.env.CLAUDE_CODE_EXTRA_BODY;
if (existing) {
  try {
    const parsed = JSON.parse(existing);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) process.exit(1);
    body = parsed;
  } catch {
    process.exit(1);
  }
}
body.speed = 'fast';
process.stdout.write(JSON.stringify(body));
NODE
  ); then
    printf '%s\n' 'claudex: CLAUDE_CODE_EXTRA_BODY must be a JSON object when --fast is used' >&2
    exit 1
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '%s\n' 'claudex check: secret file present and non-empty (value hidden)'
  printf 'claudex check: %s endpoint returned HTTP 2xx\n' "$selected_label"
  printf '%s\n' 'claudex check: Claude executable found'
  printf '%s\n' 'claudex check: inherited ANTHROPIC_API_KEY will be removed before launch'
  if [ "$FAST_MODE" -eq 1 ]; then
    printf '%s\n' 'claudex check: Fast mode enabled (request speed=fast)'
  else
    printf '%s\n' 'claudex check: Fast mode available via --fast'
  fi
  printf 'claudex check: reasoning effort=%s (model %s)\n' "$EFFORT" "$MAIN_MODEL"
  exit 0
fi

api_key=$("$NODE_BIN" - "$KEY_FILE" <<'NODE'
const fs = require('node:fs');
const key = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!key) process.exit(1);
process.stdout.write(key);
NODE
)

unset ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=$selected_url
export ANTHROPIC_AUTH_TOKEN=$api_key
if [ "$FAST_MODE" -eq 1 ]; then
  export CLAUDE_CODE_EXTRA_BODY=$fast_extra_body
fi
export CLAUDE_CODE_SUBAGENT_MODEL=$SUBAGENT_MODEL
export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY='3'
export CLAUDE_CODE_AUTO_COMPACT_WINDOW='360000'
export ENABLE_TOOL_SEARCH='false'

exec "$CLAUDE_BIN" --permission-mode auto --model "$MAIN_MODEL" "$@"
