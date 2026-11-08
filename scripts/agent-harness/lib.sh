#!/bin/bash -p
# Helpers for the agent-harness scripts. Source it; do not execute it.
# Hooks must not source this file: it lives in the repo-independent install and hooks run it unattended.
# Inherited (exported) shell functions could shadow gh, git or jq: drop them, then pin gh and orca to real binaries.
for _fn in $(builtin compgen -A function); do builtin unset -f "$_fn"; done
builtin unset _fn
HARNESS_DIR="$(builtin cd -P "${BASH_SOURCE[0]%/*}" && builtin pwd -P)"
# An installed copy carries the .installed marker written by install.sh; it never trusts the inherited environment.
HARNESS_INSTALLED=0
GH="" ORCA="" JQ=""
if [ -f "$HARNESS_DIR/.installed" ]; then
  HARNESS_INSTALLED=1
  PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  while IFS='=' read -r _k _v; do
    case "$_k" in GH) GH="$_v" ;; ORCA) ORCA="$_v" ;; JQ) JQ="$_v" ;; esac
  done <"$HARNESS_DIR/.installed"
  builtin unset _k _v
  [ -z "$JQ" ] || [ ! -x "$JQ" ] || jq() { "$JQ" "$@"; }
  [ -n "$GH" ] && [ -x "$GH" ] || GH="$(type -P gh || echo gh)"
  [ -z "$ORCA" ] || [ -x "$ORCA" ] || ORCA=""
  [ -n "$ORCA" ] || ORCA="$(type -P orca || true)"
else
  GH="$(type -P gh || echo gh)"
  ORCA="$(type -P orca || true)"
fi
# autonomy.on stays in the main checkout. Goal state is one file per worktree and branch.
ROOT="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p' || true)"
[ -n "$ROOT" ] || ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
DEFAULT_STATE_DIR="$ROOT/.claude/state"
STATE_DIR="$DEFAULT_STATE_DIR"
if [ "$HARNESS_INSTALLED" = 0 ] && [ "${AGENT_HARNESS_TEST:-}" = 1 ]; then
  STATE_DIR="${AGENT_STATE_DIR:-${TLTB_STATE_DIR:-$DEFAULT_STATE_DIR}}"
  GH="${GH_BIN:-$GH}"
  ORCA="${ORCA_BIN:-$ORCA}"
fi
# shellcheck source=scripts/agent-harness/goal-state.sh
. "$HARNESS_DIR/goal-state.sh"
goal_scope_select "${CLAUDE_PROJECT_DIR:-$PWD}" "$PWD"
goal_bind_file "$STATE_DIR"
# The repo's .envrc selects the gh account; a plain gh would use the personal token. Only its environment is used:
# the binary stays the pinned $GH, so an agent-written .envrc cannot swap it.
gh_cmd() {
  case "$GH" in
    /*) if [ -f "$ROOT/.envrc" ] && command -v direnv >/dev/null 2>&1; then direnv exec "$ROOT" "$GH" "$@"; else "$GH" "$@"; fi ;;
    *) "$GH" "$@" ;;
  esac
}
CONFIG_FILE="$ROOT/.claude/agent-harness.json"
# shellcheck disable=SC2034
NOTIFY="$HARNESS_DIR/notify.sh"

GH_GRAPHQL_DOWN_RE='GraphQL is not available|Post "https?://[^"]*/graphql"'

# gh_or_rest <rest-fn> [rest-args...] -- <gh args...>: run gh; only when its stderr says GraphQL is unreachable, run the REST function instead.
gh_or_rest() {
  local rest=() out err rc=0
  while [ $# -gt 0 ] && [ "$1" != -- ]; do rest+=("$1"); shift; done
  [ $# -gt 1 ] || return 1
  shift
  out="$(mktemp)" || return 1
  err="$(mktemp)" || { rm -f "$out"; return 1; }
  gh_cmd "$@" >"$out" 2>"$err" || rc=$?
  if [ "$rc" != 0 ] && grep -Eq -- "$GH_GRAPHQL_DOWN_RE" "$err"; then
    rm -f "$out" "$err"
    echo "agent-harness: GitHub GraphQL unavailable; using REST" >&2
    "${rest[@]}"
    return
  fi
  cat "$out"
  cat "$err" >&2
  rm -f "$out" "$err"
  return "$rc"
}

gh_rest_repo_name() {
  local n
  n="$(gh_cmd api 'repos/{owner}/{repo}' --jq .full_name)" || return 1
  [[ "$n" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || return 1
  printf '%s\n' "$n"
}
gh_repo_name() { gh_or_rest gh_rest_repo_name -- repo view --json nameWithOwner -q .nameWithOwner; }

gh_rest_default_branch() {
  local b
  b="$(gh_cmd api 'repos/{owner}/{repo}' --jq .default_branch)" || return 1
  [ -n "$b" ] || return 1
  printf '%s\n' "$b"
}
gh_default_branch() { gh_or_rest gh_rest_default_branch -- repo view --json defaultBranchRef -q .defaultBranchRef.name; }

gh_rest_pr_view() {
  local pr="$1" fields="$2" repo pull again f keys files="" want_files=false
  local -a fl
  [[ "$pr" =~ ^[0-9]+$ ]] || return 1
  [ -n "$fields" ] || return 1
  IFS=, read -r -a fl <<<"$fields"
  [ "${#fl[@]}" -gt 0 ] || return 1
  for f in "${fl[@]}"; do
    case "$f" in
      state | baseRefName | isDraft | headRefOid | headRefName | isCrossRepository) ;;
      files) want_files=true ;;
      *) return 1 ;;
    esac
  done
  keys="$(printf '%s\n' "${fl[@]}" | jq -R . | jq -sc .)" || return 1
  repo="$(gh_rest_repo_name)" || return 1
  pull="$(gh_cmd api "repos/$repo/pulls/$pr")" || return 1
  jq -e '(.state == "open" or .state == "closed") and (.merged | type == "boolean") and (.draft | type == "boolean")
    and ([.head.sha, .head.ref, .base.ref] | all(type == "string" and length > 0))' <<<"$pull" >/dev/null 2>&1 || return 1
  if [ "$want_files" = true ]; then
    files="$(gh_cmd api "repos/$repo/pulls/$pr/files?per_page=100" --paginate --jq '.[]|{path:.filename}' | jq -sc .)" || return 1
    # REST lists at most 3000 files, so a count at the cap cannot prove the list is complete.
    printf '%s\n%s\n' "$pull" "$files" | jq -se '.[0].changed_files as $n | ($n | type == "number") and $n < 3000
      and (.[1] | type == "array") and $n == (.[1] | length)' >/dev/null 2>&1 ||
      { echo "agent-harness: REST file list of PR #$pr is incomplete; refusing" >&2; return 1; }
    # A push between the two reads would pair this head with another head's file list.
    again="$(gh_cmd api "repos/$repo/pulls/$pr")" || return 1
    printf '%s\n%s\n' "$pull" "$again" | jq -se '(.[0] | [.head.sha, .changed_files, .updated_at]) == (.[1] | [.head.sha, .changed_files, .updated_at])' >/dev/null 2>&1 ||
      { echo "agent-harness: PR #$pr changed while reading it over REST; refusing" >&2; return 1; }
  fi
  printf '%s\n%s\n' "$pull" "${files:-null}" | jq -sce --argjson keys "$keys" '.[0] as $p | {
    state: (if $p.state == "open" then "OPEN" elif $p.merged then "MERGED" else "CLOSED" end),
    isDraft: $p.draft, baseRefName: $p.base.ref, headRefName: $p.head.ref, headRefOid: $p.head.sha,
    isCrossRepository: (($p.head.repo.full_name // "") != $p.base.repo.full_name),
    files: .[1]
  } | with_entries(select(.key as $k | $keys | any(. == $k)))'
}
gh_pr_view() { gh_or_rest gh_rest_pr_view "$1" "$2" -- pr view "$1" --json "$2"; }

# gh_pr_list_open <--base|--head> <branch>: open PR numbers. REST's head filter needs owner:branch, so match the bare branch name here, like gh pr list.
gh_rest_pr_list_open() {
  local k repo
  case "$1" in --base) k=base ;; --head) k=head ;; *) return 1 ;; esac
  repo="$(gh_rest_repo_name)" || return 1
  gh_cmd api "repos/$repo/pulls?state=open&per_page=100" --paginate --jq '.[]|{number,base:.base.ref,head:.head.ref}' |
    jq -rs --arg k "$k" --arg b "$2" 'if all(.[]; (.number | type == "number") and (.base | type == "string") and (.head | type == "string"))
      then .[] | select(.[$k] == $b) | .number else error("malformed pull list") end'
}
gh_pr_list_open() { gh_or_rest gh_rest_pr_list_open "$1" "$2" -- pr list --state open "$1" "$2" --json number --jq '.[].number'; }

