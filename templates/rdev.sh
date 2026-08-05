#!/bin/sh
set -eu

NODE_BIN=${RDEV_NODE_BIN:-node}
SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd)
EXEC_HELPER="$SCRIPT_DIR/rdev-exec.mjs"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  printf '%s\n' 'rdev: Node.js 18+ is required' >&2
  exit 1
fi

node_major=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')
if [ "$node_major" -lt 18 ]; then
  printf '%s\n' 'rdev: Node.js 18+ is required' >&2
  exit 1
fi

if [ ! -f "$EXEC_HELPER" ]; then
  printf '%s\n' 'rdev: rdev-exec.mjs is missing; rerun bootstrap setup' >&2
  exit 1
fi

exec "$NODE_BIN" "$EXEC_HELPER" "$@"
