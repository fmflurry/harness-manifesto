import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateFeature, featureMain, formatMetricsMarkdown } from '../kpi-feature.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const emitScript = path.join(repo, '.claude/hooks/kpi-emit.sh');
const preTool = path.join(repo, '.claude/hooks/pre-tool-use.sh');
const adapter = path.join(repo, 'scripts/cursor-plugin/cursor-adapter.sh');
const featureScript = path.join(repo, 'scripts/agent-harness/kpi-feature.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-wt-'));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(main);
  git(main, ['init', '-q', '-b', 'master']);
  git(main, ['config', 'user.email', 't@example.com']);
  git(main, ['config', 'user.name', 'Test']);
  git(main, ['remote', 'add', 'origin', 'https://github.com/example/widget.git']);
  fs.writeFileSync(path.join(main, 'README.md'), 'hi\n');
  git(main, ['add', 'README.md']);
  git(main, ['commit', '-qm', 'init']);
  git(main, ['worktree', 'add', '-q', '-b', 'feat/widget', wt, 'HEAD']);
  return { root, main, wt };
}

function emitEnv(log, extra = {}) {
  return {
    HOME: extra.HOME ?? path.dirname(log),
    PATH: process.env.PATH,
    AGENT_HARNESS_KPI: '1',
    AGENT_HARNESS_KPI_LOG: log,
    AGENT_HARNESS_TEST: '1',
    AGENT_HARNESS_VARIANT: 'monolith',
    AGENT_HARNESS_TOOL: 'claude',
    ...extra,
  };
}

function runEmit(body) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-log-')), 'events.jsonl');
  const result = spawnSync('bash', body.argv ?? [emitScript], {
    cwd: body.cwd,
    input: body.input,
    encoding: 'utf8',
    env: emitEnv(log, body.env),
  });
  assert.equal(result.status, 0, result.stderr);
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
  const lines = text ? text.split('\n').map((line) => JSON.parse(line)) : [];
  return { log, lines, result };
}

function assertWorktree(event, wt) {
  assert.equal(event.repo, 'example/widget');
  assert.equal(event.branch, 'feat/widget');
  const packed = JSON.stringify(event);
  assert.equal(packed.includes(wt), false);
  assert.equal(packed.includes('SUPER_SECRET'), false);
  assert.equal(packed.includes('/tmp'), false);
}

test('payload cwd attributes a tool call to the worktree, not the hook PWD', () => {
  const { main, wt } = setupRepo();
  const { lines } = runEmit({
    cwd: main,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-cwd',
      cwd: wt,
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    }),
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'tool_call');
  assert.equal(lines[0].session_id, 'sess-cwd');
  assertWorktree(lines[0], wt);
});

test('git -C, cd &&, and an absolute path attribute the shell call to the worktree', () => {
  const { main, wt } = setupRepo();
  const secret = 'SUPER_SECRET_TOKEN';
  const cases = [
    `git -C ${wt} status ${secret}`,
    `cd ${wt} && git status ${secret}`,
    `node ${path.join(wt, 'README.md')} ${secret}`,
  ];
  for (const command of cases) {
    const { lines } = runEmit({
      cwd: main,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-shell',
        cwd: main,
        tool_name: 'Bash',
        tool_input: { command },
      }),
    });
    assert.equal(lines.length, 1, command);
    assertWorktree(lines[0], wt);
  }
});

test('a file path inside the worktree wins over a main-checkout cwd', () => {
  const { main, wt } = setupRepo();
  const { lines } = runEmit({
    cwd: main,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-file',
      cwd: main,
      tool_name: 'Read',
      tool_input: { file_path: path.join(wt, 'README.md'), note: 'SUPER_SECRET_TOKEN' },
    }),
  });
  assertWorktree(lines[0], wt);
});

