// Client inspection reads a client's stdout only: a harmless warning on stderr (Codex prints one when CODEX_HOME is
// under a temporary directory) must not change what the Wizard reports.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { inspectClient } from '../src/clients.ts';
import { tempDir } from './helpers.ts';

const WARNING = 'WARNING: Refusing to create helper binaries under temporary dir "/tmp/x" (codex_home: /tmp/x/codex-home)';

// A fake client that answers each subcommand with `outputs[args]` on stdout and always prints WARNING on stderr.
function fakeClient(bin: string, outputs: Record<string, string>) {
  const dir = tempDir(`fake-${bin}`);
  const cases = Object.entries(outputs).map(([args, out]) => `  ${JSON.stringify(args)}) printf '%s\\n' '${out}' ;;`).join('\n');
  writeFileSync(join(dir, bin), `#!/bin/sh\necho '${WARNING}' >&2\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`);
  chmodSync(join(dir, bin), 0o755);
  return { HOME: dir, CODEX_HOME: join(dir, 'codex-home'), PATH: [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':') };
}

test('Codex: a stderr warning does not hide the installed plugin or the API MCP', () => {
  const env = fakeClient('codex', {
    '--version': 'codex-cli 0.156.1',
    'login status': 'Logged in using ChatGPT',
    'plugin list --json': JSON.stringify({ installed: [{ pluginId: 'straddle@straddle', version: '0.1.0' }] }),
    'plugin marketplace list --json': JSON.stringify({ marketplaces: [{ name: 'straddle', root: '/m' }] }),
    'mcp list --json': JSON.stringify([{ name: 'straddle-api', transport: { bearer_token_env_var: 'STRADDLE_API_KEY' } }]),
  });
  const state = inspectClient('codex', env);
  assert.equal(state.version, '0.156.1');
  assert.deepEqual(state.plugin, { state: 'installed', version: '0.1.0', verified: false });
  assert.equal(state.marketplacePath, '/m');
  assert.equal(state.apiMcp, 'straddle-api reads STRADDLE_API_KEY (codex mcp)');
});

test('Claude Code: a stderr warning does not hide login, the installed plugin or its marketplace', () => {
  const env = fakeClient('claude', {
    '--version': '2.1.0 (Claude Code)',
    'auth status --json': JSON.stringify({ loggedIn: true }),
    'plugin list --json': JSON.stringify([{ id: 'straddle@straddle', version: '0.1.0', installPath: '/c' }]),
    'plugin marketplace list --json': JSON.stringify([{ name: 'straddle', installLocation: '/m' }]),
  });
  const state = inspectClient('claude', env);
  assert.equal(state.loggedIn, true);
  assert.deepEqual(state.plugin, { state: 'installed', version: '0.1.0', verified: false });
  assert.equal(state.marketplacePath, '/m');
});

test('Cursor: a stderr warning does not become part of the reported version', () => {
  const state = inspectClient('cursor', fakeClient('cursor-agent', { '--version': 'nightly' }));
  assert.equal(state.version, 'nightly');
});
