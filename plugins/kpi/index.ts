import { Plugin } from "@opencode/plugin";
import { emitKpi } from "../lib/kpi-emit.ts";
import {
  attributionOf,
  createKpiState,
  onOpenCodeEvent,
  onToolAfter,
  onToolBefore,
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
    const emit = (batches: string[][]): void => {
      for (const args of batches) {
        if (args.length > 0) emitKpi(directory, args);
      }
    };

    await ctx.tool.hook("execute.before", (event) => {
      try {
        const hint = attributionOf(event.tool, event.input, directory);
        for (const args of onToolBefore(
          state,
          { tool: event.tool, sessionID: event.sessionID, callID: event.id },
          event.input,
        )) {
          if (args.length > 0) emitKpi(directory, args, hint);
        }
      } catch {
        /* fail open */
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      try {
        const hint = attributionOf(event.tool, event.input, directory);
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
        /* fail open */
      }
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const rec = asRecord(event);
          if (!rec) continue;
          const type = rec.type;
          const data = asRecord(rec.data) ?? {};

          if (type === "session.created") {
            emit(
              onOpenCodeEvent(state, {
                type,
                properties: {
                  sessionID: data.sessionID,
                  info: {
                    id: data.sessionID,
                    parentID: data.parentID,
                    title: data.title,
                    mode: data.agent,
                  },
                },
              }),
            );
            continue;
          }

          if (type === "session.idle" || type === "session.deleted") {
            emit(onOpenCodeEvent(state, { type, properties: { sessionID: data.sessionID } }));
            continue;
          }

          if (type === "session.usage.updated" || type === "session.usage.recorded") {
            onOpenCodeEvent(state, {
              type: "message.updated",
              properties: {
                info: { sessionID: data.sessionID, id: "latest", tokens: data.tokens },
              },
            });
          }
        } catch {
          /* fail open */
        }
      }
    })();

    return () => controller.abort();
  },
});
