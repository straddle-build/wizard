// Native client configuration commands against scratch client homes. Skipped when a client is not installed.
// These run the real `claude` and `codex` binaries; no model session starts and no Straddle request is sent.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SKILLS_SOURCE, nextRepo, runWizard, tempDir } from './helpers.ts';

function binDir(name: string): string | null {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? dirname(r.stdout.trim()) : null;
}

const claudeDir = binDir('claude');
const codexDir = binDir('codex');

function scratchEnv(dir: string | null) {
  const home = tempDir('client-home');
  mkdirSync(join(home, 'claude'));
  mkdirSync(join(home, 'codex'));
  return { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), PATH: [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':') };
}

test('Codex: install, MCP credential route and removal keep unrelated servers', { skip: !codexDir }, async () => {
  const env = scratchEnv(codexDir);
  const repo = nextRepo();
  execFileSync('codex', ['mcp', 'add', 'unrelated', '--url', 'https://example.invalid/mcp'], { env: { ...process.env, ...env } });

  const install = await runWizard(['install', '--client', 'codex', '--yes'], { cwd: repo, env });
  const listed = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { env: { ...process.env, ...env }, encoding: 'utf8' }));
  const remove = await runWizard(['remove', '--client', 'codex', '--yes'], { cwd: repo, env });
  const mcpRemove = await runWizard(['mcp', 'remove', '--client', 'codex', '--yes'], { cwd: repo, env });
  const config = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8');

  assert.equal(install.code, 0, install.stdout + install.stderr);
  const api = listed.find((s: { name: string }) => s.name === 'straddle-api');
  assert.equal(api.transport.bearer_token_env_var, 'STRADDLE_API_KEY');
  assert.equal(remove.code, 0, remove.stdout);
  assert.equal(mcpRemove.code, 0, mcpRemove.stdout);
  assert.match(config, /\[mcp_servers\.unrelated\]/);
  assert.doesNotMatch(config, /straddle/);
});

test('Codex: a same-version installed copy that differs from the bundle is reported and repaired, and another marketplace is never claimed as the bundle', { skip: !codexDir }, async () => {
  const env = scratchEnv(codexDir);
  const repo = nextRepo();
  const market = tempDir('market');
  cpSync(SKILLS_SOURCE, market, { recursive: true, filter: (src) => !src.includes('/.git') });
  const local = { ...env, STRADDLE_WIZARD_BUNDLE: market };

  const install = await runWizard(['install', '--client', 'codex', '--yes'], { cwd: repo, env: local });
  appendFileSync(join(env.CODEX_HOME, 'plugins', 'cache', 'straddle', 'straddle', '0.1.0', 'skills', 'straddle-plan', 'SKILL.md'), '\nEdit code before the plan.\n');
  const tampered = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, env: local })).stdout);
  const repaired = await runWizard(['update', '--client', 'codex', '--yes'], { cwd: repo, env: local });
  // The helper's default bundle is the other local copy, SKILLS_SOURCE; the registered marketplace is `market`.
  const foreign = await runWizard(['update', '--client', 'codex', '--yes'], { cwd: repo, env });

  assert.equal(install.code, 0, install.stdout + install.stderr);
  assert.deepEqual(tampered.clients.find((c: { name: string }) => c.name === 'codex').plugin, { state: 'installed', version: '0.1.0', verified: false });
  assert.equal(repaired.code, 0, repaired.stdout);
  assert.match(repaired.stdout, /Straddle plugin in Codex: installed 0\.1\.0, matches the Wizard's bundle/);
  assert.equal(foreign.code, 1, foreign.stdout);
  assert.match(foreign.stdout, /Codex already has a marketplace named "straddle" at .*, not the verified .*\. The Wizard does not replace it\./);
});

test('Claude Code: install, update and removal keep unrelated MCP servers', { skip: !claudeDir }, async () => {
  const env = scratchEnv(claudeDir);
  const repo = nextRepo();
  execFileSync('claude', ['mcp', 'add', '--transport', 'http', '-s', 'user', 'unrelated', 'https://example.invalid/mcp'], { env: { ...process.env, ...env } });

  const install = await runWizard(['install', '--client', 'claude', '--yes'], { cwd: repo, env });
  const installed = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { env: { ...process.env, ...env }, encoding: 'utf8' }));
  const update = await runWizard(['update', '--client', 'claude', '--yes'], { cwd: repo, env });
  const remove = await runWizard(['remove', '--client', 'claude', '--yes'], { cwd: repo, env });
  const settings = readFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8');
  const user = readFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8');

  assert.equal(install.code, 0, install.stdout + install.stderr);
  assert.equal(installed[0].id, 'straddle@straddle');
  assert.equal(installed[0].version, '0.1.0');
  assert.equal(update.code, 0, update.stdout);
  assert.equal(remove.code, 0, remove.stdout);
  assert.doesNotMatch(settings, /straddle/);
  assert.match(user, /"unrelated"/);
});
