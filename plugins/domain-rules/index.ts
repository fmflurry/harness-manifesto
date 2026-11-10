// OpenCode side of the domain-rules hook. Off unless the project opts in.
import { Plugin } from "@opencode/plugin";
import { decideDomainRules, executeDomainRules } from "../lib/domain-rules.ts";

const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

export default Plugin.define({
  id: "domain-rules",
  async setup(ctx) {
    const directory = ctx.location.directory;

    await ctx.tool.hook("execute.before", (event) => {
      const tool = (event.tool ?? "").toLowerCase();
      if (!EDIT_TOOLS.has(tool)) return;

      const result = executeDomainRules(decideDomainRules(directory), {
        input: JSON.stringify({ tool, args: event.input ?? {} }),
      });
      if (result.code !== 0) {
        throw new Error(`[domain-rules] ${result.stderr.trim() || "project script failed"}`);
      }
    });
  },
});
