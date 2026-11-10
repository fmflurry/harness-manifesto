import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export default Plugin.define({
  id: "commit-provenance",
  async setup(ctx) {
    const directory = ctx.location.directory;
    // plugins/commit-provenance/index.ts -> the config root.
    const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const localRoot = path.join(directory, ".opencode");
    const isLocal = (() => {
      try {
        return fs.realpathSync(ownRoot) === fs.realpathSync(localRoot);
      } catch {
        return false;
      }
    })();

    let target = ownRoot;
    if (!fs.existsSync(path.join(target, ".harness-provenance.json")) && !isLocal) {
      const sourceRuntime = path.join(os.homedir(), ".agent-harness/opencode-source");
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(sourceRuntime, ".harness-provenance.json"), "utf8"),
        ) as { assetRoot?: string };
        if (record.assetRoot && fs.realpathSync(record.assetRoot) === fs.realpathSync(ownRoot)) {
          target = sourceRuntime;
        }
      } catch {
        /* missing or unrelated source installation */
      }
    }

    // V2's shell hook has no sessionID field. OpenCode exports the session that
    // owns the shell in the environment it is about to create; fall back to the
    // server process environment when the shell is not session-scoped.
    await ctx.shell.hook("create.before", (event) => {
      const sessionID =
        event.env.OPENCODE_SESSION_ID ?? process.env.OPENCODE_SESSION_ID ?? "";
      if (!sessionID) return;
      if (!SESSION_ID_RE.test(sessionID)) {
        throw new Error("commit-provenance: invalid session id");
      }
      if (!isLocal && event.env.HARNESS_PROVENANCE_SCOPE === "local") return;

      const hooks = path.join(target, "scripts/agent-harness/git-hooks");
      const previous = event.env.HARNESS_HOOK_CONFIG_INDEX ?? process.env.HARNESS_HOOK_CONFIG_INDEX;
      const count = Number(previous ?? event.env.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("commit-provenance: invalid GIT_CONFIG_COUNT");
      }
      if (!fs.existsSync(path.join(hooks, "prepare-commit-msg"))) {
        throw new Error("commit-provenance: installed hooks are missing; reinstall the harness");
      }

      Object.assign(event.env, {
        HARNESS_HOOK_CONFIG_INDEX: String(count),
        HARNESS_PROVENANCE_SCOPE: isLocal ? "local" : "global",
        [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
        [`GIT_CONFIG_VALUE_${count}`]: hooks,
        GIT_CONFIG_COUNT: String(count + 1),
        HARNESS_SESSION_ID: sessionID,
        HARNESS_VERSION: "@target",
        HARNESS_SHA: target,
      });
    });
  },
});
