import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin";

import {
  GATE_TIMEOUT_MS,
  bashGuardRejection,
  blockReason,
  projectHookDirs,
  runHook,
  runHookText,
  visualReportRejection,
} from "../lib/autonomy-hooks.ts";
import { emitKpi } from "../lib/kpi-emit.ts";
import { isShellTool } from "../lib/tool-names.ts";

const AUTONOMY_FLAG = ".claude/state/autonomy.on";
const NOTIFY_SCRIPT = path.join(os.homedir(), ".config/opencode/scripts/agent-harness/notify.sh");
const ASK_DENIED =
  "Autonomous mode: decide yourself, log the assumption to the file `agent-harness goal decisions-path` prints, continue.";

/** Fire-and-forget desktop notification; failures are never surfaced. */
function runNotify(directory: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [NOTIFY_SCRIPT, "waiting", "OpenCode session idle"],
      { cwd: directory },
      () => resolve(),
    );
  });
}

export default Plugin.define({
  id: "autonomy",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const autonomyOn = (): boolean => fs.existsSync(path.join(directory, AUTONOMY_FLAG));
    const opts = { directory };

    const isSubagentSession = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await ctx.session.get({ sessionID });
        return Boolean(session.parentID);
      } catch {
        return true;
      }
    };

    const aborted = new Set<string>();
    const inFlight = new Set<string>();

    /**
     * Children of `sessionID` that still look busy. V2 keeps liveness in
     * `time.busy` / `time.idle` and finality in `outcome` rather than a
     * `status` string, so a child counts as running when it has not reached an
     * outcome and its last busy stamp is newer than its last idle stamp.
     */
    const runningSubagents = async (
      sessionID: string,
    ): Promise<Array<{ status: string; type: string }>> => {
      try {
        const page = await ctx.session.list({
          parentID: sessionID,
          directory,
          limit: 100,
        });
        return page.data
          .filter((row) => row.id !== sessionID)
          .filter((row) => row.outcome === undefined)
          .filter((row) => {
            const busy = row.time.busy;
            if (busy === undefined) return false;
            const idle = row.time.idle;
            return idle === undefined || idle <= busy;
          })
          .map((row) => ({
            status: "running",
            type: row.agent && row.agent.length > 0 ? row.agent : "subagent",
          }));
      } catch {
        return [];
      }
    };

    const runGate = async (sessionID: string): Promise<boolean> => {
      if (inFlight.has(sessionID)) return true;
      inFlight.add(sessionID);
      try {
        const reason = blockReason(
          await runHook(
            "ship-stop-gate.sh",
            {
              session_id: sessionID,
              hook_event_name: "Stop",
              subagents: await runningSubagents(sessionID),
            },
            { ...opts, timeoutMs: GATE_TIMEOUT_MS },
          ),
        );
        if (!reason) return false;
        await ctx.session.prompt({ sessionID, text: reason });
        return true;
      } catch {
        return false;
      } finally {
        inFlight.delete(sessionID);
      }
    };

    await ctx.session.hook("context", async (event) => {
      if (!autonomyOn()) return;
      const context = await runHookText("autonomy-context.sh", {}, opts);
      if (context) event.system.push({ type: "text", text: context });
    });

    await ctx.tool.hook("execute.before", async (event) => {
      const tool = event.tool?.toLowerCase();
      if (tool === "question" && autonomyOn()) {
        emitKpi(directory, ["guard_block", "guard=ask"]);
        throw new Error(ASK_DENIED);
      }
      if (!isShellTool(tool)) return;
      const args = event.input as { command?: unknown; workdir?: unknown } | null;
      if (typeof args?.command !== "string") return;
      // Each OpenCode 2 shell call names its own workdir; the guards judge that checkout. The guard
      // scripts still come from the session's checkout and the install, so a workdir holding its
      // own .claude/hooks cannot swap in a permissive guard.
      const where =
        typeof args.workdir === "string" && args.workdir.length > 0
          ? path.resolve(directory, args.workdir)
          : directory;
      const checkout = { directory: where, dirs: projectHookDirs(directory) };

      const reason = await bashGuardRejection(
        { tool_input: { command: args.command }, cwd: where },
        checkout,
      );
      if (reason) throw new Error(reason);

      const visual = await visualReportRejection(
        { tool_input: { command: args.command }, cwd: where },
        checkout,
      );
      if (visual) throw new Error(visual);
    });

    await ctx.session.hook("prompt", (event) => {
      aborted.delete(event.sessionID);
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event.data as { sessionID?: string } | undefined;
        const sessionID = data?.sessionID;

        if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
          if (sessionID) aborted.add(sessionID);
          continue;
        }
        if (event.type === "session.status") {
          const status = (event.data as { status?: { type?: string } } | undefined)?.status;
          if (sessionID && status?.type === "busy") aborted.delete(sessionID);
          continue;
        }
        if (event.type !== "session.idle") continue;

        if (sessionID && !aborted.has(sessionID) && autonomyOn() && !(await isSubagentSession(sessionID))) {
          if (await runGate(sessionID)) continue;
        }

        await runNotify(directory);
      }
    })();

    return () => controller.abort();
  },
});
