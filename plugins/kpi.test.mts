import assert from "node:assert/strict";
import test from "node:test";
import {
  attributionOf,
  createKpiState,
  onMessageUpdated,
  onOpenCodeEvent,
  onOpenCodeV2,
  onSessionEnded,
  onToolAfter,
  onToolBefore,
  sanitiseSkill,
  sessionFallback,
  skillFrom,
  usageTokens,
} from "./lib/kpi-capture.ts";

test("shell attribution names the workdir and command without putting them in KPI args", () => {
  const hint = attributionOf("bash", {
    command: "git -C /wt status SUPER_SECRET",
    workdir: "wt",
  }, "/session");
  assert.equal(hint.cwd, "/session/wt");
  assert.match(hint.command, /git -C \/wt status/);
  assert.equal(hint.file, "");
  const file = attributionOf("read", { filePath: "/wt/README.md", note: "SUPER_SECRET" }, "/session");
  assert.equal(file.file, "/wt/README.md");
  assert.equal(file.command, "");
  assert.equal(file.cwd, "/session");
});

test("usage sums input and output and ignores cache and reasoning", () => {
  assert.equal(usageTokens({
    tokens: { input: 3, output: 4, reasoning: 9, cache: { read: 5, write: 1 } },
  }), 7);
  assert.equal(usageTokens({ usage: { input_tokens: 1, output_tokens: 2 } }), 3);
  assert.equal(usageTokens({ tokens: { input: "nope", output: 2 } }), 2);
  assert.equal(usageTokens({ tokens: Number.NaN }), null);
  assert.equal(usageTokens({ text: "SUPER_SECRET_PROMPT" }), null);
});

test("skill names are lowercase tokens and paths are dropped", () => {
  assert.equal(sanitiseSkill("Fix-CI"), "fix-ci");
  assert.equal(sanitiseSkill("/OpsX:Archive"), "opsx:archive");
  assert.equal(sanitiseSkill("../etc/passwd"), "");
  assert.equal(sanitiseSkill("has space"), "");
  assert.equal(sanitiseSkill("Under_score"), "");
});

test("OpenCode message usage lands on the session end and the subagent stop", () => {
  const root = createKpiState();
  const created = onOpenCodeEvent(root, {
    type: "session.created",
    properties: { info: { id: "root-1" } },
  });
  assert.deepEqual(created, [["session_start", "session=root-1"]]);
  onMessageUpdated(root, {
    info: {
      id: "msg-1",
      sessionID: "root-1",
      role: "assistant",
      tokens: { input: 1, output: 1, reasoning: 8 },
      finish: null,
    },
  });
  assert.deepEqual(onOpenCodeEvent(root, {
    type: "message.updated",
    properties: {
      info: {
        id: "msg-1",
        sessionID: "root-1",
        tokens: { input: 2, output: 5 },
        finish: "stop",
        text: "SUPER_SECRET_PROMPT",
      },
    },
  }), []);
  onMessageUpdated(root, {
    info: { id: "msg-2", sessionID: "root-1", usage: { input_tokens: 1, output_tokens: 1 } },
  });
  assert.deepEqual(onSessionEnded(root, { info: { id: "root-1" } }), [
    "session_end",
    "session=root-1",
    "tokens=9",
  ]);

  const child = createKpiState();
  assert.deepEqual(onOpenCodeEvent(child, {
    type: "session.created",
    properties: { info: { id: "child-1", parentID: "root-1", agent: "coder" } },
  }), [["subagent_spawn", "session=child-1", "agent=coder"]]);
  onOpenCodeEvent(child, {
    type: "message.updated",
    properties: {
      info: {
        id: "msg-c",
        sessionID: "child-1",
        mode: "coder",
        tokens: { input: 4, output: 6 },
        prompt: "SUPER_SECRET_PROMPT",
      },
    },
  });
  assert.deepEqual(onOpenCodeEvent(child, {
    type: "session.idle",
    properties: { sessionID: "child-1" },
  }), [["subagent_stop", "session=child-1", "agent=coder", "tokens=10"]]);
});