gh_rest_pr_merge() {
  local repo
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  case "$2" in squash | rebase | merge) ;; *) return 1 ;; esac
  [ -n "$3" ] || return 1
  repo="$(gh_rest_repo_name)" || return 1
  if [ "${4+x}" ]; then
    gh_cmd api -X PUT "repos/$repo/pulls/$1/merge" -f merge_method="$2" -f sha="$3" -f "commit_message=$4" >/dev/null
  else
    gh_cmd api -X PUT "repos/$repo/pulls/$1/merge" -f merge_method="$2" -f sha="$3" >/dev/null
  fi
}
gh_pr_merge() {
  if [ "${4+x}" ]; then
    gh_or_rest gh_rest_pr_merge "$1" "$2" "$3" "$4" -- pr merge "$1" --"$2" --match-head-commit "$3" --body "$4"
  else
    gh_or_rest gh_rest_pr_merge "$1" "$2" "$3" -- pr merge "$1" --"$2" --match-head-commit "$3"
  fi
}

# REST cannot tell whether a review thread is resolved, so report the comment count; pr_problems refuses unless it is 0.
gh_rest_review_threads() {
  local n
  [[ "$2" =~ ^[0-9]+$ ]] || return 1
  n="$(gh_cmd api "repos/$1/pulls/$2/comments?per_page=100" --paginate --jq '.[]|{id}' | jq -s length)" || return 1
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  printf '{"restReviewComments":%s}\n' "$n"
}

