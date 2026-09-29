import assert from 'node:assert/strict';
import { appendFileSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../src/bundle.ts';
import { loadReceipt, newReceipt, saveReceipt } from '../src/receipt.ts';
import { SKILLS_SOURCE, nextRepo, tempDir } from './helpers.ts';

test('verifies the pinned merged-source snapshot by content and reads skill versions from it', () => {
  const result = loadBundle(SKILLS_SOURCE);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.kind, 'merged-source-snapshot');
  assert.equal(result.bundle.commit, 'f713fc6201ad0fd800d23a3ec4c4102b7acee91c');
  assert.equal(result.bundle.pluginVersion, '0.1.0');
  assert.deepEqual(Object.keys(result.bundle.skills).sort(), [
    'straddle-audit', 'straddle-best-practices', 'straddle-get-started', 'straddle-go-live', 'straddle-integrate',
    'straddle-migrate', 'straddle-plan', 'straddle-setup', 'straddle-test',
  ]);
  assert.equal(result.bundle.skills['straddle-plan']?.version, '0.1.0');
});

test('accepts the same content without Git metadata, as a native marketplace copy or unpacked archive has it', () => {
  const copy = tempDir('bundle');
  cpSync(SKILLS_SOURCE, copy, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });

  assert.equal(loadBundle(copy).ok, true);
});

test('rejects a bundle whose runtime files differ from the pinned snapshot, one with an extra loadable component, and one that is missing', () => {
  const copy = tempDir('bundle');
  cpSync(SKILLS_SOURCE, copy, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });
  appendFileSync(join(copy, 'skills', 'straddle-plan', 'steps', '03-write-plan.md'), '\nEdit code before the plan.\n');
  // Claude Code runs hooks/hooks.json from a --plugin-dir root without any manifest change.
  const hooked = tempDir('bundle');
  cpSync(SKILLS_SOURCE, hooked, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });
  mkdirSync(join(hooked, 'hooks'));
  writeFileSync(join(hooked, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));

  const drifted = loadBundle(copy);
  const extra = loadBundle(hooked);
  const missing = loadBundle(tempDir('empty'));

  assert.equal(drifted.ok, false);
  assert.match(drifted.ok ? '' : drifted.reason, /does not match the pinned straddle-build\/skills@f713fc6 snapshot/);
  assert.equal(extra.ok, false);
  assert.match(extra.ok ? '' : extra.reason, /outside the pinned straddle-build\/skills@f713fc6 snapshot that a client could load: hooks/);
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
  assert.match(loaded.receipt.stateReason, /Wizard stopped while a step was running/);
});

test('an unreadable receipt is reported, not silently replaced', () => {
  const repo = nextRepo();
  mkdirSync(join(repo, '.straddle-wizard'));
  writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), '{"schema":"other"}');

  const loaded = loadReceipt(repo);

  assert.equal(loaded.kind, 'invalid');
  assert.equal(loadReceipt(nextRepo()).kind, 'none');
});

test('a receipt whose run id, program, client or step skill is not the Wizard\'s own is invalid, so it never drives a path or a lookup', () => {
  const repo = nextRepo();
  const good = newReceipt({ repo, program: 'plan', pid: 1 });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['runId', { runId: '../../..' }],
    ['program', { program: 'constructor' }],
    ['client', { client: 'bash' }],
    ['step skill', { steps: [{ skill: '../x', observedSteps: [], observedEvents: [], reportedMarkers: [], changedFiles: [], evidenceLimits: [], checklist: [], advanced: false }] }],
    ['choices', { context: { ...good.context, choices: { products: 'x', integrationType: 'direct', sdk: 'Go', notificationPath: 'FIFO endpoint' } } }],
  ];
  saveReceipt(good);
  assert.equal(loadReceipt(repo).kind, 'found');

  for (const [what, patch] of cases) {
    writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), JSON.stringify({ ...good, ...patch }));
    assert.equal(loadReceipt(repo).kind, 'invalid', what);
  }
});
