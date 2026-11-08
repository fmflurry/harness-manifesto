#!/bin/bash -p
# shellcheck disable=SC2016
# cleanup.sh <pr> [--keep-branch] [--no-checkout]: post-merge tidy of the remote head branch, local checkout, local head and goal backup branches,
# and archive of a registered goal's decision log. Never removes worktrees.
# --no-checkout leaves the checkout alone (no fetch, switch or pull) and deletes the local branch whenever it is checked out nowhere.
set -euo pipefail
# shellcheck source=scripts/agent-harness/lib.sh
. "${BASH_SOURCE[0]%/*}/lib.sh"
usage="usage: cleanup.sh <pr> [--keep-branch] [--no-checkout]"
pr="" keep="" nocheckout=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-branch) keep=1 ;;
    --no-checkout) nocheckout=1 ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) [ -z "$pr" ] || { echo "$usage" >&2; exit 2; }; pr="$1" ;;
  esac
  shift
done
[ -n "$pr" ] || { echo "$usage" >&2; exit 2; }
bound=""
goal_bind_registered_pr "$pr" && bound=1

refuse() { echo "cleanup refused: $1" >&2; exit 1; }
say() { echo "cleanup: $*"; }
CO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
g() { git -C "$CO" "$@"; }

view="$(gh_pr_view "$pr" state,headRefName,headRefOid,isCrossRepository)" || refuse "cannot read PR #$pr"
base="$(base_branch)" || refuse "cannot resolve the base branch"
branch="$(jq -r .headRefName <<<"$view")"
oid="$(jq -r .headRefOid <<<"$view")"
cross="$(jq -r .isCrossRepository <<<"$view")"
[ "$(jq -r .state <<<"$view")" = MERGED ] || refuse "PR #$pr is not MERGED"
{ [ -n "$branch" ] && [ "$branch" != null ] && [ "$branch" != "$base" ]; } || refuse "PR #$pr head branch is empty or the base branch"
if autonomy_on && [ -z "$bound" ] && reg_proves_gone_goal "$pr" "$branch"; then
  say "goal registry entry for PR #$pr proves the merged goal (worktree gone)"
elif autonomy_on; then
  gpr="$(goal_get '.pr // empty' || true)"
  [ -n "$gpr" ] || refuse "goal does not track a PR; autonomous cleanup needs goal pr #$pr"
  [ "$gpr" = "$pr" ] || refuse "goal tracks PR #$gpr, not #$pr"
fi

errf="$(mktemp)"
trap 'rm -f "$errf"' EXIT
if [ -z "$keep" ] && [ "$cross" = false ]; then
  repo="$(gh_repo_name 2>/dev/null)" || repo=""
  if [ -z "$repo" ]; then
    say "remote $branch skipped (repo unknown)"
  elif ! info="$(gh_cmd api "repos/$repo/branches/$branch" 2>"$errf")"; then
    if grep -q 'HTTP 404' "$errf"; then say "remote $branch absent"; else say "remote $branch unknown (gh error)"; fi
  elif [ "$(jq -r '.protected // false' <<<"$info")" = true ]; then
    say "remote $branch kept (protected)"
  elif ! by_base="$(gh_pr_list_open --base "$branch" 2>/dev/null)" ||
    ! by_head="$(gh_pr_list_open --head "$branch" 2>/dev/null)"; then
    say "remote $branch kept (cannot list open PRs)"
  elif [ -n "$by_base" ] || [ -n "$by_head" ]; then
    say "remote $branch kept (open PR uses it)"
  elif [ "$(jq -r '.commit.sha // empty' <<<"$info")" != "$oid" ]; then
    say "remote $branch kept (tip moved since merge)"
  elif gh_cmd api -X DELETE "repos/$repo/git/refs/heads/$branch" >/dev/null 2>&1; then
    say "remote $branch deleted"
  else
    say "remote $branch kept (delete failed)"
  fi
fi

dirty=""
[ -z "$(g status --porcelain 2>/dev/null)" ] || dirty=1
if [ -n "$nocheckout" ]; then
  say "checkout untouched"
elif [ "${GITHUB_ACTIONS:-}" = true ]; then
  say "checkout skipped (ci)"
elif [ -n "$dirty" ]; then
  say "checkout skipped (dirty tree)"
