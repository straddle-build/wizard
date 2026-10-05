import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadLocalBundle } from '../src/bundle.ts';
import { CLIENT_NAMES, inspectClient, launchCommand, manualHandoff } from '../src/clients.ts';
import { SKILLS_SOURCE, fakeClients } from './helpers.ts';

const PROGRAM_LINE = 'Straddle Wizard program: straddle-plan → straddle-integrate. Start at straddle-plan.';
const CONTEXT = `${PROGRAM_LINE}\nRepository context confirmed in the Straddle Wizard: language TypeScript (detected); framework Next.js (detected).`;
// Flags that would replace the developer's own Cursor approval mode, sandbox, MCP approvals or workspace trust.
const PERMISSION_FLAGS = /^(-f|--force|--yolo|--sandbox|--approve-mcps|--trust|--auto-review)(=|$)/;

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
    const { prompt, steps } = manualHandoff({ client, skill: 'straddle-plan', repo: '/repo', context: CONTEXT, cliDir: '/opt/wizard cli/vendor', platform: 'darwin' });
    assert.equal(prompt, launchCommand({ ...LAUNCH, client, resume: null }).args.at(-1), client);
    const lines = prompt.split('\n');
    assert.equal(lines[0], client === 'claude' ? '/straddle:straddle-plan' : 'Use the straddle-plan skill.');
    assert.equal(lines[1], PROGRAM_LINE);
    assert.equal(lines.filter((l) => l.includes('Straddle Wizard program:')).length, 1);
    assert.match(steps.join('\n'), /Open \/repo in .+ with the Straddle plugin installed/);
    assert.match(steps[0]!, / Start it from a shell where you ran `export PATH='\/opt\/wizard cli\/vendor':\$PATH`, so the skills' `straddle` commands use the Wizard's Straddle CLI\.$/);
    const windows = manualHandoff({ client, skill: 'straddle-plan', repo: 'C:\\repo', context: CONTEXT, cliDir: "C:\\Users\\o'neil\\wizard\\vendor", platform: 'win32' });
    assert.ok(windows.steps[0]!.endsWith(" Start it from PowerShell where you ran `$env:Path = 'C:\\Users\\o''neil\\wizard\\vendor;' + $env:Path`, so the skills' `straddle` commands use the Wizard's Straddle CLI."), windows.steps[0]);
    assert.match(steps.at(-1)!, /`wizard resume`/);
  }
});

test('Manual never starts a client process', () => {
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const saved = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  try {
    for (const client of CLIENT_NAMES) manualHandoff({ client, skill: 'straddle-setup', repo: '/repo', context: CONTEXT, cliDir: null, platform: 'darwin' });
  } finally {
    process.env.PATH = saved;
  }
  assert.deepEqual(fake.calls(), []);
  // The fakes do record a real call, so the empty log above means no client ran.
  inspectClient('cursor', fake.env);
  assert.deepEqual(fake.calls(), ['cursor-agent --version', 'cursor-agent status']);
});

test('Cursor: login from `cursor-agent status`, a local plugin copy checked against the bundle, and straddle-api claimed only from a file that declares it, matched by name suffix', () => {
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
  // Without a configured server, the local plugin's own mcp.json declares it, under Cursor's prefixed name.
  writeFileSync(join(cursor, 'mcp.json'), JSON.stringify({ mcpServers: { 'straddle-api-old': {} } }));
  assert.match(inspectClient('cursor', fake.env, check.bundle).apiMcp, /^declared by the Straddle plugin in .+\/plugins\/local\/straddle, which Cursor names plugin-straddle-straddle-api;/);

  const out = fakeClients('Not logged in');
  const bare = inspectClient('cursor', out.env, check.bundle);
  assert.equal(bare.loggedIn, false);
  assert.deepEqual(bare.plugin, { state: 'unverified', version: null, verified: false });
  // An empty Cursor home: cursor-agent being installed is no evidence of a Straddle server.
  assert.match(bare.apiMcp, /^not detected: no straddle-api/);
});
