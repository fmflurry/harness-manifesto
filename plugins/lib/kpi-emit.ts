import { spawn } from "node:child_process";
import { hookPath, projectHookDirs } from "./autonomy-hooks.ts";

const SAFE_ARG = /^[A-Za-z0-9._:=-]{1,80}$/;

export type KpiHint = {
  cwd?: string;
  command?: string;
  file?: string;
};

/** Fire-and-forget append to the local KPI log. Never throws, never logs tool args. */
export function emitKpi(directory: string, args: string[], hint?: KpiHint): void {
  if (process.env.AGENT_HARNESS_KPI === "0") return;
  if (process.env.AGENT_HARNESS_TEST === "1" && !process.env.AGENT_HARNESS_KPI_LOG) return;
  const hook = hookPath("kpi-emit.sh", projectHookDirs(directory));
  if (!hook) return;
  const safe = args.filter((arg) => SAFE_ARG.test(arg));
  if (safe.length === 0) return;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_HARNESS_TOOL: "opencode",
    AGENT_HARNESS_KPI: "1",
  };
  if (hint?.cwd) env.AGENT_HARNESS_KPI_CWD = hint.cwd;
  if (hint?.command) env.AGENT_HARNESS_KPI_COMMAND = hint.command;
  if (hint?.file) env.AGENT_HARNESS_KPI_FILE = hint.file;
  try {
    const child = spawn("bash", [hook, ...safe], {
      cwd: directory,
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", () => undefined);
  } catch {
    /* fail open */
  }
}