main_checkout() {
  local d first
  for d in "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
    [ -n "$d" ] || continue
    first="$(git -C "$d" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
    [ -z "$first" ] || { printf '%s\n' "$first"; return 0; }
  done
  return 1
}

realp() { if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s\n' "${1%/}"; fi; }

# orca_state: absent (no orca binary) | managed | unmanaged | offline (the Orca app is not running: the CLI answers
# runtime_unavailable) | error (orca present but its repo list is unreadable for any other reason).
orca_state() {
  local main out errf rc q paths
  command -v "$ORCA" >/dev/null 2>&1 || { echo absent; return 0; }
  main="$(main_checkout)" || { echo error; return 0; }
  errf="$(mktemp)" || { echo error; return 0; }
  out="$("$ORCA" repo list --json 2>"$errf")"; rc=$?
  if [ "$rc" != 0 ]; then
    # runtime_unavailable comes on stdout or stderr depending on the CLI version, pretty-printed or compact, maybe
    # after warning lines: read each stream whole, from its first "{" line, then line by line.
    if [ "$({ orca_error_code "$out"; orca_error_code "$(cat "$errf")"; } | head -1)" = runtime_unavailable ]; then echo offline; else echo error; fi
    rm -f "$errf"; return 0
  fi
  rm -f "$errf"
  paths="$(jq -r '.. | objects | .path? | strings' <<<"$out" 2>/dev/null)" || { echo error; return 0; }
  main="$(realp "$main")"
  while IFS= read -r q; do
    [ -n "$q" ] && [ "$(realp "$q")" = "$main" ] && { echo managed; return 0; }
  done <<<"$paths"
  echo unmanaged
}
orca_error_code() {
  [ -n "$1" ] || return 0
  jq -r '.error.code? // empty' <<<"$1" 2>/dev/null ||
    sed -n '/^{/,$p' <<<"$1" | jq -r '.error.code? // empty' 2>/dev/null ||
    jq -Rr 'fromjson? | .error.code? // empty' <<<"$1" 2>/dev/null || true
}
orca_managed() { [ "$(orca_state)" = managed ]; }

# cwd_users <dir>: prints the pids whose working directory is <dir> or below it. Fails closed: when lsof is missing
# or cannot see this shell's own process, an empty answer proves nothing.
cwd_users() {
  local out
  command -v lsof >/dev/null 2>&1 || return 1
  out="$(lsof -b -w -a -d cwd -F pn 2>/dev/null)" || [ -n "$out" ] || return 1
  grep -qx "p$$" <<<"$out" || return 1
  awk -v t="$1" '/^p/ { pid = substr($0, 2) } /^n/ { d = substr($0, 2); if (d == t || index(d, t "/") == 1) print pid }' <<<"$out"
}

orca_worktrees() { "$ORCA" worktree list --repo "path:$(main_checkout)" --json; }

# Registry: one JSON file per goal in <git-common-dir>/agent-harness/goals, so it is never tracked and outlives the worktree.
reg_dir() {
  local main common
  main="$(main_checkout)" || return 1
  common="$(git -C "$main" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  printf '%s/agent-harness/goals\n' "$common"
}
reg_slug() { printf '%s' "${1//\//-}"; }
reg_path() {
  local d
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
  d="$(reg_dir)" || return 1
  printf '%s/%s.json\n' "$d" "$1"
}
reg_get() { local f; f="$(reg_path "$1")" || return 1; jq -r "$2" "$f" 2>/dev/null; }

# reg_update <slug> <jq args...> <filter>: atomic rewrite; a missing entry is not an error.
reg_update() {
  local slug="$1" f tmp; shift
  f="$(reg_path "$slug")" || return 0
  [ -f "$f" ] || return 0
  tmp="$(mktemp "$f.XXXXXX")" || return 1
  if jq "$@" "$f" >"$tmp"; then mv "$tmp" "$f"; else rm -f "$tmp"; return 1; fi
}

# goal_slug: registry name of the goal in goal.json (its slug, else the slug of its branch). Never the cwd's HEAD.
goal_slug() {
  local s b
  s="$(goal_get '.slug // empty')"
  if [ -z "$s" ]; then
    b="$(goal_get '.branch // empty')"
    [ -z "$b" ] || s="$(reg_slug "$b")"
  fi
  printf '%s' "$s"
}

# Point GOAL_FILE at the registered worktree for this PR. A missing entry leaves the caller's file.
goal_bind_registered_pr() {
  local slug path
  slug="$(reg_find_by_pr "$1" 2>/dev/null)" || return 1
  path="$(reg_get "$slug" '.path // empty')"
  [ -d "$path" ] || return 1
  goal_scope_resolve "$path"
  [ "${GS_KIND:-none}" != none ] || return 1
  goal_bind_file "$STATE_DIR"
}

# Keep .claude/state/ out of git in the main checkout. A repo that already ignores it keeps its own rule.
exclude_state_dir() {
  [ "$STATE_DIR" = "$DEFAULT_STATE_DIR" ] || return 0
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  git -C "$ROOT" check-ignore -q .claude/state/autonomy.on && git -C "$ROOT" check-ignore -q .claude/state/decisions/x.tsv && return 0
  local file
  file="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path info/exclude)"
  grep -Fxq '.claude/state/' "$file" 2>/dev/null && return 0
  mkdir -p "$(dirname "$file")"
  [ ! -s "$file" ] || [ -z "$(tail -c 1 "$file")" ] || echo >>"$file"
  echo '.claude/state/' >>"$file"
}

# decisions_archive <slug>: move a finished goal's decision log to decisions/archive/, never over an older archive.
decisions_archive() {
  local src dest
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 0
  src="$STATE_DIR/decisions/$1.tsv"
  [ -f "$src" ] || return 0
  dest="$STATE_DIR/decisions/archive/$1.tsv"
  [ ! -e "$dest" ] || dest="$STATE_DIR/decisions/archive/$1.$(date -u +%Y%m%dT%H%M%SZ).tsv"
  mkdir -p "$STATE_DIR/decisions/archive" && mv "$src" "$dest" && echo "decisions archived $dest"
}

# reg_proves_gone_goal <pr> <head-branch>: the caller has seen the PR MERGED. True only when exactly one registry entry
# tracks the PR, it records that head branch under that branch's slug, and its absolute worktree path no longer exists.
reg_proves_gone_goal() {
  local d f hits=() path main wts
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  d="$(reg_dir)" || return 1
  for f in "$d"/*.json; do
    [ -f "$f" ] || continue
    jq -e --argjson n "$1" '.pr == $n' "$f" >/dev/null 2>&1 && hits+=("$f")
  done
  [ "${#hits[@]}" = 1 ] || return 1
  f="${hits[0]}"
  [ "$(basename "$f" .json)" = "$(reg_slug "$2")" ] || return 1
  jq -e --arg b "$2" '.branch == $b and (.status | IN("merged", "done", "active"))' "$f" >/dev/null 2>&1 || return 1
  path="$(jq -r '.path // empty' "$f")"
  [[ "$path" == /* ]] || return 1
  { [ ! -e "$path" ] && [ ! -L "$path" ]; } || return 1
  main="$(main_checkout)" || return 1
  wts="$(git -C "$main" worktree list --porcelain)" || return 1
  ! grep -qxF "branch refs/heads/$2" <<<"$wts"
}

# reg_find_by_pr <pr>: prints the slug of the registered goal bound to the PR, else the goal.json goal when it tracks that PR.
reg_find_by_pr() {
  local d f s
  d="$(reg_dir)" || return 1
  for f in "$d"/*.json; do
    [ -f "$f" ] || continue
    if jq -e --argjson n "$1" '.pr == $n' "$f" >/dev/null 2>&1; then basename "$f" .json; return 0; fi
  done
  [ "$(goal_get '.pr // empty')" = "$1" ] || return 1
  s="$(goal_slug)"
  { [ -n "$s" ] && [ -f "$d/$s.json" ]; } || return 1
  printf '%s\n' "$s"
}

# reg_mirror <jq args...> <filter>: update the registry entry of the goal in goal.json, if it has one.
reg_mirror() {
  local slug
  slug="$(goal_slug)"
  [ -n "$slug" ] || return 0
  reg_update "$slug" "$@" || true
}

autonomy_on() { [ -f "$STATE_DIR/autonomy.on" ]; }

goal_get() { jq -r "$1" "$GOAL_FILE" 2>/dev/null; }

goal_update() {
  [ -f "$GOAL_FILE" ] || return 0
  local tmp
  tmp="$(mktemp "$STATE_DIR/goal.XXXXXX")" || return 1
  if jq "$@" "$GOAL_FILE" >"$tmp"; then mv "$tmp" "$GOAL_FILE"; else rm -f "$tmp"; return 1; fi
}

cfg_get() { [ -f "$CONFIG_FILE" ] || return 0; jq -r "$1" "$CONFIG_FILE" 2>/dev/null || true; }

# Backup branch names the harness creates and may retire.
BACKUP_RE='^backup/[a-z0-9]+(-[a-z0-9]+)*$'

# backup_retire <checkout> <branch> <merged>: deletes a merged backup, or archives an unmerged one under
# refs/harness/backups/ and then deletes it. Prints one line; returns 0 only when the branch is gone.
# refs/harness has no reflog, so an existing archive is never moved: the empty old value makes update-ref create-only.
backup_retire() {
  local co="$1" b="$2" merged="$3" tip aref have
  tip="$(git -C "$co" rev-parse "refs/heads/$b")" || { echo "backup $b kept (unreadable)"; return 1; }
  if [ -n "$merged" ]; then
    if git -C "$co" branch -D "$b" >/dev/null 2>&1; then echo "backup $b deleted"; return 0; fi
    echo "backup $b kept (delete failed)"; return 1
  fi
  aref="refs/harness/backups/${b#backup/}"
  have="$(git -C "$co" rev-parse -q --verify "$aref" 2>/dev/null || true)"
  if [ -n "$have" ] && [ "$have" != "$tip" ]; then echo "backup $b kept (archive name $aref is taken)"; return 1; fi
  if [ -z "$have" ] && ! git -C "$co" update-ref "$aref" "$tip" ""; then echo "backup $b kept (archive failed)"; return 1; fi
  if git -C "$co" branch -D "$b" >/dev/null 2>&1; then echo "backup $b archived to $aref"; return 0; fi
  echo "backup $b archived to $aref; branch kept (delete failed)"; return 1
}

base_branch() {
  local b
  b="$(cfg_get '.base // empty')"
  [ -n "$b" ] || b="$(gh_default_branch)" || return 1
  [ -n "$b" ] || return 1
  echo "$b"
}

protected_regex() {
  cfg_get '(.protectedPaths // []) | join("|")'
}

# pr_problems <pr> <head-sha> <base>: one line per unmet rail; empty output means all green.
# Returns 2 when GitHub cannot be queried.
pr_problems() {
  local pr="$1" head="$2" base="$3" repo runs statuses threads bad review behind name rs who
  repo="$(gh_repo_name)" || return 2

  runs="$(gh_cmd api "repos/$repo/commits/$head/check-runs" --paginate --jq '.check_runs[]' | jq -s .)" || return 2
  bad="$(jq -r '[.[] | select(.status != "completed" or (.conclusion | IN("success", "skipped", "neutral") | not)) | .name]
    | unique | join(", ")' <<<"$runs")"
  [ -z "$bad" ] || echo "checks failing or pending: $bad"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    jq -e --arg n "$name" 'any(.[]; .name == $n and .status == "completed" and (.conclusion | IN("success", "skipped", "neutral")))' \
      <<<"$runs" >/dev/null || echo "required check '$name' missing or not passing"
  done <<<"$(cfg_get '(.requiredChecks // [])[]')"

  rs="$(cfg_get '.reviewStatus // empty')"
  if [ -n "$rs" ]; then
    who="$(cfg_get '.reviewStatusCreator // empty')"
    statuses="$(gh_cmd api "repos/$repo/commits/$head/statuses" --paginate --jq '.[]' | jq -s .)" || return 2
    review="$(jq -r --arg c "$rs" --arg who "$who" '[.[] | select(.context == $c)] | sort_by(.id) | last
      | if . == null then "missing" elif ($who != "" and .creator.login != $who) then "posted by \(.creator.login)"
        elif .state != "success" then "state \(.state)" else "ok" end' <<<"$statuses")"
    [ "$review" = ok ] || echo "$rs status not green for head ${head:0:8}: $review"
  fi

  threads="$(gh_or_rest gh_rest_review_threads "$repo" "$pr" -- api graphql -F owner="${repo%%/*}" -F name="${repo##*/}" -F pr="$pr" -f query='
query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved}}}}}')" || return 2
  if jq -e 'type == "object" and has("restReviewComments")' <<<"$threads" >/dev/null 2>&1; then
    bad="$(jq -r .restReviewComments <<<"$threads")"
    [ "$bad" = 0 ] || echo "review threads unverifiable without GitHub GraphQL: $bad review comments; REST cannot tell resolved threads, so merge where GraphQL works"
  elif [ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$threads")" = true ]; then
    echo "more than 100 review threads: resolve some, then retry"
  else
    bad="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' <<<"$threads")"
    [ "$bad" = 0 ] || echo "unresolved review threads: $bad"
  fi

  behind="$(gh_cmd api "repos/$repo/compare/$base...$head" --jq .behind_by)" || return 2
  [[ "$behind" =~ ^[0-9]+$ ]] || return 2
  [ "$behind" = 0 ] || echo "head is behind $base by $behind commits; rebase first"
  return 0
}

# Append one KPI event. Fail-open. Hooks keep their own copy and must not source this file.
kpi_emit() {
  local k candidate
  k=""
  for candidate in \
    "$HARNESS_DIR/hooks/kpi-emit.sh" \
    "$HARNESS_DIR/../../hooks/kpi-emit.sh" \
    "$HARNESS_DIR/../../.claude/hooks/kpi-emit.sh"
  do
    [ -f "$candidate" ] || continue
    k="$candidate"
    break
  done
  [ -n "$k" ] || return 0
  "$k" "$@" >/dev/null 2>&1 || true
}
