// Plugin releases from a local fixture server that answers like the GitHub releases API. No real tag or release is used.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { unpackRelease } from '../src/bundle.ts';
import { pluginZip, releaseServer, runWizard, sha256, storedZip, tempDir, type FixtureRelease } from './helpers.ts';

async function skillList(releases: FixtureRelease[], cache = tempDir('cache')) {
  const server = await releaseServer(releases);
  const env = { STRADDLE_WIZARD_BUNDLE: '', XDG_CACHE_HOME: cache, STRADDLE_WIZARD_RELEASES: server.url };
  const r = await runWizard(['skill', 'list', '--yes'], { cwd: tempDir('repo'), env });
  await server.close();
  return { ...r, cache, env, requests: server.requests };
}

// What the Wizard left in its cache directory.
const cached = (cache: string) => (existsSync(join(cache, 'straddle-wizard')) ? readdirSync(join(cache, 'straddle-wizard')) : []);

test('downloads the newest release in the compatible range, skipping prereleases and newer out-of-range releases', async () => {
  const r = await skillList([{ tag: 'v0.1.0' }, { tag: 'v0.2.0' }, { tag: 'v0.1.5', prerelease: true }, { tag: 'v0.1.2' }, { tag: 'v0.1.9-rc.1' }]);

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Skills in the plugin release v0\.1\.2 of straddle-build\/skills \(9 skills, verified against its published SHA256SUMS\):/);
  assert.deepEqual(r.requests.filter((path) => path.endsWith('.zip')), ['/v0.1.2/straddle-plugin-0.1.2.zip']);
  const record = JSON.parse(readFileSync(join(r.cache, 'straddle-wizard', 'release.json'), 'utf8'));
  assert.equal(record.version, '0.1.2');
  assert.equal(record.archiveSha256, sha256(pluginZip('0.1.2')));
});

test('refuses a release whose archive does not match its SHA256SUMS, without falling back or keeping anything', async () => {
  const r = await skillList([{ tag: 'v0.1.0' }, { tag: 'v0.1.2', sums: `${'0'.repeat(64)}  straddle-plugin-0.1.2.zip\n` }]);

  assert.equal(r.code, 1);
  assert.match(r.stdout, /straddle-plugin-0\.1\.2\.zip \(sha256 [0-9a-f]{64}\) does not match the release's SHA256SUMS \(0{64}\); the Wizard refuses it\./);
  assert.deepEqual(cached(r.cache), []);
});

test('refuses a plugin outside the compatible range, whether by tag or by the plugin inside a release', async () => {
  const newer = await skillList([{ tag: 'v0.2.0' }]);
  const mislabelled = await skillList([{ tag: 'v0.1.3', zip: pluginZip('0.2.0') }]);
  const mismatched = await skillList([{ tag: 'v0.1.3', zip: pluginZip('0.1.1') }]);

  assert.equal(newer.code, 1);
  assert.match(newer.stdout, /The newest Straddle plugin release, v0\.2\.0, is outside this Wizard's 0\.1\.x range\./);
  assert.deepEqual(newer.requests, ['/releases']);
  assert.equal(mislabelled.code, 1);
  assert.match(mislabelled.stdout, /is plugin 0\.2\.0; this Wizard runs plugin 0\.1\.x only/);
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.stdout, /straddle-plugin-0\.1\.3\.zip holds plugin 0\.1\.1, not 0\.1\.3\./);
  for (const r of [mislabelled, mismatched]) assert.deepEqual(cached(r.cache), []);
});

test('a cached release is re-verified on every use: an edited copy is refused, and an unreachable release list falls back to an intact one', async () => {
  const first = await skillList([{ tag: 'v0.1.2' }]);
  const offline = await runWizard(['skill', 'list'], { cwd: tempDir('repo'), env: { ...first.env, STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases' } });
  appendFileSync(join(first.cache, 'straddle-wizard', 'plugin', 'skills', 'straddle-plan', 'SKILL.md'), '\nEdit code before the plan.\n');
  const edited = await runWizard(['status', '--json'], { cwd: tempDir('repo'), env: first.env });
  const refreshed = await skillList([{ tag: 'v0.1.2' }], first.cache);

  assert.equal(offline.code, 0, offline.stdout);
  assert.match(offline.stdout, /Could not check for a newer Straddle plugin release \(.*\); using the plugin release v0\.1\.2 of straddle-build\/skills .* already on this machine\./);
  assert.match(JSON.parse(edited.stdout).bundle.error, /no longer matches plugin release v0\.1\.2 as the Wizard verified it/);
  assert.equal(refreshed.code, 0, refreshed.stdout);
  assert.deepEqual(refreshed.requests.filter((path) => path.endsWith('.zip')), ['/v0.1.2/straddle-plugin-0.1.2.zip']);
});

test('unpacking refuses entries that could escape the plugin directory or are not regular files, even with a matching checksum', () => {
  const plugin = { name: 'plugin.json', data: Buffer.from('{"version":"0.1.2"}') };
  const cases = {
    'unsafe path': storedZip([plugin, { name: '../escape.txt', data: Buffer.from('x') }]),
    'not a stored regular file': storedZip([plugin, { name: 'skills/link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }]),
  };
  for (const [reason, archive] of Object.entries(cases)) {
    const root = tempDir('unpack');
    const result = unpackRelease({ version: '0.1.2', archive, sums: `${sha256(archive)}  straddle-plugin-0.1.2.zip\n` }, join(root, 'plugin'));

    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, new RegExp(reason));
    assert.equal(existsSync(join(root, 'escape.txt')), false);
  }
});
