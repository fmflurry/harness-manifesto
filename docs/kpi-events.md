# KPI event schema

Local JSONL log at `~/.agent-harness/kpi/events.jsonl`. `AGENT_HARNESS_KPI_LOG` changes the path. `AGENT_HARNESS_KPI=0` writes nothing. A missing `jq` exits 0 and writes nothing. Hooks never block the tool.

One JSON object per line. Unknown fields are ignored by `agent-harness kpi report`. The report counts `tool_call` only; `tool_result` does not add a tool call.

The log has no prompts, tool arguments, secrets, or absolute paths. `skill` and `agent` are the only free-text fields, and both must match the patterns below or they are dropped.

## Fields on every line

| Field | Type | Meaning |
| --- | --- | --- |
| `ts` | string | UTC time `YYYY-MM-DDTHH:MM:SSZ` |
| `kind` | string | One of the kinds below |
| `variant` | string | `conductor`, `monolith`, or `unknown`. `orchestration` is stored as `conductor` |
| `harness_version` | string | Plugin version, currently stamped from `AGENT_HARNESS_VERSION` |
| `tool` | string | `opencode`, `claude`, or `cursor`. A CLI event with no host signal is `unattributed` |
| `repo` | string | `owner/name` of the worktree the event ran in. Worktrees of one clone share that origin. Otherwise the repo directory name or a short hash |
| `branch` | string | Branch of that worktree (`git rev-parse --abbrev-ref HEAD`), or `unknown` |
| `session_id` | string | Host session id, or a short hash when the raw id is not a safe token. `unknown` when absent |
| `tokens` | number or null | Input tokens plus output tokens. Cache and reasoning are not included. Null when unknown |

## Optional fields

| Field | Type | When |
| --- | --- | --- |
| `tool_name` | string | Tool call or tool result. `^[A-Za-z0-9._:-]{1,64}$` |
| `skill` | string | Tool name is Skill, `skill`, `use_skill`, or `load_skill`. `^[a-z0-9:-]{1,64}$` after lowercasing and stripping a leading `/` |
| `agent` | string | `subagent_type` on Task/Agent (OpenCode: `task`) and on `subagent_spawn` / `subagent_stop`. `^[A-Za-z0-9._:-]{1,64}$` |
| `duration_ms` | number or null | On `tool_result`. Null when the host did not send a duration. Non-negative and below 24 hours |
| `ok` | boolean | On `tool_result`. False when the host reports an error; otherwise true |
| `guard` | string | `git`, `ask`, `secret`, `budget`, or `pr-visual-report` |
| `outcome` | string | `merged`, `blocked`, `escalated`, or `open` |
| `pr` | number | Pull request number |
| `review` | string | `code` or `security` |
| `verdict` | string | `pass` or `fail` |
| `important` | number | Important review findings |
| `nit` | number | Nit findings |
| `pre_existing` | number | Pre-existing findings |
| `fix_iterations` | number | Fix rounds |
| `task` | string | Eval task id |
| `task_kind` | string | Eval task kind |
| `pass` | boolean | Eval checker passed |
| `mode` | string | `checker` or `model` |
| `tool_calls` | number | Eval tool-call count |
| `wall_ms` | number | Eval wall time |
| `source` | string | Session start source: `startup`, `resume`, `clear`, or `compact` |
| `ci_first_pass` | boolean | PR outcome |
| `review_rounds` | number | PR outcome |
| `time_to_merge_ms` | number | PR outcome |
| `reverted_within_7d` | boolean | PR outcome |
| `marked` | string | CLI events only. `session` when no session id was available, `host` when the host is `unattributed`, or `session,host` when both are missing. Omitted when the session and host are known. Hook events do not carry it |

## Kinds

`session_start`, `session_end`, `tool_call`, `tool_result`, `subagent_spawn`, `subagent_stop`, `guard_block`, `review_round`, `fix_round`, `ship`, `pr_open`, `eval_result`, `pr_outcome`, `session_bind`.

`session_bind` records that a session is working in a worktree. It stores `repo`, `branch`, `tool`, and `session_id` only. `ship-init` writes one after it creates the worktree. `goal` writes one when the current checkout, or the worktree a review enters, is a linked worktree (its git dir differs from the common git dir). The main checkout is not bound.

The same facts are kept in `bindings.json` next to the log, keyed by `session_id`, with `repo`, `branch`, `tool`, and `ts`. That file has no absolute path. A later event of that session with no resolvable directory uses the binding. A newer bind for the same session replaces the older one.

## Which directory an event belongs to

