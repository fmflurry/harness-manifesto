/**
 * code-memory OpenCode plugin.
 *
 * Retrieval remains an explicit agent action. This plugin only reminds agents
 * to use that explicit action before broad filesystem exploration.
 */
import { Plugin } from "@opencode/plugin";

import { resolveCodememory } from "../code-memory-lib/mode.ts";

const GATED_READ_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "shell", "grep", "glob"]);
const MEMORY_TOOL_PREFIXES: readonly string[] = [
  "codememory_",
  "code-memory_",
  "code_memory_",
  "mcp__code-memory__",
];
const DESCRIPTION_PREFIX =
  "For repo/code/docs orientation, call code-memory MCP first: use codememory_retrieve before grep/glob/read/bash, then verify exhaustively. ";

function isMemoryTool(tool: string): boolean {
  const lower = tool.toLowerCase();
  return MEMORY_TOOL_PREFIXES.some((prefix) => lower.includes(prefix));
}

export default Plugin.define({
  id: "code-memory",
  async setup(ctx) {
    let enabled = false;
    try {
      enabled = (await resolveCodememory()).enabled;
    } catch {
      enabled = false;
    }
    if (!enabled) return;

    const explicitBySession = new Set<string>();

    await ctx.tool.hook("execute.after", (event) => {
      if (event.sessionID && isMemoryTool(event.tool ?? "")) {
        explicitBySession.add(event.sessionID);
      }
    });

    await ctx.tool.hook("execute.before", (event) => {
      const tool = (event.tool ?? "").toLowerCase();
      if (!GATED_READ_TOOLS.has(tool) || !event.sessionID) return;
      if (explicitBySession.has(event.sessionID)) return;
      // V2 has no app log API; the server log keeps plugin console output.
      console.warn(`code-memory gate: ${tool} called without explicit code-memory retrieval`);
    });

    // V1's `tool.definition` hook is a tool transform in V2. It re-applies to
    // later registrations, including MCP catalogs that refresh after setup.
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (!GATED_READ_TOOLS.has(tool.id.toLowerCase())) continue;
        editor.update(tool.id, (draft) => {
          if (!draft.description.startsWith(DESCRIPTION_PREFIX)) {
            draft.description = `${DESCRIPTION_PREFIX}${draft.description}`;
          }
        });
      }
    });
  },
});
