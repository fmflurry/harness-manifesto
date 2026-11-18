#!/usr/bin/env node
// Builds a Mistral Vibe tree (~/.vibe layout) from the Cursor plugin build.
// Usage: node scripts/build-vibe.mjs --out DIR [--variant monolith|conductor] [--base-prompt FILE]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, unquote } from './cursor-plugin/lib.mjs';
import { normalizeVariant } from './cursor-plugin/variant.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURSOR_ONLY_SKILLS = new Set(['setup-harness']);

function parseArgs(argv) {
  const args = { variant: process.env.HARNESS_VARIANT ?? '', out: '', basePrompt: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--variant') args.variant = value;
    else if (flag === '--out') args.out = path.resolve(value);
    else if (flag === '--base-prompt') args.basePrompt = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.out) throw new Error('--out is required');
  args.variant = normalizeVariant(args.variant) || 'monolith';
  return args;
}

const read = (p) => fs.readFileSync(p, 'utf8');
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(', ')}]` : JSON.stringify(v));

function write(out, rel, content) {
  const p = path.join(out, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Cursor-only text: the grok model tiers. Vibe subagents inherit the active model.
export function vibeRuleBody(body) {
  return body
    .replace(/^On Cursor, [^\n]*\n\n?/m, '')
    .replace(/^## Models\n[\s\S]*$/m, '')
    .replace(/\n+$/, '\n');
}

export function agentToml({ name, description, readonly }) {
  const lines = [
    `agent_type = "subagent"`,
    `display_name = ${toml(name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '))}`,
    `description = ${toml(description)}`,
    `safety = ${toml(readonly ? 'safe' : 'neutral')}`,
    `system_prompt_id = ${toml(name)}`,
  ];
  if (readonly) lines.push(`disabled_tools = ${toml(['write_file', 'search_replace'])}`);
  return `${lines.join('\n')}\n`;
}

export function commandSkill(name, text, agents) {
  const { fm, body } = splitFrontmatter(text);
  const description = unquote(fm.description) || `/${name} command`;
  const agent = unquote(fm.agent);
  const delegate = agent && agents.has(agent)
    ? `Run this through the \`task\` tool with agent \`${agent}\`.\n\n`
    : '';
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    'user-invocable: true',
    '---',
    '',
    `\`$ARGUMENTS\` below is the text the user typed after \`/${name}\`.`,
    '',
    `${delegate}${body.trim()}`,
    '',
  ].join('\n');
}

export function mcpServers(cursorMcp) {
  return Object.entries(cursorMcp.mcpServers ?? {}).map(([name, s]) => (s.url
    ? { name, transport: 'streamable-http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    : { name, transport: 'stdio', command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) }));
}

function build({ variant, out, basePrompt }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-build-'));
  const src = path.join(tmp, 'cursor');
  try {
    execFileSync(process.execPath, [path.join(repoDir, 'scripts/build-cursor-plugin.mjs'), '--variant', variant, '--out', src], { stdio: 'ignore' });
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });

    const skills = fs.readdirSync(path.join(src, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !CURSOR_ONLY_SKILLS.has(e.name))
      .map((e) => e.name);
    for (const name of skills) {
      if (!SKILL_NAME.test(name)) throw new Error(`skill name not valid for Vibe: ${name}`);
      fs.cpSync(path.join(src, 'skills', name), path.join(out, 'skills', name), { recursive: true });
    }

    const base = basePrompt ? `${read(basePrompt).trim()}\n\n# Role\n\n` : '';
    const agents = new Set();
    for (const file of fs.readdirSync(path.join(src, 'agents')).filter((f) => f.endsWith('.md')).sort()) {
      const { fm, body } = splitFrontmatter(read(path.join(src, 'agents', file)));
      const name = unquote(fm.name) || file.slice(0, -3);
      if (!SKILL_NAME.test(name)) throw new Error(`agent name not valid for Vibe: ${name}`);
      write(out, `agents/${name}.toml`, agentToml({ name, description: unquote(fm.description), readonly: fm.readonly === 'true' }));
      write(out, `prompts/${name}.md`, `${base}${body.trim()}\n`);
      agents.add(name);
    }

    const skillSet = new Set(skills);
    const commandSkills = [];
    for (const file of fs.readdirSync(path.join(src, 'commands')).filter((f) => f.endsWith('.md')).sort()) {
      const name = file.slice(0, -3);
      // A skill of the same name is already /name in Vibe; these commands only wrap it.
      if (skillSet.has(name)) continue;
      if (!SKILL_NAME.test(name)) throw new Error(`command name not valid for Vibe: ${name}`);
      write(out, `skills/${name}/SKILL.md`, commandSkill(name, read(path.join(src, 'commands', file)), agents));
      commandSkills.push(name);
    }

    const LEAD_RULES = ['monolith.mdc', 'conductor.mdc'];
    const rules = fs.readdirSync(path.join(src, 'rules')).filter((f) => f.endsWith('.mdc'))
      .sort((a, b) => Number(LEAD_RULES.includes(b)) - Number(LEAD_RULES.includes(a)) || a.localeCompare(b));
    const sections = { always: [], scoped: [] };
    for (const file of rules) {
      const { fm, body } = splitFrontmatter(read(path.join(src, 'rules', file)));
      const text = vibeRuleBody(body).trim();
      if (fm.alwaysApply === 'true') sections.always.push(text);
      else sections.scoped.push(`> Applies when editing files matching \`${unquote(fm.globs)}\`.\n\n${text}`);
    }
    write(out, 'AGENTS.md', [
      '<!-- Generated by install-vibe.sh from settings-opencode. Rerun the installer instead of editing. -->',
      '',
      '> Vibe notes: subagents run through the `task` tool. Skills load through the `skill` tool or `/name`.',
      '> Hooks named below (secrets, tool budget, git guards, stop gate) do not run in Vibe. Follow those rules yourself.',
      '',
      ...[...sections.always, ...sections.scoped].flatMap((t) => [t, '', '---', '']),
    ].join('\n').replace(/\n---\n\n$/, ''));

    const servers = mcpServers(JSON.parse(read(path.join(src, 'mcp.json'))));
    write(out, 'mcp.json', `${JSON.stringify(servers, null, 2)}\n`);
    write(out, '.harness-variant', `${variant}\n`);
    write(out, '.harness-manifest.json', `${JSON.stringify({
      variant,
      agents: [...agents],
      skills: [...skills, ...commandSkills].sort(),
      mcp: servers.map((s) => s.name),
    }, null, 2)}\n`);
    console.log(`variant=${variant} skills=${skills.length + commandSkills.length} agents=${agents.size} rules=${rules.length} mcp=${servers.length}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === 'VARIANT' ? 2 : 1);
  }
}
