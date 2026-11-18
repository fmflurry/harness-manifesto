#!/usr/bin/env bash
#
# install-vibe.sh — build the harness for Mistral Vibe and install it into ~/.vibe
#
# Flags:
#   --variant NAME     monolith (default) or conductor. orchestration is an alias.
#   --migrate-legacy   Also remove the old hand-ported agents, prompts and skills
#   --no-backup        Skip the backup of ~/.vibe
#   --uninstall        Remove what the last install put in ~/.vibe
#   --status           Print the installed variant and exit
#   --help, -h
#
set -euo pipefail

REPO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
VIBE_HOME="${VIBE_HOME:-$HOME/.vibe}"
MANIFEST="$VIBE_HOME/.harness-manifest.json"

VARIANT="${HARNESS_VARIANT:-}"
DO_MIGRATE=0
NO_BACKUP=0
DO_UNINSTALL=0
DO_STATUS=0

step() { printf "\n==> %s\n" "$*"; }
ok()   { printf "    OK   %s\n" "$*"; }
err()  { printf "    ERR  %s\n" "$*" >&2; }

print_help() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --variant)        VARIANT="${2:-}"; shift ;;
        --variant=*)      VARIANT="${1#--variant=}" ;;
        --migrate-legacy) DO_MIGRATE=1 ;;
        --no-backup)      NO_BACKUP=1 ;;
        --uninstall)      DO_UNINSTALL=1 ;;
        --status)         DO_STATUS=1 ;;
        --help|-h)        print_help; exit 0 ;;
        *) err "unknown flag: $1"; print_help; exit 2 ;;
    esac
    shift
done

if [ "$DO_MIGRATE" = "1" ] && [ "$NO_BACKUP" = "1" ]; then
    err "--migrate-legacy removes every real skill dir in $VIBE_HOME/skills; it needs the backup"
    exit 2
fi

if [ "$DO_STATUS" = "1" ]; then
    if [ -f "$VIBE_HOME/.harness-variant" ]; then
        printf 'vibe: %s %s\n' "$VIBE_HOME" "$(cat "$VIBE_HOME/.harness-variant")"
    else
        printf 'vibe: %s (not installed)\n' "$VIBE_HOME"
    fi
    exit 0
fi

for dir in agents prompts skills; do
    if [ -L "$VIBE_HOME/$dir" ]; then
        err "$VIBE_HOME/$dir is a symlink; refusing to prune or write through it"
        exit 1
    fi
done

command -v node >/dev/null 2>&1 || { err "node is required"; exit 1; }
VIBE_BIN="$(command -v vibe || true)"
[ -n "$VIBE_BIN" ] || { err "vibe is not on PATH (install mistral-vibe first)"; exit 1; }
VIBE_PY="$(head -1 "$VIBE_BIN" | sed 's/^#!//')"
"$VIBE_PY" -c 'import tomli_w, vibe' 2>/dev/null || { err "cannot import vibe/tomli_w with $VIBE_PY"; exit 1; }

# Removes what the previous install recorded; with --migrate-legacy, also the
# untracked hand port (agents whose prompt id is their own name, real skill dirs).
prune_previous() {
    MANIFEST="$MANIFEST" VIBE_HOME="$VIBE_HOME" DO_MIGRATE="$DO_MIGRATE" "$VIBE_PY" - <<'PY'
import json, os, re, shutil, tomllib
from pathlib import Path

home = Path(os.environ["VIBE_HOME"])
manifest = Path(os.environ["MANIFEST"])
agents, skills = set(), set()
if manifest.is_file():
    data = json.loads(manifest.read_text())
    agents.update(data.get("agents", []))
    skills.update(data.get("skills", []))
if os.environ["DO_MIGRATE"] == "1":
    for f in (home / "agents").glob("*.toml"):
        if tomllib.loads(f.read_text()).get("system_prompt_id") == f.stem:
            agents.add(f.stem)
    if (home / "skills").is_dir():
        skills.update(p.name for p in (home / "skills").iterdir() if p.is_dir() and not p.is_symlink())
safe = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
agents = {n for n in agents if safe.fullmatch(n)}
skills = {n for n in skills if safe.fullmatch(n)}
for name in agents:
    (home / "agents" / f"{name}.toml").unlink(missing_ok=True)
    (home / "prompts" / f"{name}.md").unlink(missing_ok=True)
for name in skills:
    p = home / "skills" / name
    if p.is_symlink():
        continue
    shutil.rmtree(p, ignore_errors=True)
print(f"    pruned agents={len(agents)} skills={len(skills)}")
PY
}

