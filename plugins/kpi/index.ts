import { Plugin } from "@opencode/plugin";
import { emitKpi } from "../lib/kpi-emit.ts";
import {
  attributionOf,
  createKpiState,
  onOpenCodeV2,
  onToolAfter,
  onToolBefore,
  sessionFallback,
} from "../lib/kpi-capture.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * OpenCode side of the harness KPI log.
 * Records session boundaries, skill names, subagent types, and tool results.
 *
 * V2 replaced the `message.updated`/`properties` event family with
 * `session.usage.*` and a `data` payload, so this plugin adapts the V2 event
 * into the props shape the shared reducer already understands.
 */
export default Plugin.define({
  id: "kpi",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const state = createKpiState();

    await ctx.tool.hook("execute.before", (event) => {
      try {
        const hint = attributionOf(
          event.tool,
          event.input,
          sessionFallback(state, event.sessionID, directory),
        );
        for (const args of onToolBefore(
          state,
          { tool: event.tool, sessionID: event.sessionID, callID: event.id },
          event.input,
        )) {
          if (args.length > 0) emitKpi(directory, args, hint);
        }
      } catch {
        console.error("kpi: event dropped");
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      try {
        const hint = attributionOf(
          event.tool,
          event.input,
          sessionFallback(state, event.sessionID, directory),
        );
        const args = onToolAfter(
          state,
          {
            tool: event.tool,
            sessionID: event.sessionID,
            callID: event.id,
            args: event.input,
          },
          event,
        );
        if (args.length > 0) emitKpi(directory, args, hint);
      } catch {
        console.error("kpi: event dropped");
      }
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const rec = asRecord(event);
          if (!rec) continue;
          const adapted = onOpenCodeV2(state, rec);
          const hint = adapted.cwd ? { cwd: adapted.cwd } : undefined;
          for (const args of adapted.batches) {
            if (args.length > 0) emitKpi(directory, args, hint);
          }
        } catch {
          console.error("kpi: event dropped");
        }
      }
    })();

    return () => controller.abort();
  },
});
