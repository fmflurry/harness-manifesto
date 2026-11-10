import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../commit-provenance.mjs');
const run = (cwd, cmd, args, opts = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', ...opts }).trim();
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  run(dir, 'git', ['init', '-q']);
  run(dir, 'git', ['config', 'user.name', 'Test']);
  run(dir, 'git', ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(dir, 'file'), 'content\n');
  run(dir, 'git', ['add', 'file']);
  return dir;
}

// Installs the OpenCode 2 plugin folder into an install target. The plugin imports
// @opencode/plugin, so the target gets the repository's node_modules.
function installOpencodePlugin(target) {
  const repoRoot = path.resolve(path.dirname(source), '../..');
  const folder = path.join(target, 'plugins/commit-provenance');
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'plugins/commit-provenance/index.ts'), path.join(folder, 'index.ts'));
  if (!fs.existsSync(path.join(target, 'node_modules'))) {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(target, 'node_modules'));
  }
  return path.join(folder, 'index.ts');
}

// The plugin's shell create.before hook, run with no OpenCode session in this process's env.
async function opencodeShellHook(t, pluginFile, directory) {
  const previous = process.env.OPENCODE_SESSION_ID;
  delete process.env.OPENCODE_SESSION_ID;
  t.after(() => {
    if (previous !== undefined) process.env.OPENCODE_SESSION_ID = previous;
  });
  const { default: plugin } = await import(pluginFile);
  let hook;
  await plugin.setup({
    location: { directory },
    shell: { hook: async (name, callback) => { if (name === 'create.before') hook = callback; } },
  });
  return hook;
}

test('agent commit includes installed provenance and runs existing hooks', (t) => {
  const dir = setup(t);
  const hook = path.join(dir, '.git/hooks/prepare-commit-msg');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "existing hook\\n" > hook-ran\n', { mode: 0o755 });
  run(dir, 'node', [source, 'run', 'session-123', '0.4.34', '1234567890abcdef1234567890abcdef12345678-dirty', 'git commit -qm "feat: example"']);
  const message = run(dir, 'git', ['log', '-1', '--format=%B']);
  assert.match(message, /Harness: fmflurry-harness@0\.4\.34/);
  assert.match(message, /Harness-SHA: 1234567890abcdef1234567890abcdef12345678-dirty/);
  assert.match(message, /Session-Id: session-123/);
  assert.equal(fs.existsSync(path.join(dir, 'hook-ran')), true);
});

test('human commits are unaffected', (t) => {
  const dir = setup(t);
  run(dir, 'git', ['commit', '-qm', 'feat: human']);
  assert.doesNotMatch(run(dir, 'git', ['log', '-1', '--format=%B']), /Session-Id:/);
});

test('existing failing hooks still prevent a commit', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  const result = spawnSync('node', [source, 'run', 'session-123', '0.4.34', '1234567890abcdef1234567890abcdef12345678', 'git commit -qm "feat: example"'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir }).status, 0);
});

test('amend replaces stale provenance without duplicating trailers', (t) => {
  const dir = setup(t);
  const sha = '1234567890abcdef1234567890abcdef12345678';
  run(dir, 'node', [source, 'run', 'session-1', '0.4.34', sha, 'git commit -qm "feat: example"']);
  run(dir, 'node', [source, 'run', 'session-2', '0.4.34', sha, 'git commit --amend --no-edit -q']);
  const message = run(dir, 'git', ['log', '-1', '--format=%B']);
  assert.equal((message.match(/^Session-Id:/gm) || []).length, 1);
  assert.match(message, /^Session-Id: session-2$/m);
  assert.equal((message.match(/^Harness:/gm) || []).length, 1);
  assert.equal((message.match(/^Harness-SHA:/gm) || []).length, 1);
});