test('Cursor preToolUse and postToolUse follow the worktree target', () => {
  const { main, wt } = setupRepo();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-cursor-'));
  const preLog = path.join(logDir, 'pre.jsonl');
  const pre = spawnSync('bash', [adapter, emitScript, 'preToolUse'], {
    cwd: main,
    encoding: 'utf8',
    input: JSON.stringify({
      conversation_id: 'conv-pre',
      cwd: wt,
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    }),
    env: emitEnv(preLog, { AGENT_HARNESS_TOOL: 'cursor' }),
  });
  assert.equal(pre.status, 0, pre.stderr);
  const preEvent = JSON.parse(fs.readFileSync(preLog, 'utf8').trim().split('\n').pop());
  assert.equal(preEvent.tool, 'cursor');
  assertWorktree(preEvent, wt);

  const postLog = path.join(logDir, 'post.jsonl');
  const post = spawnSync('bash', [adapter, emitScript, 'postToolUse'], {
    cwd: main,
    encoding: 'utf8',
    input: JSON.stringify({
      conversation_id: 'conv-post',
      cwd: main,
      tool_name: 'Shell',
      tool_input: { command: `git -C ${wt} status SUPER_SECRET_TOKEN` },
      tool_output: 'SUPER_SECRET_OUTPUT',
      duration_ms: 4,
    }),
    env: emitEnv(postLog, { AGENT_HARNESS_TOOL: 'cursor' }),
  });
  assert.equal(post.status, 0, post.stderr);
  assert.deepEqual(JSON.parse(post.stdout), {});
  const postEvent = JSON.parse(fs.readFileSync(postLog, 'utf8').trim().split('\n').pop());
  assert.equal(postEvent.kind, 'tool_result');
  assert.equal(postEvent.tool_name, 'Bash');
  assertWorktree(postEvent, wt);
});

test('OpenCode shell env and Claude pre-tool-use follow git -C into the worktree', () => {
  const { main, wt } = setupRepo();
  const command = `git -C ${wt} status SUPER_SECRET_TOKEN`;
  const viaEnv = runEmit({
    cwd: main,
    argv: [emitScript, 'tool_call', 'tool_name=Bash', 'session=sess-oc'],
    env: {
      AGENT_HARNESS_TOOL: 'opencode',
      AGENT_HARNESS_KPI_CWD: main,
      AGENT_HARNESS_KPI_COMMAND: command,
    },
  });
  assert.equal(viaEnv.lines[0].tool, 'opencode');
  assert.equal(viaEnv.lines[0].session_id, 'sess-oc');
  assertWorktree(viaEnv.lines[0], wt);

  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-pre-')), 'events.jsonl');
  const pre = spawnSync('bash', [preTool], {
    cwd: main,
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-pre',
      cwd: main,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    env: emitEnv(log),
  });
  assert.equal(pre.status, 0, pre.stderr);
  const event = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(event.session_id, 'sess-pre');
  assertWorktree(event, wt);
});

test('a session binding attributes a later event that has no resolvable directory', () => {
  const { main, wt } = setupRepo();
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-bind-')), 'events.jsonl');
  const bound = spawnSync('bash', [emitScript, 'session_bind', 'session=sess-bound'], {
    cwd: main,
    encoding: 'utf8',
    env: emitEnv(log, { AGENT_HARNESS_KPI_CWD: wt }),
  });
  assert.equal(bound.status, 0, bound.stderr);
  const later = spawnSync('bash', [emitScript, 'tool_call', 'tool_name=Read', 'session=sess-bound'], {
    cwd: main,
    encoding: 'utf8',
    env: emitEnv(log),
  });
  assert.equal(later.status, 0, later.stderr);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].kind, 'session_bind');
  assertWorktree(lines[0], wt);
  assert.equal(lines[1].kind, 'tool_call');
  assertWorktree(lines[1], wt);
  const bindings = fs.readFileSync(path.join(path.dirname(log), 'bindings.json'), 'utf8');
  assert.equal(bindings.includes(wt), false);
  assert.equal(bindings.includes('/tmp'), false);
  assert.equal(JSON.parse(bindings)['sess-bound'].branch, 'feat/widget');
});

test('ship-init and goal record a session binding when they create or enter a worktree', () => {
  const ship = fs.readFileSync(path.join(repo, 'scripts/agent-harness/ship-init.sh'), 'utf8');
  const goal = fs.readFileSync(path.join(repo, 'scripts/agent-harness/goal.sh'), 'utf8');
  assert.match(ship, /session_bind/);
  assert.match(goal, /session_bind/);
});

test('CLI reviews and guard events keep a real session and host, or mark the gap', () => {
  const { main } = setupRepo();
  const marked = runEmit({
    cwd: main,
    argv: [emitScript, 'review_round', 'review=code', 'verdict=pass'],
    env: { AGENT_HARNESS_TOOL: '' },
  });
  assert.equal(marked.lines[0].session_id, 'unknown');
  assert.equal(marked.lines[0].tool, 'unattributed');
  assert.match(marked.lines[0].marked, /session/);
  assert.match(marked.lines[0].marked, /host/);

  const known = runEmit({
    cwd: main,
    argv: [emitScript, 'guard_block', 'guard=git'],
    env: { HARNESS_SESSION_ID: 'sess-admin', AGENT_HARNESS_TOOL: 'cursor' },
  });
  assert.equal(known.lines[0].session_id, 'sess-admin');
  assert.equal(known.lines[0].tool, 'cursor');
  assert.equal(known.lines[0].kind, 'guard_block');
  assert.equal(known.lines[0].marked, undefined);
});

