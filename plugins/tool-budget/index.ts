/**
 * Tool Budget Plugin — V2 port.
 *
 * Classifies each `bash` command per rules/common/tool-budget.md
 * (VERIFICATION vs EXPLORATORY — authoritative there) and counts
 * `write`/`edit`/`patch` calls as edits. Steers via the model context
 * (`session.hook("context")`), mirroring the pending-nudge drain pattern used
 * by code-memory. NEVER throws / blocks a tool call — this plugin only nudges.
 *
 *   L1 — 3rd exploratory bash call with 0 edits so far.
 *   L2 — exploratory:edit ratio > 3 once >=5 edits have happened.
 *
 * Allowlist-first: unknown bash commands default to NOT counted.
 */
import { Plugin } from "@opencode/plugin";

import { resolveCodememory } from "../code-memory-lib/mode.ts";
import { isShellTool } from "../lib/tool-names.ts";

type Category = "exploratory" | "edit" | null;

interface BudgetState {
  exploratory: number;
  edits: number;
  pendingNudge: string | null;
}

// --- VERIFICATION (uncapped, never counted, never nudged) ---
const VERIFICATION_RE =
  /(^|[|&;\s])(tsc|npm\s+run|pnpm\s+run|bun\s+run|yarn\s+run|cargo|go\s+build|mypy|pyright|mvn|gradlew|dotnet\s+(build|test|format)|eslint|ruff|clippy)(\s|$)/;
const GIT_STATE_RE = /(^|[|&;\s])git\s+(status|diff|log|stash|show)(\s|$)/;
const PROCESS_RE = /(^|[|&;\s])(lsof|netstat|ps)(\s|$)/;

// --- EXPLORATORY (counted): directory listing / content search / file inspection ---
const EXPLORATORY_RE =
  /(^|[|&;\s])(ls|find|tree|grep|rg|ag|cat|head|tail|wc|file|stat)(\s|$)/;
const RTK_EXPLORATORY_RE = /rtk\s+(ls|find|grep)(\s|$)/;

const EDIT_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "patch"]);

function isVerification(cmd: string): boolean {
  return VERIFICATION_RE.test(cmd) || GIT_STATE_RE.test(cmd) || PROCESS_RE.test(cmd);
}

function isExploratory(cmd: string): boolean {
  return RTK_EXPLORATORY_RE.test(cmd) || EXPLORATORY_RE.test(cmd);
}

/** Allowlist-first: unknown/unrecognized commands stay uncounted (null). */
function classifyBash(command: string): Category {
  if (!command) return null;
  if (isVerification(command)) return null;
  if (isExploratory(command)) return "exploratory";
  return null;
}

function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function stateFor(states: Map<string, BudgetState>, sessionID: string): BudgetState {
  let state = states.get(sessionID);
  if (!state) {
    state = { exploratory: 0, edits: 0, pendingNudge: null };
    states.set(sessionID, state);
  }
  return state;
}

export default Plugin.define({
  id: "tool-budget",
  async setup(ctx) {
    let memoryOn = true;
    try {
      memoryOn = (await resolveCodememory()).enabled;
    } catch {
      memoryOn = false;
    }
    const states = new Map<string, BudgetState>();

    await ctx.tool.hook("execute.before", (event) => {
      const tool = (event.tool ?? "").toLowerCase();
      const state = stateFor(states, event.sessionID);

      let category: Category = null;
      if (isShellTool(tool)) {
        category = classifyBash(stringArg(event.input, "command"));
      } else if (EDIT_TOOLS.has(tool)) {
        category = "edit";
      }

      if (category === "exploratory") state.exploratory += 1;
      if (category === "edit") state.edits += 1;

      if (category === "exploratory" && state.exploratory === 3 && state.edits === 0) {
        state.pendingNudge = memoryOn
          ? "Exploratory budget hit (3, 0 edits). Next call must be code-memory, Glob, or an Edit. " +
            "If the repo is not indexed, say so explicitly and continue."
          : "Exploratory budget hit (3, 0 edits). Next call must be Glob or an Edit. " +
            "If the repo is not indexed, say so explicitly and continue.";
        return;
      }

      if (state.edits >= 5 && state.exploratory > state.edits * 3) {
        state.pendingNudge =
          `Exploratory:edit ratio exceeds 3 at ${state.edits} edits ` +
          `(${state.exploratory} exploratory calls). Your next assistant message ` +
          "must contain one line: bash-budget: <why exploratory shell is still necessary>";
      }
    });

    await ctx.session.hook("context", (event) => {
      const state = states.get(event.sessionID);
      if (!state?.pendingNudge) return;
      event.system.push({ type: "text", text: state.pendingNudge });
      state.pendingNudge = null;
    });
  },
});