The hook's own working directory is the last choice. The command text is read only to find a directory, then discarded. It is not written to the log. Each git lookup is abandoned after about a second, and walking one command stops after 12 lookups. Outside the test suite the emit returns immediately and finishes in the background.

1. The shell command, walked left to right. `&&`, `;`, `|`, `||`, `&`, `(`, `)`, `{`, and `}` are their own tokens. A simulated directory starts at the payload directory, or the hook directory when that is missing. `cd <dir>` moves it when the next token is `&&` or `;`. `git -C` and `git --work-tree` are resolved from the simulated directory, so `git -C .` after `cd` is that directory. An absolute path is also a target, including a Windows drive letter (`C:/`, `C:\`) and a UNC path. When `cygpath` exists, `cygpath -u` turns that path into a POSIX path. The last directory that is inside a git checkout wins.
2. `file_path`, `path`, or `filePath` on the tool input, resolved against the payload directory.
3. The payload `cwd` when it is inside a git checkout. OpenCode passes the same hints through `AGENT_HARNESS_KPI_CWD`, `AGENT_HARNESS_KPI_COMMAND`, and `AGENT_HARNESS_KPI_FILE`. Those variables are not log fields.
4. The session binding, when nothing above named a directory.
5. The hook process directory.

Repo comes from `git -C <dir> remote get-url origin`. Branch comes from `git -C <dir> rev-parse --abbrev-ref HEAD`.

Claude `PreToolUse` and the Cursor adapter export those hints before `kpi-emit.sh` runs. Cursor `postToolUse` still prints `{}` and still drops the shell command and the tool output from the event.

CLI events (`goal` reviews, the git guard) copy a session id from `HARNESS_SESSION_ID`, `AGENT_HARNESS_SESSION_ID`, `OPENCODE_SESSION_ID`, `CURSOR_SESSION_ID`, or `CLAUDE_SESSION_ID` when one of those is set. The host comes from `AGENT_HARNESS_TOOL`, or from the Cursor, OpenCode, or Claude environment. When neither is available the event stays `session_id: unknown`, `tool: unattributed`, and `marked` names the gap. `unknown` is not counted as a session.

## Where each host writes

Claude Code:

- `PreToolUse` in `.claude/hooks/pre-tool-use.sh` writes `tool_call`. Skill adds `skill`. Task or Agent also writes `subagent_spawn` with `agent`.
- `PostToolUse` runs `.claude/hooks/kpi-emit.sh` and writes `tool_result`.
- `Stop` pipes the hook payload to `kpi-emit.sh`. Kind `session_end`. When `transcript_path` is a readable file of at most 8 MiB, `tokens` is the sum of `input_tokens` and `output_tokens` (or `input` and `output`) across records, and that sum replaces a number on the payload. A missing, unreadable, or larger file leaves the payload total when that total is a sanitised number; otherwise `tokens` is null.
- `SubagentStop` pipes to `kpi-emit.sh`. `agent` comes from `subagent_type` or `agent_type` when that value matches the pattern. Otherwise the hook reads the agent name from `agent_transcript_path` (first 64 KiB) or `transcript_path` (last 256 KiB, then the first 64 KiB). The path is not written.

Cursor:

- `preToolUse` goes through `cursor-adapter.sh` to `pre-tool-use.sh` (`tool_call`, `skill`, `agent`).
- `postToolUse` goes through `cursor-adapter.sh` to `kpi-emit.sh` (`tool_result`). The adapter stdout is `{}`. Tool output and shell commands are not forwarded.
- `sessionStart`, `sessionEnd`, and `subagentStop` are registered. `subagent_type` becomes `agent`. `tokens` is null. Payload usage and transcripts are ignored.
- `scripts/cursor-plugin/lib.mjs` builds `postToolUse` from the Claude `PostToolUse` hook, for both the Monolith and Conductor plugin builds.

OpenCode (`plugins/kpi/index.ts`):

- `tool.execute.before` writes `tool_call`. A `skill` tool adds `skill`. A `task` or `agent` tool also writes `subagent_spawn` with `agent`. A shell tool's `workdir` and `command`, and a read or edit `filePath`, choose the worktree. The command is not an argument of the KPI hook.
- `tool.execute.after` writes `tool_result` with `ok` and `duration_ms` measured in the plugin. Arguments and outputs are not forwarded. The same worktree hints apply.
- `session.created` writes `session_start`, or `subagent_spawn` with `agent` when `parentID` is set.
- `message.updated` stores the latest input+output total per message id. It does not write a line.
- `session.idle` and `session.deleted` write `session_end` for a root session, or `subagent_stop` with `agent` for a child session. `tokens` is the sum of the stored message totals.

`install.sh` merges `SessionStart` and `PostToolUse` commands for `kpi-emit.sh` into Claude settings. Global installs use `~/.claude/hooks`. Project installs (`--local`) use `./.claude/hooks`. Conductor and Monolith share that merge.

## Feature report

`agent-harness kpi feature` reads the same log for one feature. The feature key is `repo` + `branch`. The PR number is added once an event on that branch has `pr`, or when `--pr` is passed. `--branch` defaults to the current branch. `--pr` without `--branch` uses the branch on the events for that PR, and still counts earlier events on that branch that have no PR number yet.

```bash
agent-harness kpi feature
agent-harness kpi feature --pr 53 --json
agent-harness kpi feature --html --log ~/.agent-harness/kpi/events.jsonl
```

The text report, and the sanitised `docs/pr-reports/<branch-slug>.metrics.json` written next to it, contain:

| Value | Rule |
| --- | --- |
| Wall | Last event time minus first event time |
| Active | Sum of gaps between events. A gap longer than `--gap` minutes is idle and is left out. The default is 5 |
| Sessions | Distinct `session_id` per host (`cursor`, `claude`, `opencode`) among `tool_call`, `tool_result`, `session_start`, `session_end`, `subagent_spawn`, and `subagent_stop`. `N/A` when those events were not collected. A real zero means the log was collected and that host had no session |
| Tools and skills | Counts of `tool_call` only. `tool_result` does not add a call |
| Agents | `tool_call` counts for `main`, or for a subagent when the event's session is that child. A Task/Agent call on the parent session stays on `main`. A subagent with no tool calls of its own is counted once per spawn |
| Failures and durations | `tool_result` with `ok: false`, and `duration_ms` when it is a non-negative number below 24 hours |
| Guard blocks | `guard_block` events, split by `git`, `ask`, `secret`, `budget`, and `pr-visual-report`. A repeated block with the same timestamp, guard, repo, branch, session, variant, and tool is counted once |
| Review and fix rounds | `review_round` and `fix_round` events. If those events are absent, the report uses `review_rounds` or `fix_iterations` from a later outcome |
| Tokens | Sum of `session_end` and `subagent_stop` totals. `n/a` when none of those events carried a number |

`N/A` in the sessions, failure, guard, review, fix, tool, skill, and agent cells means the value was not collected. `n/a` on wall, active, and tokens still means the host sent no number. The JSON uses `null` for `N/A` and a number, including `0`, when the value was collected.

An event recorded on `master`, `main`, `HEAD`, or `unknown` is counted on a feature branch when that session has a `session_bind` for the branch, or when a commit on the branch carries a `Session-Id:` trailer for that same session. The trailer is read from local `git log` between the merge base (`origin/main`, `origin/master`, `main`, or `master`) and the branch. A trailer with no KPI event does not create a session. GitHub authors and model names are not sessions.

`coverage` on the report is `{ collected, reason, warnings }`. `collected` is true only when the branch has a session event with a real `session_id`. Admin events (`review_round`, `guard_block`, `fix_round`, `session_bind`, `pr_open`, `ship`) do not make it true. `reason` is null when collection succeeded. Otherwise it is the first match of:

| Reason | When |
| --- | --- |
| `log missing` | The log file is absent |
| `invalid JSON lines` | The file has no valid event, only broken lines |
| `jq missing` | `jq` is not on `PATH`. Events already in the log are still counted |
| `capture disabled` | `AGENT_HARNESS_KPI=0`. Events already in the log are still counted |
| `empty selection` | The log parsed and no event matched the repo and branch |
| `no session events for branch` | Matching events exist and none of them is a session event |

`partial` is true when session events were not collected, the repo or branch is unknown, or capture is blocked (`jq` missing, `AGENT_HARNESS_KPI=0`, or the log is missing). Unknown tokens are not partial. A report can be partial and still show real session counts when the log already holds them and capture is blocked.

stderr and `coverage.warnings` name the gap: `log absent`, `jq missing`, `capture disabled`, `empty selection`, `invalid JSON lines`, `no session events for branch`. A missing log does not also warn that the selection is empty. A file of only broken lines does not either.

The metrics file keeps only those aggregates, plus `coverage`. Names must already match the field patterns above. Prompts, arguments, and absolute paths are not written. `pr-report` reads the file, inserts a Metrics panel into the show-me HTML, and prints a `## Metrics` table for the PR body. The table adds `Coverage: <reason>` when `reason` is set. `pr-report-check` warns when that table is missing or partial and still accepts a valid visual report. Conductor and Monolith both run `kpi feature` before the visual report.
