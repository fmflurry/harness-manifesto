#!/usr/bin/env bash
# Fails when the repository tracks a symlink whose target is an absolute path: such a link
# only resolves on the machine that created it.
set -euo pipefail
repo="${1:-.}"
found=0
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
done < <(git -C "$repo" ls-files -s -z)
if [ "$found" -ne 0 ]; then
  printf 'check-portable-symlinks: make these links relative or stop tracking them (git rm --cached).\n' >&2
  exit 1
fi
