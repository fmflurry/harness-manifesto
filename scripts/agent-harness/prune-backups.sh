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

refuse() { echo "prune-backups refused: $1" >&2; exit 1; }
say() { echo "prune-backups: $*"; }
CO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
g() { git -C "$CO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || refuse "not a git repository"

base="$(base_branch 2>/dev/null)" || base="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || base=""
base="${base#origin/}"
{ [ -n "$base" ] && git check-ref-format --branch "$base" >/dev/null 2>&1; } || refuse "cannot resolve the base branch"
# Fully qualified: a local tag or branch named origin/<base> must not stand in for the remote-tracking ref.
base_ref="refs/remotes/origin/$base"
current="$(g rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

# Every backup a goal file (any worktree's, all kept in the main checkout's state dir) or a registry entry lists stays
# put. A file that cannot be read refuses the run: it might list a backup.
files=()
for f in "$STATE_DIR"/goal.json "$STATE_DIR"/goals/*.json; do
  if [ -f "$f" ]; then files+=("$f"); fi
done
if rd="$(reg_dir 2>/dev/null)"; then
  for f in "$rd"/*.json; do
    if [ -f "$f" ]; then files+=("$f"); fi
  done
fi
listed=""
for f in ${files[@]+"${files[@]}"}; do
  l="$(jq -r '(.backup_branches // [])[]' "$f" 2>/dev/null)" || refuse "cannot read $f"
  listed+="$l"$'\n'
done

n=0 acted=0 kept=0
while IFS= read -r b; do
  [ -n "$b" ] || continue
  [[ "$b" =~ $BACKUP_RE ]] || continue
  { [ "$b" != "$base" ] && [ "$b" != "$current" ]; } || continue
  n=$((n + 1))
  if g symbolic-ref -q "refs/heads/$b" >/dev/null 2>&1; then say "backup $b kept (symbolic ref)"; kept=$((kept + 1)); continue; fi
  full="$(g rev-parse "refs/heads/$b")"
  tip="${full:0:7}"
  if grep -qxF "$b" <<<"$listed"; then say "backup $b @ $tip kept (listed by a goal)"; kept=$((kept + 1)); continue; fi
  merged=""
  if g merge-base --is-ancestor "$full" "$base_ref" 2>/dev/null; then merged=1; fi
  if [ -z "$confirmed" ]; then
    aref="refs/harness/backups/${b#backup/}"
    have="$(g rev-parse -q --verify "$aref" 2>/dev/null || true)"
    if g worktree list --porcelain 2>/dev/null | grep -qxF "branch refs/heads/$b"; then say "backup $b @ $tip would be kept (checked out in a worktree)"
    elif [ -n "$merged" ]; then say "backup $b @ $tip would be deleted (in origin/$base)"
    elif [ -n "$have" ] && [ "$have" != "$full" ]; then say "backup $b @ $tip would be kept (archive name $aref is taken)"
    else say "backup $b @ $tip would be archived to $aref, then deleted"; fi
    continue
  fi
  if msg="$(backup_retire "$CO" "$b" "$merged" "$full")"; then acted=$((acted + 1)); else kept=$((kept + 1)); fi
  say "$msg"
done < <(g for-each-ref --format='%(refname:short)' refs/heads/backup/)

if [ "$n" -eq 0 ]; then say "no backup branches"
elif [ -z "$confirmed" ]; then say "dry run; pass --confirmed to act"
else say "$acted retired, $kept kept"; fi
exit 0
