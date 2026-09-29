import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover, snapshot, changedFiles } from '../src/discovery.ts';
import { nextRepo, tempDir, writeFiles } from './helpers.ts';

test('detects language, framework, provider code and the declared Straddle SDK from manifests', () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': JSON.stringify({ dependencies: { next: '15.0.0', '@straddlecom/straddle': '^1.0.4', stripe: '17.0.0' }, devDependencies: { typescript: '5.6.0' } }) });

  const facts = discover(repo, []);

  assert.equal(facts.language.value, 'TypeScript');
  assert.equal(facts.framework.value, 'Next.js');
  assert.deepEqual(facts.straddleSdk, { package: '@straddlecom/straddle', version: '^1.0.4', manifest: 'package.json' });
  assert.deepEqual(facts.providers, ['stripe']);
});

test('reports unknown instead of guessing when no manifest names a language', () => {
  const repo = tempDir('empty');
  writeFiles(repo, { 'README.md': '# app\n' });

  const facts = discover(repo, []);

  assert.equal(facts.language.value, 'unknown');
  assert.equal(facts.framework.value, 'unknown');
  assert.equal(facts.straddleSdk, null);
});

test('malformed package.json yields detection error without false detection', () => {
  const repo = tempDir('malformed');
  writeFiles(repo, { 'package.json': '{ invalid json: }', 'tsconfig.json': '{}' });

  const facts = discover(repo, []);

  assert.equal(facts.language.value, 'unknown');
  assert.equal(facts.framework.value, 'unknown');
  assert.equal(facts.straddleSdk, null);
  assert.deepEqual(facts.errors, ['package.json is malformed JSON']);
});

test('never opens secrets, keys, CLI configuration or configured sensitive paths', () => {
  const repo = nextRepo();
  writeFiles(repo, {
    '.env': 'STRADDLE_API_KEY=sk_live_never',
    '.env.local': 'x',
    'config/server.pem': 'x',
    'deploy/id_ed25519': 'x',
    '.npmrc': '//registry/:_authToken=x',
    '.straddle/config.toml': 'x',
    'secrets/prod.json': 'x',
    'internal/customers.csv': 'x',
  });
  // Unreadable files prove discovery and snapshots do not open them: any read would throw EACCES.
  for (const path of ['.env', '.env.local', 'config/server.pem', 'deploy/id_ed25519', '.npmrc', '.straddle/config.toml', 'secrets/prod.json', 'internal/customers.csv']) {
    chmodSync(join(repo, path), 0o000);
  }

  const facts = discover(repo, ['internal/**']);
  const snap = snapshot(repo, ['internal/**']);

  const excluded = Object.fromEntries(facts.excluded.map((e) => [e.path, e.reason]));
  assert.equal(excluded['.env'], 'environment file');
  assert.equal(excluded['.env.local'], 'environment file');
  assert.equal(excluded['config/server.pem'], 'private key or certificate');
  assert.equal(excluded['deploy/id_ed25519'], 'private key or certificate');
  assert.equal(excluded['.npmrc'], 'credential or CLI configuration');
  assert.equal(excluded['.straddle'], 'credential or CLI configuration');
  assert.equal(excluded['secrets'], 'credential or CLI configuration');
  assert.equal(excluded['internal/customers.csv'], 'configured sensitive path');
  assert.ok(!Object.keys(snap.hashes).some((p) => p.startsWith('.env') || p.startsWith('internal/')));
});

test('does not follow symlinks, and names the ones that escape the repository', () => {
  const outside = tempDir('outside');
  writeFiles(outside, { 'requirements.txt': 'django==5.0\n', 'secret.txt': 'hunter2' });
  const repo = nextRepo();
  symlinkSync(outside, join(repo, 'vendor-link'));
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'notes.txt'));
  symlinkSync(join(repo, 'src'), join(repo, 'src-alias'));

  const facts = discover(repo, []);
  const snap = snapshot(repo, []);

  const excluded = Object.fromEntries(facts.excluded.map((e) => [e.path, e.reason]));
  assert.equal(excluded['vendor-link'], 'symlink escapes the repository');
  assert.equal(excluded['notes.txt'], 'symlink escapes the repository');
  assert.equal(excluded['src-alias'], 'symlink not followed');
  assert.equal(facts.language.value, 'TypeScript');
  assert.ok(!('notes.txt' in snap.hashes));
});

test('changed files compare two snapshots, including created and deleted files', () => {
  const repo = nextRepo();
  const before = snapshot(repo, []);
  writeFiles(repo, { 'src/app/page.tsx': 'changed', 'src/straddle.ts': 'new' });

  assert.deepEqual(changedFiles(before, snapshot(repo, [])), ['src/app/page.tsx', 'src/straddle.ts']);
});

test('an unreadable directory is skipped and named, and the snapshot says which paths it could not compare', () => {
  const repo = nextRepo();
  mkdirSync(join(repo, 'locked'));
  writeFiles(repo, { 'locked/build.log': 'x' });
  chmodSync(join(repo, 'locked'), 0o000);

  const facts = discover(repo, []);
  const snap = snapshot(repo, []);

  assert.deepEqual(facts.excluded, [{ path: 'locked', reason: 'unreadable' }]);
  assert.equal(facts.language.value, 'TypeScript');
  assert.deepEqual(snap.limits, ['not readable, so not compared: locked']);
  chmodSync(join(repo, 'locked'), 0o755);
});