test("OpenCode 2 skill id and session location reach the KPI args", () => {
  assert.equal(skillFrom({ id: "why" }), "why");
  const state = createKpiState();
  const opened = onOpenCodeV2(state, {
    type: "session.created",
    location: { directory: "/main" },
    data: {
      sessionID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      parentID: undefined,
      location: { directory: "/wt" },
      agent: "build",
      title: "SUPER_SECRET_PROMPT",
    },
  });
  assert.equal(opened.cwd, "/wt");
  assert.deepEqual(opened.batches, [[
    "session_start",
    "session=ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ]]);
  assert.equal(sessionFallback(state, "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", "/main"), "/wt");
  onOpenCodeV2(state, {
    type: "session.usage.recorded",
    data: {
      sessionID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      tokens: { input: 3, output: 8, reasoning: 9, cache: { read: 5, write: 1 } },
    },
  });
  const ended = onOpenCodeV2(state, {
    type: "session.idle",
    data: { sessionID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  assert.deepEqual(ended.batches, [[
    "session_end",
    "session=ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "tokens=11",
  ]]);
  const busIdle = onOpenCodeV2(state, {
    type: "session.idle",
    location: { directory: "/main" },
    data: { sessionID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  assert.equal(busIdle.cwd, "/wt");
  const quietIdle = onOpenCodeV2(state, {
    type: "session.idle",
    data: { sessionID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  assert.equal(quietIdle.cwd, "/wt");
  assert.equal(sessionFallback(state, "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", "/main"), "/wt");
  const skill = onToolBefore(state, {
    tool: "skill",
    sessionID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    callID: "call-1",
  }, { id: "why" }, 1000);
  assert.deepEqual(skill, [[
    "tool_call",
    "tool_name=skill",
    "session=ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "skill=why",
  ]]);
  assert.equal(JSON.stringify(opened).includes("SUPER_SECRET"), false);
  const read = attributionOf("read", { path: "README.md" }, sessionFallback(state, "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", "/main"));
  assert.equal(read.cwd, "/wt");
  assert.equal(read.file, "README.md");
});

test("OpenCode tool hooks record skill, agent, duration, and ok without args", () => {
  const state = createKpiState();
  const before = onToolBefore(state, { tool: "skill", sessionID: "s1", callID: "c1" }, {
    skill: "Show-Me",
    args: "SUPER_SECRET_PROMPT",
  }, 1000);
  assert.deepEqual(before, [["tool_call", "tool_name=skill", "session=s1", "skill=show-me"]]);
  const after = onToolAfter(state, {
    tool: "skill",
    sessionID: "s1",
    callID: "c1",
    args: { command: "/show-me", prompt: "SUPER_SECRET_PROMPT" },
  }, { output: "SUPER_SECRET_OUTPUT" }, 1012);
  assert.deepEqual(after, [
    "tool_result",
    "tool_name=skill",
    "ok=true",
    "session=s1",
    "duration_ms=12",
    "skill=show-me",
  ]);
  assert.equal(JSON.stringify(after).includes("SUPER_SECRET"), false);

  const spawn = onToolBefore(state, { tool: "task", sessionID: "s1", callID: "c2" }, {
    subagent_type: "code-reviewer",
    prompt: "SUPER_SECRET_PROMPT",
    description: "/var/secret/abs",
  }, 2000);
  assert.deepEqual(spawn, [
    ["tool_call", "tool_name=task", "session=s1", "agent=code-reviewer"],
    ["subagent_spawn", "tool_name=task", "session=s1", "agent=code-reviewer"],
  ]);
  const failed = onToolAfter(state, {
    tool: "bash",
    sessionID: "s1",
    callID: "missing",
    args: { command: "SUPER_SECRET_PROMPT" },
  }, { error: "secret failure text" }, 2100);
  assert.deepEqual(failed, ["tool_result", "tool_name=bash", "ok=false", "session=s1"]);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(JSON.stringify(spawn).includes("SUPER_SECRET"), false);
  assert.equal(JSON.stringify(spawn).includes("/var/secret"), false);
});
