#!/usr/bin/env bash
# Fails when the repository tracks a symlink whose target is an absolute path: such a link
# only resolves on the machine that created it.
set -euo pipefail
repo="${1:-.}"
found=0
# Captured to a file, not a process substitution, so a git failure (e.g. not a repo) aborts under set -e.
listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT
git -C "$repo" ls-files -s -z >"$listing"
while IFS= read -r -d '' entry; do
  read -r mode blob _ <<<"${entry%%$'\t'*}"
  [ "$mode" = 120000 ] || continue
  file="${entry#*$'\t'}"
  target="$(git -C "$repo" cat-file -p "$blob")"
  case "$target" in
    /* | [A-Za-z]:[\\/]*)
      printf 'check-portable-symlinks: tracked symlink has an absolute target: %s -> %s\n' "$file" "$target" >&2
      found=1
      ;;
  esac
done <"$listing"
if [ "$found" -ne 0 ]; then
  printf 'check-portable-symlinks: make these links relative or stop tracking them (git rm --cached).\n' >&2
  exit 1
fi
