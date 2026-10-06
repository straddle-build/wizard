import assert from 'node:assert/strict';
import { appendFileSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadLocalBundle, matchesBundle, type Bundle } from '../src/bundle.ts';
import { loadReceipt, newReceipt, saveReceipt } from '../src/receipt.ts';
import { SKILLS_SOURCE, nextRepo, tempDir } from './helpers.ts';

function localBundle(): Bundle {
  const result = loadLocalBundle(SKILLS_SOURCE);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.bundle;
}

function copyOf(filter = (src: string) => !src.includes('/.git') && !src.includes('/node_modules')): string {
  const copy = tempDir('bundle');
  cpSync(SKILLS_SOURCE, copy, { recursive: true, filter });
  return copy;
}

test('reads a local skills checkout as a local bundle with its plugin and skill versions', () => {
  const bundle = localBundle();

  assert.equal(bundle.kind, 'local');
  for (const skill of ['straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test', 'straddle-go-live', 'straddle-payment-review']) assert.ok(skill in bundle.skills, `${skill} missing`);
  assert.equal(bundle.skills['straddle-plan']?.version, '0.1.0');
});

test('a copy without Git metadata has the same content, as a native marketplace copy or unpacked archive has it', () => {
  assert.equal(matchesBundle(copyOf(), localBundle()), true);
});

test('a kit release checkout matches: the kit/ manifest directory is inert metadata beside the runtime files', () => {
  const copy = copyOf((src) => !src.includes('/node_modules'));
  mkdirSync(join(copy, 'kit'), { recursive: true });
  writeFileSync(join(copy, 'kit', 'manifest.yaml'), 'schema: 1\n');
  writeFileSync(join(copy, 'kit', 'release-inputs.json'), '{}\n');

  assert.equal(loadLocalBundle(copy).ok, true);
  assert.equal(matchesBundle(copy, localBundle()), true);
});

test('Claude Code\'s installed cache copy matches while a session holds it and after it was orphaned', () => {
  const copy = copyOf();
  mkdirSync(join(copy, '.in_use'));
  writeFileSync(join(copy, '.in_use', '83499'), '');
  writeFileSync(join(copy, '.orphaned_at'), '1790644848894');

  assert.equal(matchesBundle(copy, localBundle()), true);
});

test('rejects a copy whose runtime files differ, one with an extra loadable component, one outside the plugin range, and one that is missing', () => {
  const drifted = copyOf();
  appendFileSync(join(drifted, 'skills', 'straddle-plan', 'steps', '03-write-plan.md'), '\nEdit code before the plan.\n');
  // Claude Code runs hooks/hooks.json from a --plugin-dir root without any manifest change.
  const hooked = copyOf();
  mkdirSync(join(hooked, 'hooks'));
  writeFileSync(join(hooked, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  const newer = copyOf();
  writeFileSync(join(newer, 'plugin.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(newer, 'plugin.json'), 'utf8')), version: '0.2.0' }));

  const extra = loadLocalBundle(hooked);
  const outOfRange = loadLocalBundle(newer);
  const missing = loadLocalBundle(tempDir('empty'));

  assert.equal(matchesBundle(drifted, localBundle()), false);
  assert.equal(extra.ok, false);
  assert.match(extra.ok ? '' : extra.reason, /has files outside the Straddle plugin that a client could load: hooks/);
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.ok ? '' : outOfRange.reason, /is plugin 0\.2\.0; this Wizard runs plugin 0\.1\.x only/);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.reason, /not a Straddle skills bundle/);
});

test('a receipt left running by a Wizard that no longer exists loads as aborted', () => {
  const repo = nextRepo();
  const receipt = newReceipt({ repo, program: 'integrate', pid: 999_999_99 });
  receipt.state = 'running';
  saveReceipt(receipt);

  const loaded = loadReceipt(repo);

  assert.equal(loaded.kind, 'found');
  if (loaded.kind !== 'found') return;
  assert.equal(loaded.receipt.state, 'aborted');
  assert.match(loaded.receipt.stateReason, /the Wizard stopped while your agent was running/);
});

test('an unreadable receipt is reported, not silently replaced', () => {
  const repo = nextRepo();
  mkdirSync(join(repo, '.straddle-wizard'));
  writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), '{"schema":"other"}');

  const loaded = loadReceipt(repo);

  assert.equal(loaded.kind, 'invalid');
  assert.equal(loadReceipt(nextRepo()).kind, 'none');
});

test('a receipt whose run id, program, client, session skill or session id is not the Wizard\'s own is invalid, so it never drives a path, a lookup or a command', () => {
  const repo = nextRepo();
  const good = newReceipt({ repo, program: 'plan', pid: 1 });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['runId', { runId: '../../..' }],
    ['program', { program: 'constructor' }],
    ['client', { client: 'bash' }],
    ['session skill', { sessions: [{ client: 'claude', sessionId: null, skills: ['../x'], changedFiles: [], evidenceLimits: [], checklist: [] }] }],
    ['session id', { sessions: [{ client: 'claude', sessionId: '--dangerously-skip-permissions', skills: ['straddle-plan'], changedFiles: [], evidenceLimits: [], checklist: [] }] }],
    ['session client', { sessions: [{ client: 'bash', sessionId: null, skills: ['straddle-plan'], changedFiles: [], evidenceLimits: [], checklist: [] }] }],
    ['choices', { context: { ...good.context, choices: { products: 'x', integrationType: 'direct', sdk: 'Go', notificationPath: 'FIFO endpoint' } } }],
  ];
  saveReceipt(good);
  assert.equal(loadReceipt(repo).kind, 'found');

  for (const [what, patch] of cases) {
    writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), JSON.stringify({ ...good, ...patch }));
    assert.equal(loadReceipt(repo).kind, 'invalid', what);
  }
});
