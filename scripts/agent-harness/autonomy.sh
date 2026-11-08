#!/bin/bash -p
# Usage: autonomy.sh on|off|status
set -euo pipefail
# shellcheck source=scripts/agent-harness/lib.sh
. "${BASH_SOURCE[0]%/*}/lib.sh"

case "${1:-status}" in
  on) mkdir -p "$STATE_DIR" && : >"$STATE_DIR/autonomy.on"; exclude_state_dir; echo "autonomy: on" ;;
  off) rm -f "$STATE_DIR/autonomy.on"; echo "autonomy: off" ;;
  status) if autonomy_on; then echo "autonomy: on"; else echo "autonomy: off"; fi ;;
  *) echo "usage: autonomy.sh on|off|status" >&2; exit 2 ;;
esac
