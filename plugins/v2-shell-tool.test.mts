// OpenCode 2 renamed the shell tool from `bash` to `shell`. Every guard that inspects shell
// commands must fire for both names, in the V1 plugins and in their V2 ports.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isShellTool } from "./lib/tool-names.ts";
import SecretFileGuardV1 from "./secret-file-guard.ts";
import secretFileGuard from "./secret-file-guard/index.ts";
import autonomy from "./autonomy/index.ts";
import codeMemory from "./code-memory/index.ts";
import toolBudget from "./tool-budget/index.ts";

type Hook = (event: Record<string, unknown>) => unknown;

// The slice of the V2 plugin context these plugins use. Each hook registration is kept by name.
const fakeContext = (directory: string) => {
  const hooks = new Map<string, Hook[]>();
  const add = (name: string, hook: Hook) => {
    hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    return Promise.resolve({ dispose: () => Promise.resolve() });
  };
  const ctx = {
    location: { directory, project: { id: "p", directory, canonical: directory } },
    app: { version: "2.2.7" },
    tool: {
      hook: (name: string, hook: Hook) => add(`tool.${name}`, hook),
      transform: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    },
    session: {
      hook: (name: string, hook: Hook) => add(`session.${name}`, hook),
      get: () => Promise.resolve({ parentID: undefined }),
      list: () => Promise.resolve({ data: [] }),
      prompt: () => Promise.resolve({}),
    },
    shell: { hook: (name: string, hook: Hook) => add(`shell.${name}`, hook) },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    },
  };
  const run = async (name: string, event: Record<string, unknown>) => {
    for (const hook of hooks.get(name) ?? []) await hook(event);
  };
  return { ctx, run };
};

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "v2-shell-"));

test("the shell tool is `shell` in OpenCode 2 and `bash` in OpenCode 1", () => {
  assert.equal(isShellTool("shell"), true);
  assert.equal(isShellTool("bash"), true);
  assert.equal(isShellTool("Shell"), true);
  for (const tool of ["read", "grep", "question", "", undefined]) {
    assert.equal(isShellTool(tool), false);
  }
});

test("the V1 secret file guard blocks a .env read through the shell tool", async () => {
  const hooks = await SecretFileGuardV1({ directory: scratch() } as never);
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "shell", sessionID: "s", callID: "c" }, { args: { command: "cat .env" } }),
    /secret-file-guard/,
  );
});

test("the V2 secret file guard blocks a .env read through the shell tool", async () => {
  const { ctx, run } = fakeContext(scratch());
  await secretFileGuard.setup(ctx as never);
  await assert.rejects(
    run("tool.execute.before", { tool: "shell", sessionID: "s", input: { command: "cat .env" } }),
    /secret-file-guard/,
  );
  await run("tool.execute.before", { tool: "shell", sessionID: "s", input: { command: "cat .env.example" } });
});

test("the V2 autonomy plugin runs the git guard on the shell tool", async () => {
  const directory = scratch();
  fs.mkdirSync(path.join(directory, ".claude", "state"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".claude", "state", "autonomy.on"), "");
  fs.mkdirSync(path.join(directory, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, ".claude", "hooks", "autonomy-git-guard.sh"),
    `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no raw worktree removal"}}'\n`,
  );
  const { ctx, run } = fakeContext(directory);
  await autonomy.setup(ctx as never);
  await assert.rejects(
    run("tool.execute.before", { tool: "shell", sessionID: "s", input: { command: "git worktree remove x" } }),
    /no raw worktree removal/,
  );
});

test("the V2 code-memory gate never breaks a read tool call", async () => {
  const previous = process.env.FMFLURRY_CODEMEMORY;
  process.env.FMFLURRY_CODEMEMORY = "on";
  try {
    const { ctx, run } = fakeContext(scratch());
    await codeMemory.setup(ctx as never);
    for (const tool of ["read", "grep", "glob", "shell"]) {
      await run("tool.execute.before", { tool, sessionID: "s", input: {} });
    }
  } finally {
    if (previous === undefined) delete process.env.FMFLURRY_CODEMEMORY;
    else process.env.FMFLURRY_CODEMEMORY = previous;
  }
});

test("the V2 tool budget counts exploratory shell calls", async () => {
  const { ctx, run } = fakeContext(scratch());
  await toolBudget.setup(ctx as never);
  for (let call = 0; call < 3; call += 1) {
    await run("tool.execute.before", { tool: "shell", sessionID: "s", input: { command: "ls src" } });
  }
  const context = { sessionID: "s", system: [] as { type: string; text: string }[] };
  await run("session.context", context);
  assert.match(context.system[0]?.text ?? "", /Exploratory budget hit/);
});
