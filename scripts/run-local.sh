#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  start) entry=bot/main.ts; env_flag=--env-file=.env ;;
  doctor) entry=codex/doctor.ts; env_flag=--env-file-if-exists=.env ;;
  *) echo 'Usage: sh scripts/run-local.sh start|doctor' >&2; exit 1 ;;
esac
# Prefer the bundled Node runtime with SQLite support. The Bot starts its own
# stdio App Server and does not use the desktop's private tools socket.
for runtime in "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "/Applications/Codex.app/Contents/Resources/cua_node/bin/node"; do
  if [ -x "$runtime" ]; then
    exec "$runtime" --import tsx "$env_flag" "src/$entry"
  fi
done
exec node --import tsx "$env_flag" "src/$entry"