test('custom hooksPath is preserved', (t) => {
  const dir = setup(t);
  fs.mkdirSync(path.join(dir, 'custom'));
  fs.writeFileSync(path.join(dir, 'custom/pre-commit'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  run(dir, 'git', ['config', 'core.hooksPath', 'custom']);
  const result = spawnSync('node', [source, 'run', 'session-123', '0.4.34', '1234567890abcdef1234567890abcdef12345678', 'git commit -qm "feat: example"'], { cwd: dir });
  assert.notEqual(result.status, 0);
});

test('metadata detects changes after installation and preserves source dirty state', (t) => {
  const sourceRepo = setup(t);
  run(sourceRepo, 'git', ['commit', '-qm', 'chore: source']);
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installed-'));
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
  fs.mkdirSync(path.join(installed, 'hooks'));
  fs.writeFileSync(path.join(installed, 'hooks', 'example.sh'), 'one');
  run(sourceRepo, 'node', [source, 'capture', sourceRepo, installed, '0.4.34']);
  const clean = JSON.parse(run(sourceRepo, 'node', [source, 'resolve', installed]));
  assert.equal(clean.version, '0.4.34');
  assert.match(clean.sha, /^[a-f0-9]{40}$/);
  fs.writeFileSync(path.join(installed, 'hooks', 'example.sh'), 'two');
  const dirty = JSON.parse(run(sourceRepo, 'node', [source, 'resolve', installed]));
  assert.equal(dirty.sha, `${clean.sha}-dirty`);
});

test('session wrapper reads metadata only when a commit is made', (t) => {
  const dir = setup(t);
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installed-'));
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
  run(dir, 'node', [source, 'run', 'session-123', '@target', installed, 'printf normal']);
  const missing = spawnSync('node', [source, 'run', 'session-123', '@target', installed, 'git commit -qm "feat: missing"'], { cwd: dir });
  assert.notEqual(missing.status, 0);
  run(dir, 'git', ['commit', '-qm', 'chore: baseline']);
  fs.writeFileSync(path.join(dir, 'file'), 'changed\n');
  run(dir, 'git', ['add', 'file']);
  run(dir, 'node', [source, 'capture', dir, installed, '0.4.34']);
  run(dir, 'node', [source, 'run', 'session-123', '@target', installed, 'git commit -qm "feat: example"']);
  assert.match(run(dir, 'git', ['log', '-1', '--format=%B']), /^Session-Id: session-123$/m);
});

test('Claude SessionStart scopes Git hooks to the session without rewriting commands', (t) => {
  const dir = setup(t);
  run(dir, 'git', ['commit', '-qm', 'chore: baseline']);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const scripts = path.join(target, 'scripts/agent-harness');
  fs.mkdirSync(path.join(target, 'hooks'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(source, path.join(scripts, 'commit-provenance.mjs'));
  fs.chmodSync(path.join(scripts, 'commit-provenance.mjs'), 0o755);
  const hook = path.resolve(path.dirname(source), '../../.claude/hooks/commit-provenance.sh');
  fs.copyFileSync(hook, path.join(target, 'hooks', 'commit-provenance.sh'));
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'setup', target]);
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'capture', dir, target, '0.4.34']);
  const envFile = path.join(target, 'env');
  const result = spawnSync('bash', [path.join(target, 'hooks', 'commit-provenance.sh')], { cwd: dir, input: JSON.stringify({ session_id: 'claude-session' }), encoding: 'utf8', env: { ...process.env, CLAUDE_ENV_FILE: envFile } });
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(path.join(dir, 'file'), 'changed\n');
  run(dir, 'git', ['add', 'file']);
  run(dir, 'bash', ['-c', 'source "$CLAUDE_ENV_FILE"; git commit -qm "feat: session"'], { env: { ...process.env, CLAUDE_ENV_FILE: envFile } });
  assert.match(run(dir, 'git', ['log', '-1', '--format=%B']), /^Session-Id: claude-session$/m);
});

test('OpenCode shell hook carries each session id and leaves human shells alone', async (t) => {
  const dir = setup(t);
  run(dir, 'git', ['commit', '-qm', 'chore: baseline']);
  const target = path.join(dir, '.opencode');
  const scripts = path.join(target, 'scripts/agent-harness');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(source, path.join(scripts, 'commit-provenance.mjs'));
  fs.chmodSync(path.join(scripts, 'commit-provenance.mjs'), 0o755);
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'setup', target]);
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'capture', dir, target, '0.4.34']);
  const pluginFile = installOpencodePlugin(target);
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'capture', dir, target, '0.4.34']);
  const createBefore = await opencodeShellHook(t, pluginFile, dir);
  const human = { env: {} };
  await createBefore(human);
  assert.deepEqual(human.env, {});
  const agent = { env: { OPENCODE_SESSION_ID: 'opencode-session' } };
  await createBefore(agent);
  fs.writeFileSync(path.join(dir, 'file'), 'changed\n');
  run(dir, 'git', ['add', 'file']);
  run(dir, 'git', ['commit', '-qm', 'feat: session'], { env: { ...process.env, ...agent.env } });
  assert.match(run(dir, 'git', ['log', '-1', '--format=%B']), /^Session-Id: opencode-session$/m);
});

test('changes through installed symlinks are detected', (t) => {
  const dir = setup(t);
  run(dir, 'git', ['commit', '-qm', 'chore: source']);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installed-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.mkdirSync(path.join(target, 'hooks'));
  const outside = path.join(target, 'external.sh');
  fs.writeFileSync(outside, 'one');
  fs.symlinkSync(outside, path.join(target, 'hooks', 'linked.sh'));
  run(dir, 'node', [source, 'capture', dir, target, '0.4.34']);
  fs.writeFileSync(outside, 'two');
  const result = JSON.parse(run(dir, 'node', [source, 'resolve', target]));
  assert.match(result.sha, /-dirty$/);
});

test('capture refuses a directory that is only nested in an unrelated checkout', (t) => {
  const dir = setup(t);
  run(dir, 'git', ['commit', '-qm', 'chore: source']);
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested);
  const result = spawnSync('node', [source, 'capture', nested, nested, '0.4.34'], { cwd: dir });
  assert.notEqual(result.status, 0);
});