# Replaces our MCP servers by name (current and previously installed), keeps the user's,
# and resets default_agent when it names an agent that no longer exists.
merge_config() {
    local servers="$1" remove="$2"
    SERVERS="$servers" REMOVE="$remove" VIBE_HOME="$VIBE_HOME" "$VIBE_PY" - <<'PY'
import json, os, tomllib, tomli_w
from pathlib import Path

home = Path(os.environ["VIBE_HOME"])
cfg_path = home / "config.toml"
cfg = tomllib.loads(cfg_path.read_text()) if cfg_path.is_file() else {}
ours = json.loads(os.environ["SERVERS"]) if os.environ["SERVERS"] else []
drop = {s["name"] for s in ours} | set(json.loads(os.environ["REMOVE"] or "[]"))
servers = [s for s in cfg.get("mcp_servers", []) if s.get("name") not in drop] + ours
builtins = {"default", "chat", "plan", "accept-edits", "auto-approve", "explore", "lean"}
agent = cfg.get("default_agent", "default")
reset = agent not in builtins and not (home / "agents" / f"{agent}.toml").is_file()
new_cfg = {**cfg, "mcp_servers": servers, **({"default_agent": "default"} if reset else {})}
tmp = cfg_path.with_suffix(".toml.tmp")
tmp.write_text(tomli_w.dumps(new_cfg))
os.chmod(tmp, cfg_path.stat().st_mode & 0o777 if cfg_path.is_file() else 0o600)
os.replace(tmp, cfg_path)
print(f"    mcp_servers={[s['name'] for s in servers]}" + (f" default_agent: {agent} -> default" if reset else ""))
PY
}

backup() {
    [ "$NO_BACKUP" = "1" ] && return 0
    local dest item
    dest="$VIBE_HOME/_pre_install_backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dest"
    for item in AGENTS.md agents prompts skills config.toml; do
        [ -e "$VIBE_HOME/$item" ] && cp -pR "$VIBE_HOME/$item" "$dest/$item"
    done
    ok "backup at $dest"
}

previous_mcp() {
    [ -f "$MANIFEST" ] && node -e 'console.log(JSON.stringify(require(process.argv[1]).mcp ?? []))' "$MANIFEST" || echo '[]'
}

if [ "$DO_UNINSTALL" = "1" ]; then
    step "Uninstall from $VIBE_HOME"
    [ -f "$MANIFEST" ] || { ok "nothing recorded"; exit 0; }
    backup
    remove="$(previous_mcp)"
    prune_previous
    merge_config "" "$remove"
    rm -f "$VIBE_HOME/AGENTS.md" "$VIBE_HOME/.harness-variant" "$MANIFEST"
    ok "removed"
    exit 0
fi

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

step "Build"
BASE_PROMPT="$("$VIBE_PY" -c 'import vibe, pathlib; print(pathlib.Path(vibe.__file__).parent / "core/prompts/cli.md")')"
args=(--out "$BUILD/vibe" --base-prompt "$BASE_PROMPT")
[ -n "$VARIANT" ] && args+=(--variant "$VARIANT")
node "$REPO_DIR/scripts/build-vibe.mjs" "${args[@]}"

step "Install -> $VIBE_HOME"
mkdir -p "$VIBE_HOME/agents" "$VIBE_HOME/prompts" "$VIBE_HOME/skills"
backup
remove="$(previous_mcp)"
prune_previous
for skill in "$BUILD/vibe/skills/"*/; do
    name="$(basename "$skill")"
    rm -rf "${VIBE_HOME:?}/skills/$name"
    cp -R "$skill" "$VIBE_HOME/skills/$name"
done
for f in "$BUILD/vibe/agents/"*.toml "$BUILD/vibe/prompts/"*.md; do
    dest="$VIBE_HOME/$(basename "$(dirname "$f")")/$(basename "$f")"
    rm -f "$dest"
    cp "$f" "$dest"
done
cp "$BUILD/vibe/AGENTS.md" "$BUILD/vibe/.harness-variant" "$BUILD/vibe/.harness-manifest.json" "$VIBE_HOME/"
merge_config "$(cat "$BUILD/vibe/mcp.json")" "$remove"
ok "installed $(cat "$VIBE_HOME/.harness-variant")"
