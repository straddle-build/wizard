import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadLocalBundle } from '../src/bundle.ts';
import { CLIENT_NAMES, inspectClient, launchCommand, manualHandoff } from '../src/clients.ts';
import { SKILLS_SOURCE, tempDir } from './helpers.ts';

const PROGRAM_LINE = 'Straddle Wizard program: straddle-plan → straddle-integrate. Start at straddle-plan.';
const CONTEXT = `${PROGRAM_LINE}\nRepository context confirmed in the Straddle Wizard: language TypeScript (detected); framework Next.js (detected).`;
// Flags that would replace the developer's own Cursor approval mode, sandbox, MCP approvals or workspace trust.
const PERMISSION_FLAGS = /^(-f|--force|--yolo|--sandbox|--approve-mcps|--trust|--auto-review)(=|$)/;

// Fake claude, codex and cursor-agent that record every call. `cursor-agent status` prints STATUS.
function fakeClients(status: string): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const dir = tempDir('fake-clients');
  const log = join(dir, 'calls.log');
  for (const [bin, version] of [['claude', '2.1.283 (Claude Code)'], ['codex', 'codex-cli 0.130.0'], ['cursor-agent', '2026.09.28-64d2043']]) {
    writeFileSync(join(dir, bin), `#!/bin/sh\necho "${bin} $*" >> '${log}'\ncase "$1" in --version) echo '${version}';; status) echo '${status}';; esac\n`);
    chmodSync(join(dir, bin), 0o755);
  }
  const home = join(dir, 'home');
  mkdirSync(home);
  return { env: { HOME: home, PATH: [dir, '/usr/bin', '/bin'].join(':') }, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const LAUNCH = { client: 'cursor', skill: 'straddle-plan', repo: '/repo', context: CONTEXT, settingsPath: '/run/session.settings.json', pluginDir: '/bundle' } as const;
for (const [name, resume, expected] of [
  ['new', null, ['--workspace', '/repo', '--plugin-dir', '/bundle', `Use the straddle-plan skill.\n${CONTEXT}`]],
  ['resumed', 'abc', ['--workspace', '/repo', '--plugin-dir', '/bundle', '--resume=abc', `Use the straddle-plan skill.\n${CONTEXT}`]],
] as const) {
  test(`Cursor, ${name}: cursor-agent starts with the developer's own approval mode, no permission, sandbox, MCP-approval or trust flag`, () => {
    const command = launchCommand({ ...LAUNCH, resume });
    assert.deepEqual(command, { bin: 'cursor-agent', args: expected });
    assert.deepEqual(command.args.filter((a) => PERMISSION_FLAGS.test(a)), []);
  });
}

test('Manual: the paste text is what Auto sends, and its program line begins a line exactly as wizard-program.md expects', () => {
  const contract = readFileSync(join(SKILLS_SOURCE, 'skills', 'straddle-best-practices', 'references', 'wizard-program.md'), 'utf8');
  assert.match(contract, /a line beginning `Straddle Wizard program:`/);
  for (const client of CLIENT_NAMES) {
    const { prompt, steps } = manualHandoff({ client, skill: 'straddle-plan', repo: '/repo', context: CONTEXT });
    assert.equal(prompt, launchCommand({ ...LAUNCH, client, resume: null }).args.at(-1), client);
    const lines = prompt.split('\n');
    assert.equal(lines[0], client === 'claude' ? '/straddle:straddle-plan' : 'Use the straddle-plan skill.');
    assert.equal(lines[1], PROGRAM_LINE);
    assert.equal(lines.filter((l) => l.includes('Straddle Wizard program:')).length, 1);
    assert.match(steps.join('\n'), /Open \/repo in .+ with the Straddle plugin installed/);
    assert.match(steps.at(-1)!, /`wizard resume`/);
  }
});

test('Manual never starts a client process', () => {
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const saved = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  try {
    for (const client of CLIENT_NAMES) manualHandoff({ client, skill: 'straddle-setup', repo: '/repo', context: CONTEXT });
  } finally {
    process.env.PATH = saved;
  }
  assert.deepEqual(fake.calls(), []);
  // The fakes do record a real call, so the empty log above means no client ran.
  inspectClient('cursor', fake.env);
  assert.deepEqual(fake.calls(), ['cursor-agent --version', 'cursor-agent status']);
});

test('Cursor: login from `cursor-agent status`, a local plugin copy checked against the bundle, and straddle-api matched by name suffix', () => {
  const check = loadLocalBundle(SKILLS_SOURCE);
  assert.ok(check.ok);
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const cursor = join(fake.env.HOME!, '.cursor');
  mkdirSync(join(cursor, 'plugins', 'local'), { recursive: true });
  symlinkSync(SKILLS_SOURCE, join(cursor, 'plugins', 'local', 'straddle'));
  writeFileSync(join(cursor, 'mcp.json'), JSON.stringify({ mcpServers: { 'straddle-api-old': {}, 'plugin-straddle-straddle-api': {} } }));
  const state = inspectClient('cursor', fake.env, check.bundle);
  assert.equal(state.version, '2026.09.28-64d2043');
  assert.equal(state.loggedIn, true);
  assert.deepEqual(state.plugin, { state: 'installed', version: check.bundle.pluginVersion, verified: true });
  assert.equal(state.apiMcp, 'plugin-straddle-straddle-api in ~/.cursor/mcp.json');

  const out = fakeClients('Not logged in');
  const bare = inspectClient('cursor', out.env, check.bundle);
  assert.equal(bare.loggedIn, false);
  assert.deepEqual(bare.plugin, { state: 'unverified', version: null, verified: false });
  assert.match(bare.apiMcp, /^declared by the Straddle plugin as plugin-<plugin dir>-straddle-api/);
});
