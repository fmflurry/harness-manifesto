#!/bin/bash -p
# Usage: agent-harness.sh autonomy|goal|notify|ship-init|ship-merge|cleanup|prune-backups|prune-branches|teardown-merged-worktree|worktree-rm|report|pr-report|pr-report-check|pr-report-links|memory-lint|ado-state|kpi|eval [args...]
for _fn in $(builtin compgen -A function); do builtin unset -f "$_fn"; done
builtin unset _fn
builtin set -euo pipefail
dir="$(builtin cd -P "${BASH_SOURCE[0]%/*}" && builtin pwd -P)"
[ ! -f "$dir/.installed" ] || PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
case "${1:-}" in
  pr-provenance) shift; builtin exec node "$dir/pr-provenance.mjs" "$@" ;;
  autonomy | goal | notify | ship-init | ship-merge | cleanup | prune-backups | prune-branches | teardown-merged-worktree | worktree-rm | report | pr-report | pr-report-check | pr-report-links | memory-lint | ado-state | kpi | eval)
    sub="$1"; shift
    case "$sub" in ship-init | ship-merge | cleanup | teardown-merged-worktree | worktree-rm | goal) takes_repo=1 ;; *) takes_repo="" ;; esac
    args=("$@")
    if [ -z "$takes_repo" ] && [ "$#" -ge 2 ] && [ "${args[$# - 2]}" = --repo ]; then
      echo "agent-harness: $sub does not take --repo" >&2; exit 2
    fi
    if [ -n "$takes_repo" ] && [ "$#" -ge 2 ] && [ "${args[$# - 2]}" = --repo ]; then
      repo="${args[$# - 1]}"
      set -- "${args[@]:0:$# - 2}"
      [[ "$repo" == /* ]] || { echo "agent-harness: --repo needs an absolute path: $repo" >&2; exit 2; }
      real="$(builtin cd -P "$repo" 2>/dev/null && builtin pwd -P)" || { echo "agent-harness: --repo $repo is not a directory" >&2; exit 2; }
      top="$(git -C "$real" rev-parse --show-toplevel 2>/dev/null)" || { echo "agent-harness: --repo $repo is not a git checkout" >&2; exit 2; }
      top="$(builtin cd -P "$top" && builtin pwd -P)"
      [ "$top" = "$real" ] || { echo "agent-harness: --repo $repo is not the top level of a git checkout ($top is)" >&2; exit 2; }
      # Every session's guard reads this per-user list, so a push into the target repo's goal worktrees from any other
      # session takes the full check while that repo keeps goal files.
      if [ "$sub" = ship-init ]; then
        target="$(git -C "$real" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')" || target=""
        if [ -n "$target" ]; then
          mkdir -p "$HOME/.agent-harness/goals-foreign"
          printf '%s\n' "$target" >"$HOME/.agent-harness/goals-foreign/$(printf '%s' "$target" | git hash-object --stdin)"
        fi
      fi
      builtin cd "$real"
      export CLAUDE_PROJECT_DIR="$real"
    fi
    [ -z "$takes_repo" ] || for a in "$@"; do
      case "$a" in --repo | --repo=*) echo "agent-harness: --repo goes last, as --repo <absolute path>" >&2; exit 2 ;; esac
    done
    builtin exec /bin/bash -p "$dir/$sub.sh" "$@" ;;
  *) echo "usage: agent-harness.sh autonomy|goal|notify|ship-init|ship-merge|cleanup|prune-backups|prune-branches|teardown-merged-worktree|worktree-rm|report|pr-report|pr-report-check|pr-report-links|memory-lint|ado-state|kpi|eval [args...]" >&2; exit 2 ;;
esac
