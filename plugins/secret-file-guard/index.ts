/**
 * Secret File Guard — V2 port of the OpenCode V1 plugin.
 *
 * Gap being closed: declarative permission config (`opencode.jsonc`
 * `permissions`) only matches literal command strings, and there is no
 * glob-pattern gate for the `read` tool. That means a subagent can read a live
 * secret via the `read` tool, or via `bash cat .env` in any form the
 * declarative shell patterns don't happen to match.
 *
 * This plugin HARD-BLOCKS (throws in `tool.execute.before`, which aborts the
 * tool call) regardless of the declarative permission config:
 *   - `read` tool: denies when input.filePath is a secret-bearing .env file.
 *   - `bash` tool: denies when input.command references a .env secret file
 *     AND passes it to a text-reading utility, anywhere in the command string.
 *
 * `.env.example` / `.env.sample` / `.env.template` are explicitly exempt.
 */
import { Plugin } from "@opencode/plugin";
import { emitKpi } from "../lib/kpi-emit.ts";
import { isShellTool } from "../lib/tool-names.ts";

const ALLOWED_ENV_VARIANT_RE =
  /(^|\/)\.env\.(example|sample|template)(\.[A-Za-z0-9_-]+)?$/;
const ENV_SECRET_PATH_RE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;

const READ_UTIL_RE =
  /(^|[|&;\s])(cat|less|more|head|tail|grep|egrep|fgrep|awk|sed|sort|uniq|xxd|od|strings|nl|cut)([\s]|$)/;
const PY_OPEN_RE = /python[0-9.]*\s+-c|open\s*\(/;

function isAllowedEnvVariant(path: string): boolean {
  return ALLOWED_ENV_VARIANT_RE.test(path);
}

/** True if `path` is a secret-bearing .env file and NOT an allowed variant. */
function isEnvSecretPath(path: string): boolean {
  if (!path) return false;
  if (isAllowedEnvVariant(path)) return false;
  return ENV_SECRET_PATH_RE.test(path);
}

/** True if the bash command references a .env secret AND reads it with a text utility. */
function commandReadsEnvSecret(cmd: string): boolean {
  if (!cmd || !cmd.includes(".env")) return false;

  const sanitized = cmd
    .replaceAll(".env.example", "")
    .replaceAll(".env.sample", "")
    .replaceAll(".env.template", "");
  if (!sanitized.includes(".env")) return false;

  return READ_UTIL_RE.test(cmd) || PY_OPEN_RE.test(cmd);
}

function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export default Plugin.define({
  id: "secret-file-guard",
  async setup(ctx) {
    const directory = ctx.location.directory;

    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "read") {
        const filePath = stringArg(event.input, "filePath");
        if (isEnvSecretPath(filePath)) {
          emitKpi(directory, ["guard_block", "guard=secret"]);
          throw new Error(
            `[secret-file-guard] BLOCKED: read of secret-bearing file "${filePath}" is denied ` +
              `(.env/.env.* are off-limits; .env.example/.env.sample/.env.template remain readable).`,
          );
        }
      }

      if (isShellTool(event.tool)) {
        const command = stringArg(event.input, "command");
        if (commandReadsEnvSecret(command)) {
          emitKpi(directory, ["guard_block", "guard=secret"]);
          throw new Error(
            `[secret-file-guard] BLOCKED: command reads a .env secret file via a text utility ` +
              `(rewritten/wrapped forms included). Command: ${command}`,
          );
        }
      }
    });
  },
});