test('a bound session and a Session-Id trailer count for the feature branch', () => {
  const { main, wt } = setupRepo();
  git(wt, ['commit', '--allow-empty', '-qm', 'feat: widget\n\nSession-Id: sess-trailer']);
  git(wt, ['commit', '--allow-empty', '-qm', 'feat: ghost\n\nSession-Id: ghost-session']);
  const rows = [
    {
      ts: '2026-11-11T10:00:00Z', kind: 'tool_call', tool: 'cursor', repo: 'example/widget',
      branch: 'master', session_id: 'sess-bound', tool_name: 'Read',
    },
    {
      ts: '2026-11-11T10:00:01Z', kind: 'session_bind', tool: 'cursor', repo: 'example/widget',
      branch: 'feat/widget', session_id: 'sess-bound',
    },
    {
      ts: '2026-11-11T10:05:00Z', kind: 'tool_call', tool: 'claude', repo: 'example/widget',
      branch: 'master', session_id: 'sess-trailer', tool_name: 'Bash',
    },
  ];
  const bound = aggregateFeature(rows, { repo: 'example/widget', branch: 'feat/widget' });
  assert.equal(bound.sessions.cursor, 1);
  assert.equal(bound.partial, false);
  assert.equal(bound.coverage.collected, true);

  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-trailer-')), 'events.jsonl');
  fs.writeFileSync(log, `${JSON.stringify(rows[2])}\n`);
  let stdout = '';
  const code = featureMain(
    ['--log', log, '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics'],
    {
      stdout: (chunk) => { stdout += chunk; },
      stderr: () => {},
      detect: () => ({ root: main, repo: 'example/widget', branch: 'master' }),
    },
  );
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.sessions.claude, 1);
  assert.equal(report.sessions.cursor, 0);
  assert.equal(report.sessions.opencode, 0);
  assert.equal(report.partial, false);
  assert.equal(JSON.stringify(report).includes('ghost-session'), false);
});

test('admin-only events stay partial and render N/A instead of a confirmed zero', () => {
  const rows = [
    {
      ts: '2026-11-11T10:00:00Z', kind: 'review_round', tool: 'claude', repo: 'example/widget',
      branch: 'feat/widget', session_id: 'sess-admin', review: 'code', verdict: 'pass',
    },
    {
      ts: '2026-11-11T10:01:00Z', kind: 'guard_block', tool: 'claude', repo: 'example/widget',
      branch: 'feat/widget', session_id: 'unknown', guard: 'git',
    },
  ];
  const report = aggregateFeature(rows, { repo: 'example/widget', branch: 'feat/widget' });
  assert.equal(report.partial, true);
  assert.equal(report.coverage.collected, false);
  assert.equal(report.coverage.reason, 'no session events for branch');
  assert.deepEqual(report.sessions, { cursor: null, claude: null, opencode: null });
  assert.equal(report.tool_failures, null);
  assert.equal(report.review_rounds, 1);
  const md = formatMetricsMarkdown(report);
  assert.match(md, /\| Sessions \| N\/A \|/);
  assert.match(md, /\| Tool failures \| N\/A \|/);
  assert.match(md, /Status: partial/);
  assert.match(md, /Coverage: no session events for branch/);
  assert.equal(md.includes('cursor 0'), false);
});

test('a tool call on the feature branch reports real host counts', () => {
  const rows = [{
    ts: '2026-11-11T10:00:00Z', kind: 'tool_call', tool: 'cursor', repo: 'example/widget',
    branch: 'feat/widget', session_id: 'sess-real', tool_name: 'Read',
  }];
  const report = aggregateFeature(rows, { repo: 'example/widget', branch: 'feat/widget' });
  assert.equal(report.partial, false);
  assert.equal(report.coverage.collected, true);
  assert.equal(report.coverage.reason, null);
  assert.deepEqual(report.sessions, { cursor: 1, claude: 0, opencode: 0 });
  const md = formatMetricsMarkdown(report);
  assert.match(md, /\| Sessions \| cursor 1, claude 0, opencode 0 \|/);
  assert.match(md, /Status: complete/);
  assert.doesNotMatch(md, /\| Sessions \| N\/A \|/);
});

