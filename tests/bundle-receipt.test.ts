import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../src/bundle.ts';
import { loadReceipt, newReceipt, saveReceipt } from '../src/receipt.ts';
import { SKILLS_SOURCE, nextRepo, tempDir } from './helpers.ts';

test('verifies the pinned merged-source bundle and reads skill versions from it', () => {
  const result = loadBundle(SKILLS_SOURCE);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.kind, 'merged-source-development');
  assert.equal(result.bundle.commit, 'f713fc6201ad0fd800d23a3ec4c4102b7acee91c');
  assert.equal(result.bundle.pluginVersion, '0.1.0');
  assert.deepEqual(Object.keys(result.bundle.skills).sort(), [
    'straddle-audit', 'straddle-best-practices', 'straddle-get-started', 'straddle-go-live', 'straddle-integrate',
    'straddle-migrate', 'straddle-plan', 'straddle-setup', 'straddle-test',
  ]);
  assert.equal(result.bundle.skills['straddle-plan']?.version, '0.1.0');
});

test('rejects a bundle that is not the pinned commit, and one that is missing', () => {
  const copy = tempDir('bundle');
  cpSync(SKILLS_SOURCE, copy, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });
  execFileSync('git', ['init', '-q'], { cwd: copy });

  const drifted = loadBundle(copy);
  const missing = loadBundle(undefined);

  assert.equal(drifted.ok, false);
  assert.match(drifted.ok ? '' : drifted.reason, /not the pinned commit f713fc6/);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.reason, /No published Straddle plugin release/);
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
