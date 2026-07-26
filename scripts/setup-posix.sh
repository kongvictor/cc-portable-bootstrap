#!/bin/sh
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CORE="$SCRIPT_DIR/../core/bootstrap.mjs"
ACTION=${1:-check}
if [ "$#" -gt 0 ]; then shift; fi

case "$ACTION" in
  check|setup|restore) ;;
  -h|--help)
    exec node "$CORE" --help
    ;;
  *)
    printf 'setup-posix.sh: unknown action: %s\n' "$ACTION" >&2
    exit 2
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'setup-posix.sh: Node.js 18+ is required' >&2
  exit 1
fi
node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')
if [ "$node_major" -lt 18 ]; then
  printf '%s\n' 'setup-posix.sh: Node.js 18+ is required' >&2
  exit 1
fi

if [ -n "${CC_BOOTSTRAP_PROFILE:-}" ]; then
  PROFILE=$CC_BOOTSTRAP_PROFILE
elif [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = 'zsh' ]; then
  PROFILE=$HOME/.zshrc
elif [ -n "${BASH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = 'bash' ]; then
  PROFILE=$HOME/.bashrc
elif [ -f "$HOME/.zshrc" ]; then
  PROFILE=$HOME/.zshrc
elif [ -f "$HOME/.bashrc" ]; then
  PROFILE=$HOME/.bashrc
else
  PROFILE=$HOME/.profile
fi

exec node "$CORE" "$ACTION" --profile "$PROFILE" "$@"