test('repeated Claude session setup does not recursively invoke itself', (t) => {
  const dir = setup(t);
  run(dir, 'git', ['commit', '-qm', 'chore: baseline']);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const scripts = path.join(target, 'scripts/agent-harness');
  fs.mkdirSync(path.join(target, 'hooks'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(source, path.join(scripts, 'commit-provenance.mjs'));
  fs.chmodSync(path.join(scripts, 'commit-provenance.mjs'), 0o755);
  const script = path.join(target, 'hooks/commit-provenance.sh');
  fs.copyFileSync(path.resolve(path.dirname(source), '../../.claude/hooks/commit-provenance.sh'), script);
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'setup', target]);
  run(dir, 'node', [path.join(scripts, 'commit-provenance.mjs'), 'capture', dir, target, '0.4.34']);
  const envFile = path.join(target, 'env');
  for (let i = 0; i < 2; i++) {
    const result = spawnSync('bash', [script], { cwd: dir, input: JSON.stringify({ session_id: 'claude-session' }), encoding: 'utf8', env: { ...process.env, CLAUDE_ENV_FILE: envFile } });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(dir, 'file'), 'changed\n');
  run(dir, 'git', ['add', 'file']);
  const result = spawnSync('bash', ['-c', 'source "$CLAUDE_ENV_FILE"; git commit -qm "feat: session"'], { cwd: dir, env: { ...process.env, CLAUDE_ENV_FILE: envFile }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr?.toString());
});

test('an explicitly empty hooksPath does not execute disabled repository hooks', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  run(dir, 'git', ['config', 'core.hooksPath', '']);
  run(dir, 'node', [source, 'run', 'session-123', '0.4.34', '1234567890abcdef1234567890abcdef12345678', 'git commit -qm "feat: example"']);
  assert.match(run(dir, 'git', ['log', '-1', '--format=%B']), /^Session-Id: session-123$/m);
});

test('provenance-looking text in the commit body is retained', (t) => {
  const dir = setup(t);
  const command = "git commit -qm $'feat: example\\n\\nHarness: an example in documentation\\n\\nExplanation follows.'";
  run(dir, 'node', [source, 'run', 'session-123', '0.4.34', '1234567890abcdef1234567890abcdef12345678', command]);
  assert.match(run(dir, 'git', ['log', '-1', '--format=%B']), /^Harness: an example in documentation$/m);
});

test('global OpenCode plugin does not trust a forged project marker or hooks', async (t) => {
  const dir = setup(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-global-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.mkdirSync(path.join(target, 'scripts/agent-harness'), { recursive: true });
  const helper = path.join(target, 'scripts/agent-harness/commit-provenance.mjs');
  fs.copyFileSync(source, helper); fs.chmodSync(helper, 0o755);
  const globalPlugin = installOpencodePlugin(target);
  run(dir, 'node', [helper, 'setup', target]);
  const forged = path.join(dir, '.opencode');
  fs.mkdirSync(path.join(forged, 'scripts/agent-harness/git-hooks'), { recursive: true });
  fs.writeFileSync(path.join(forged, '.harness-provenance.json'), '{}');
  fs.writeFileSync(path.join(forged, 'scripts/agent-harness/git-hooks/prepare-commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const createBefore = await opencodeShellHook(t, globalPlugin, dir);
  const output = { env: { OPENCODE_SESSION_ID: 'session-1' } };
  await createBefore(output);
  assert.equal(output.env.HARNESS_SHA, fs.realpathSync(target));
  assert.equal(output.env.GIT_CONFIG_VALUE_0, path.join(fs.realpathSync(target), 'scripts/agent-harness/git-hooks'));
});

test('configured hook paths preserve leading and trailing spaces', (t) => {
  const dir = setup(t);
  fs.mkdirSync(path.join(dir, ' hooks '));
  fs.writeFileSync(path.join(dir, ' hooks ', 'pre-commit'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  run(dir, 'git', ['config', 'core.hooksPath', ' hooks ']);
  const result = spawnSync('node', [source, 'run', 'session-123', '0.4.34', '1234567890abcdef1234567890abcdef12345678', 'git commit -qm "feat: example"'], { cwd: dir });
  assert.notEqual(result.status, 0);
});

test('ignored source customizations cannot produce a clean revision', (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, '.gitignore'), '/agents/\n');
  run(dir, 'git', ['add', '.gitignore']);
  run(dir, 'git', ['commit', '-qm', 'chore: source']);
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.writeFileSync(path.join(dir, 'agents/custom.md'), 'custom');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installed-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  run(dir, 'node', [source, 'capture', dir, target, '0.4.34', dir, '0']);
  assert.match(JSON.parse(run(dir, 'node', [source, 'resolve', target])).sha, /-dirty$/);
});