function runFeature(args, env = {}) {
  return spawnSync(process.execPath, [featureScript, ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: { ...process.env, AGENT_HARNESS_KPI: '1', ...env },
  });
}

test('a missing log, disabled capture, a missing jq, an empty selection, and bad JSON warn and stay N/A', () => {
  const missing = runFeature([
    '--log', path.join(os.tmpdir(), 'kpi-missing-log.jsonl'),
    '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics',
  ]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /kpi feature: warning: log absent/);
  assert.doesNotMatch(missing.stderr, /empty selection/);
  const missingReport = JSON.parse(missing.stdout);
  assert.equal(missingReport.partial, true);
  assert.equal(missingReport.coverage.reason, 'log missing');
  assert.deepEqual(missingReport.sessions, { cursor: null, claude: null, opencode: null });
  assert.match(formatMetricsMarkdown(missingReport), /\| Sessions \| N\/A \|/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-cov-'));
  const emptyLog = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(emptyLog, '');
  const disabled = runFeature(
    ['--log', emptyLog, '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics'],
    { AGENT_HARNESS_KPI: '0' },
  );
  assert.match(disabled.stderr, /kpi feature: warning: capture disabled \(AGENT_HARNESS_KPI=0\)/);
  assert.match(disabled.stderr, /kpi feature: warning: empty selection/);
  assert.equal(JSON.parse(disabled.stdout).coverage.reason, 'capture disabled');
  assert.equal(JSON.parse(disabled.stdout).partial, true);

  const sessionLog = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sessionLog, `${JSON.stringify({
    ts: '2026-11-11T10:00:00Z', kind: 'tool_call', tool: 'cursor', repo: 'example/widget',
    branch: 'feat/widget', session_id: 'sess-real', tool_name: 'Read',
  })}\n`);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const noJq = runFeature(
    ['--log', sessionLog, '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics'],
    { PATH: bin },
  );
  assert.equal(noJq.status, 0, noJq.stderr);
  assert.match(noJq.stderr, /kpi feature: warning: jq missing/);
  const jqReport = JSON.parse(noJq.stdout);
  assert.equal(jqReport.sessions.cursor, 1);
  assert.equal(jqReport.partial, true);
  assert.equal(jqReport.coverage.reason, 'jq missing');

  const otherLog = path.join(dir, 'other.jsonl');
  fs.writeFileSync(otherLog, `${JSON.stringify({
    ts: '2026-11-11T10:00:00Z', kind: 'tool_call', tool: 'cursor', repo: 'example/widget',
    branch: 'master', session_id: 'sess-other', tool_name: 'Read',
  })}\n`);
  const emptySel = runFeature([
    '--log', otherLog, '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics',
  ]);
  assert.match(emptySel.stderr, /kpi feature: warning: empty selection/);
  assert.doesNotMatch(emptySel.stderr, /log absent/);
  assert.equal(JSON.parse(emptySel.stdout).coverage.reason, 'empty selection');
  assert.equal(JSON.parse(emptySel.stdout).sessions.cursor, null);

  const badLog = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(badLog, '{not json\n');
  const bad = runFeature([
    '--log', badLog, '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics',
  ]);
  assert.match(bad.stderr, /kpi feature: warning: invalid JSON lines/);
  assert.doesNotMatch(bad.stderr, /empty selection/);
  assert.equal(JSON.parse(bad.stdout).coverage.reason, 'invalid JSON lines');

  const mixedLog = path.join(dir, 'mixed.jsonl');
  fs.writeFileSync(mixedLog, `{not json\n${JSON.stringify({
    ts: '2026-11-11T10:00:00Z', kind: 'tool_call', tool: 'opencode', repo: 'example/widget',
    branch: 'feat/widget', session_id: 'sess-ok', tool_name: 'Read',
  })}\n`);
  const mixed = runFeature([
    '--log', mixedLog, '--repo', 'example/widget', '--branch', 'feat/widget', '--json', '--no-metrics',
  ]);
  assert.match(mixed.stderr, /kpi feature: warning: invalid JSON lines/);
  const mixedReport = JSON.parse(mixed.stdout);
  assert.equal(mixedReport.sessions.opencode, 1);
  assert.equal(mixedReport.partial, false);
  assert.equal(mixedReport.coverage.collected, true);
  assert.equal(mixedReport.coverage.reason, null);
});
