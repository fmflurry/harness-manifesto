#!/bin/bash -p
# prune-backups.sh [--confirmed]: retire backup/* branches that no goal file or registry entry lists any more
# (left over from goals torn down before cleanup tracked backups). A backup already in origin/<base> is deleted;
# any other is archived under refs/harness/backups/<name> first, so nothing is lost. Dry run unless --confirmed.
set -euo pipefail
# shellcheck source=scripts/agent-harness/lib.sh
. "${BASH_SOURCE[0]%/*}/lib.sh"
usage="usage: prune-backups.sh [--confirmed]"
confirmed=""
case "$#:${1:-}" in
  0:) ;;
  1:--confirmed) confirmed=1 ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

say() { echo "prune-backups: $*"; }
CO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
g() { git -C "$CO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || { echo "prune-backups refused: not a git repository" >&2; exit 1; }

base="$(base_branch 2>/dev/null)" || base="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || base=""
base="${base#origin/}"
[ -n "$base" ] || { echo "prune-backups refused: cannot resolve the base branch" >&2; exit 1; }
current="$(g rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

# Every backup a live goal (any worktree's goal file) or a registry entry still lists stays put.
listed="$(
  {
    for f in "$STATE_DIR"/goal.json "$STATE_DIR"/goals/*.json; do [ -f "$f" ] && printf '%s\n' "$f"; done
    rd="$(reg_dir 2>/dev/null)" && for f in "$rd"/*.json; do [ -f "$f" ] && printf '%s\n' "$f"; done
  } | while IFS= read -r f; do jq -r '(.backup_branches // [])[]' "$f" 2>/dev/null || true; done | sort -u
)"

n=0 acted=0 kept=0
while IFS= read -r b; do
  [ -n "$b" ] || continue
  [[ "$b" =~ $BACKUP_RE ]] || continue
  { [ "$b" != "$base" ] && [ "$b" != "$current" ]; } || continue
  n=$((n + 1))
  tip="$(g rev-parse --short "refs/heads/$b")"
  if grep -qxF "$b" <<<"$listed"; then say "backup $b @ $tip kept (listed by a goal)"; kept=$((kept + 1)); continue; fi
  merged=""
  g merge-base --is-ancestor "refs/heads/$b" "origin/$base" 2>/dev/null && merged=1
  if [ -z "$confirmed" ]; then
    if [ -n "$merged" ]; then say "backup $b @ $tip would be deleted (in origin/$base)"
    else say "backup $b @ $tip would be archived to refs/harness/backups/${b#backup/}, then deleted"; fi
    continue
  fi
  if msg="$(backup_retire "$CO" "$b" "$merged")"; then acted=$((acted + 1)); else kept=$((kept + 1)); fi
  say "$msg"
done < <(g for-each-ref --format='%(refname:short)' refs/heads/backup/)

if [ "$n" -eq 0 ]; then say "no backup branches"
elif [ -z "$confirmed" ]; then say "dry run; pass --confirmed to act"
else say "$acted retired, $kept kept"; fi
exit 0