else
  g fetch --prune origin >/dev/null 2>&1 || say "fetch skipped"
  if err="$(g switch "$base" 2>&1)"; then
    if err="$(g pull --ff-only 2>&1)"; then
      say "checkout $base @ $(g rev-parse --short HEAD)"
    else
      say "checkout $base (pull skipped: $(head -n1 <<<"$err"))"
    fi
  elif g worktree list --porcelain | grep -qx "branch refs/heads/$base"; then
    if err="$(g switch --detach "origin/$base" 2>&1)"; then
      say "checkout detached at origin/$base"
    else
      say "checkout skipped ($(head -n1 <<<"$err"))"
    fi
  else
    say "checkout skipped ($(head -n1 <<<"$err"))"
  fi
fi

current="$(g rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

if [ -z "$keep" ] && [ "$branch" != "$current" ] && g show-ref --verify --quiet "refs/heads/$branch"; then
  tip="$(g rev-parse "refs/heads/$branch")"
  if [ -n "$dirty" ] && [ -z "$nocheckout" ]; then
    say "local $branch kept (dirty tree)"
  elif [ "$tip" = "$oid" ] || g merge-base --is-ancestor "$tip" "$oid" 2>/dev/null; then
    if g branch -D "$branch" >/dev/null 2>&1; then say "local $branch deleted"; else say "local $branch kept (delete failed)"; fi
  else
    say "local $branch kept (unpushed commits)"
  fi
fi

# Backups come from the goal file when it tracks this PR, else from the registry entry (the worktree may be gone).
# A backup merged by ancestry is deleted. After a squash merge no pre-rebase snapshot is an ancestor, so the
# others are archived under refs/harness/backups/: gone from the branch list, still recoverable.
bsrc="" bslug=""
if [ "$(goal_get '.pr // empty')" = "$pr" ]; then bsrc=goal
elif bslug="$(reg_find_by_pr "$pr" 2>/dev/null)"; then bsrc=reg; fi
if [ -n "$bsrc" ]; then
  done_b=()
  if [ "$bsrc" = goal ]; then blist="$(goal_get '(.backup_branches // [])[]')"; else blist="$(reg_get "$bslug" '(.backup_branches // [])[]')"; fi
  while IFS= read -r b; do
    [[ "$b" =~ ^backup/[a-z0-9]+(-[a-z0-9]+)*$ ]] || continue
    { [ "$b" != "$base" ] && [ "$b" != "$current" ]; } || continue
    g show-ref --verify --quiet "refs/heads/$b" || continue
    btip="$(g rev-parse "refs/heads/$b")"
    if g merge-base --is-ancestor "$btip" "$oid" 2>/dev/null || g merge-base --is-ancestor "$btip" "origin/$base" 2>/dev/null; then
      if g branch -D "$b" >/dev/null 2>&1; then say "backup $b deleted"; done_b+=("$b"); else say "backup $b kept (delete failed)"; fi
    else
      aref="refs/harness/backups/${b#backup/}"
      have="$(g rev-parse -q --verify "$aref" 2>/dev/null || true)"
      # refs/harness has no reflog: never move an existing archive. The empty old value makes update-ref create-only.
      if [ -n "$have" ] && [ "$have" != "$btip" ]; then say "backup $b kept (archive name $aref is taken)"; continue; fi
      if [ -z "$have" ] && ! g update-ref "$aref" "$btip" ""; then say "backup $b kept (archive failed)"; continue; fi
      if g branch -D "$b" >/dev/null 2>&1; then say "backup $b archived to $aref"; done_b+=("$b")
      else say "backup $b archived to $aref; branch kept (delete failed)"; fi
    fi
  done <<<"$blist"
  if [ "${#done_b[@]}" -gt 0 ]; then
    d="$(printf '%s\n' "${done_b[@]}" | jq -R . | jq -sc .)"
    [ "$bsrc" != goal ] || goal_update --argjson d "$d" '.backup_branches = ((.backup_branches // []) - $d)'
    [ -n "$bslug" ] || bslug="$(reg_find_by_pr "$pr" 2>/dev/null)" || bslug=""
    [ -z "$bslug" ] || reg_update "$bslug" --argjson d "$d" '.backup_branches = ((.backup_branches // []) - $d)' || true
  fi
fi

if slug="$(reg_find_by_pr "$pr" 2>/dev/null)"; then
  case "$(reg_get "$slug" '.status // empty' || true)" in
    escalated | blocked) ;;
    *) msg="$(decisions_archive "$slug")" || msg="decisions archive failed for $slug"; [ -z "$msg" ] || say "$msg" ;;
  esac
fi

gd="$(cd "$CO" && cd "$(g rev-parse --git-dir)" && pwd -P)"
gc="$(cd "$CO" && cd "$(g rev-parse --git-common-dir)" && pwd -P)"
[ "$gd" = "$gc" ] || say "worktree $(g rev-parse --show-toplevel) kept"
exit 0
