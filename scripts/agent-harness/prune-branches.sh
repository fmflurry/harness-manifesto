#!/bin/bash -p
# prune-branches.sh [--confirmed]: delete local branches (other than backup/*, which prune-backups handles) whose tip is
# already in origin/<base>, that no worktree has checked out, that are not the current branch, and that no goal file or
# registry entry claims. A branch still at the tip of origin/<base> has no commits of its own yet and is kept. Remote
# branches are never touched. Dry run unless --confirmed (it still refreshes origin/<base>).
set -euo pipefail
# shellcheck source=scripts/agent-harness/lib.sh
. "${BASH_SOURCE[0]%/*}/lib.sh"
usage="usage: prune-branches.sh [--confirmed]"
confirmed=""
case "$#:${1:-}" in
  0:) ;;
  1:--confirmed) confirmed=1 ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

refuse() { echo "prune-branches refused: $1" >&2; exit 1; }
say() { echo "prune-branches: $*"; }
CO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
g() { git -C "$CO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || refuse "not a git repository"

base="$(base_branch 2>/dev/null)" || base=""
{ [ -n "$base" ] && git check-ref-format --branch "$base" >/dev/null 2>&1; } || refuse "cannot resolve the base branch"
# The proof is the sha origin reports now, held in a variable: any local ref, refs/remotes/origin/<base> included, can
# be rewritten while this runs. The fetch only brings the objects in (and refreshes origin/<base> as a side effect).
export GIT_TERMINAL_PROMPT=0
base_tip="$(g ls-remote --exit-code origin "refs/heads/$base" 2>/dev/null | cut -f1)" || base_tip=""
[[ "$base_tip" =~ ^[0-9a-f]{40,64}$ ]] || refuse "cannot read $base from origin"
g fetch -q --no-tags origin "+refs/heads/$base:refs/remotes/origin/$base" 2>/dev/null || refuse "cannot fetch $base from origin"
g cat-file -e "$base_tip^{commit}" 2>/dev/null || refuse "origin/$base moved during the run; retry"
current="$(g symbolic-ref -q HEAD 2>/dev/null || true)"

# Every branch a goal file (any worktree's, all kept in the main checkout's state dir) or a registry entry names stays
# put. A file that cannot be read refuses the run: it might claim a branch.
files=()
for f in "$STATE_DIR"/goal.json "$STATE_DIR"/goal.shared.quarantine*.json "$STATE_DIR"/goals/*.json; do
  if [ -f "$f" ]; then files+=("$f"); fi
done
if rd="$(reg_dir 2>/dev/null)"; then
  for f in "$rd"/*.json; do
    if [ -f "$f" ]; then files+=("$f"); fi
  done
fi
claimed=""
for f in ${files[@]+"${files[@]}"}; do
  l="$(jq -r '.branch // empty' "$f" 2>/dev/null)" || refuse "cannot read $f"
  claimed+="$l"$'\n'
done
worktrees="$(g worktree list --porcelain)" || refuse "cannot list worktrees"

n=0 acted=0 kept=0
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  b="${ref#refs/heads/}"
  case "$b" in backup/*) continue ;; esac
  { [ "$b" != "$base" ] && [ "$ref" != "$current" ]; } || continue
  n=$((n + 1))
  # A symbolic ref would make the delete remove its target branch.
  if g symbolic-ref -q "$ref" >/dev/null 2>&1; then say "$b kept (symbolic ref)"; kept=$((kept + 1)); continue; fi
  full="$(g rev-parse "$ref")"
  tip="${full:0:7}"
  if grep -qxF "$b" <<<"$claimed"; then say "$b @ $tip kept (claimed by a goal)"; kept=$((kept + 1)); continue; fi
  if grep -qxF "branch $ref" <<<"$worktrees"; then say "$b @ $tip kept (checked out in a worktree)"; kept=$((kept + 1)); continue; fi
  if [ "$full" = "$base_tip" ]; then say "$b @ $tip kept (no commits of its own yet)"; kept=$((kept + 1)); continue; fi
  if ! g merge-base --is-ancestor "$full" "$base_tip" 2>/dev/null; then say "$b @ $tip kept (not in origin/$base)"; kept=$((kept + 1)); continue; fi
  if [ -z "$confirmed" ]; then say "$b @ $tip would be deleted (in origin/$base)"; continue; fi
  # Deleted against the tip judged above, so a branch that moved meanwhile is kept.
  if g update-ref --no-deref -d "$ref" "$full" 2>/dev/null; then say "$b @ $tip deleted"; acted=$((acted + 1)); else say "$b @ $tip kept (delete failed)"; kept=$((kept + 1)); fi
done < <(g for-each-ref --format='%(refname)' refs/heads/)

if [ "$n" -eq 0 ]; then say "no branches to consider"
elif [ -z "$confirmed" ]; then say "dry run; pass --confirmed to act"
else say "$acted deleted, $kept kept"; fi
exit 0
