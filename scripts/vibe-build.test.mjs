import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentToml, commandSkill, mcpServers, vibeRuleBody } from './build-vibe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('readonly agent disables write tools and points at its own prompt', () => {
  const out = agentToml({ name: 'code-reviewer', description: 'Reviews "diffs".', readonly: true });
  assert.match(out, /^system_prompt_id = "code-reviewer"$/m);
  assert.match(out, /^disabled_tools = \["write_file", "search_replace"\]$/m);
  assert.match(out, /^description = "Reviews \\"diffs\\"\."$/m);
  assert.doesNotMatch(agentToml({ name: 'e2e-runner', description: '', readonly: false }), /disabled_tools/);
});

test('command becomes a user-invocable skill and delegates to an installed agent', () => {
  const text = '---\ndescription: Run e2e\nagent: e2e-runner\n---\nDo it for $ARGUMENTS\n';
  const out = commandSkill('e2e', text, new Set(['e2e-runner']));
  assert.match(out, /^name: e2e$/m);
  assert.match(out, /^user-invocable: true$/m);
  assert.match(out, /agent `e2e-runner`/);
  assert.doesNotMatch(commandSkill('e2e', text, new Set()), /task/);
});

test('mcp servers map to Vibe transports', () => {
  assert.deepEqual(mcpServers({ mcpServers: { a: { command: 'uvx', args: ['x'] }, b: { url: 'https://h' } } }), [
    { name: 'a', transport: 'stdio', command: 'uvx', args: ['x'] },
    { name: 'b', transport: 'streamable-http', url: 'https://h' },
  ]);
});

test('Cursor model tiers are stripped from rules', () => {
  const body = '# Monolith\n\nOn Cursor, use grok.\n\nKeep.\n\n## Models\n\n- grok\n';
  assert.equal(vibeRuleBody(body), '# Monolith\n\nKeep.\n');
});

test('build has no command duplicating a skill and no Cursor-only content', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-test-')), 'v');
  const run = spawnSync(process.execPath, [path.join(repo, 'scripts/build-vibe.mjs'), '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, '.harness-manifest.json'), 'utf8'));
  assert.equal(manifest.variant, 'monolith');
  assert.equal(new Set(manifest.skills).size, manifest.skills.length);
  assert.equal(manifest.skills.includes('setup-harness'), false);
  assert.equal(fs.readFileSync(path.join(out, 'skills/ship/SKILL.md'), 'utf8').includes('user-invocable: true'), false);
  assert.doesNotMatch(fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8'), /grok|## Models/);
  for (const agent of manifest.agents) assert.ok(fs.existsSync(path.join(out, 'prompts', `${agent}.md`)), agent);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

const hasVibe = spawnSync('sh', ['-c', 'command -v vibe']).status === 0;

test('installer keeps user MCP servers and symlinked skills, resets a missing default agent, reruns cleanly', { skip: !hasVibe }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-shared-'));
  fs.mkdirSync(path.join(home, 'skills'));
  fs.symlinkSync(shared, path.join(home, 'skills/mine'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'default_agent = "conductor"\n\n[[mcp_servers]]\nname = "user-one"\ntransport = "stdio"\ncommand = "x"\n');
  const install = () => spawnSync('bash', [path.join(repo, 'install-vibe.sh'), '--no-backup'], { env: { ...process.env, VIBE_HOME: home }, encoding: 'utf8' });

  for (const run of [install(), install()]) assert.equal(run.status, 0, run.stderr);
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.match(config, /default_agent = "default"/);
  assert.match(config, /name = "user-one"/);
  assert.equal(config.match(/name = "code-memory"/g).length, 1);
  assert.ok(fs.lstatSync(path.join(home, 'skills/mine')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(home, 'agents/code-reviewer.toml')));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

test('installer refuses a symlinked skills directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(home, 'skills'));
  const run = spawnSync('bash', [path.join(repo, 'install-vibe.sh')], { env: { ...process.env, VIBE_HOME: home }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /is a symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});
