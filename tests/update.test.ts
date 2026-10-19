// `wizard update` and the guided run's plugin download from an older or edited release on this machine, against a
// local fixture server that answers like the GitHub releases and compare APIs. No real tag or release is used.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeClaude, releaseServer, runWizard, tempDir, writeFiles, type FakeClaude, type FixtureCommit, type FixtureRelease } from './helpers.ts';

const STAMP = 'Built by scripts/kit-release from 0123456789abcdef. Verify straddle-plugin-*.zip against SHA256SUMS.';
const COMMITS: FixtureCommit[] = [
  { message: 'fix(me-1001): an unobserved optional payout doesn\'t stop a Test pass\n\nLonger body.' },
  { message: 'evals: record the f55a762 full-batch pass' },
  { message: 'Merge pull request #42 from straddle-build/fix/program-stop-after-no\n\nbest-practices: a stopped step', parents: 2 },
  { message: 'best-practices: a key check never prints any part of the key' },
  { message: 'kit: bump the plugin version to 0.1.2' },
  { message: 'Add the advisory straddle-payment-review skill and Go Live warnings (ME-967)' },
  { message: 'test(evals): tighten approval graders (ME-920, ME-923)' },
  { message: 'ME-901: docs: revise setup' },
  { message: 'fix: [ME-901] refresh setup #123' },
  { message: 'fix(ME-1): keep transfer statuses (#39)' },
  { message: 'fix: show account details (ME-967)' },
  { message: 'build: add an important capability' },
  { message: 'style: make an important capability clearer' },
  { message: 'refactor: speed up an important capability' },
];

// The Wizard's plugin release cache under `cache`, and what it holds.
const wizardCache = (cache: string) => join(cache, 'straddle-wizard');
const plan = (cache: string) => join(wizardCache(cache), 'plugin', 'skills', 'straddle-plan', 'SKILL.md');
const keptCopies = (cache: string) => (existsSync(join(wizardCache(cache), 'edited')) ? readdirSync(join(wizardCache(cache), 'edited')) : []);
const recorded = (cache: string) => JSON.parse(readFileSync(join(wizardCache(cache), 'release.json'), 'utf8'));

// Runs the Wizard against fixture releases, sharing one cache and fake Claude Code across calls.
async function wizard(args: string[], releases: FixtureRelease[], cache: string, opts: { compare?: Record<string, FixtureCommit[]>; claude?: FakeClaude } = {}) {
  const server = await releaseServer(releases, opts.compare);
  const r = await runWizard(args, { cwd: tempDir('repo'), claude: opts.claude, env: { STRADDLE_WIZARD_BUNDLE: '', XDG_CACHE_HOME: cache, STRADDLE_WIZARD_RELEASES: server.url } });
  await server.close();
  return { ...r, requests: server.requests };
}

const OLD: FixtureRelease[] = [{ tag: 'v0.1.1', notes: STAMP }];
const NEW: FixtureRelease[] = [...OLD, { tag: 'v0.1.2', notes: `${STAMP}\n\n- Setup reports a newer kit and the command that updates it.` }];

test('update on an old install downloads the newest release and shows what changed since the installed one', async () => {
  const cache = tempDir('cache');
  const old = await wizard(['skill', 'list', '--yes'], OLD, cache);
  const r = await wizard(['update', '--yes'], NEW, cache, { compare: { 'v0.1.1...v0.1.2': COMMITS } });

  assert.equal(old.code, 0, old.stdout);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Plugin release v0\.1\.1 is on this machine\. The newest 0\.1\.x plugin release is v0\.1\.2/);
  assert.match(r.stdout, /What changed since v0\.1\.1:\n {4}v0\.1\.2 release notes:\n {6}- Setup reports a newer kit and the command that updates it\.\n/);
  assert.doesNotMatch(r.stdout, /Built by scripts\/kit-release/);
  assert.ok(r.stdout.includes([
    '    Changes to the skills (9 commits):',
    "      - fix: an unobserved optional payout doesn't stop a Test pass",
    '      - best-practices: a key check never prints any part of the key',
    '      - Add the advisory straddle-payment-review skill and Go Live warnings',
    '      - fix: refresh setup',
    '      - fix: keep transfer statuses',
    '      - fix: show account details',
    '      - build: add an important capability',
    '      - style: make an important capability clearer',
    '      - refactor: speed up an important capability',
    '    Every commit: https://github.com/straddle-build/skills/compare/v0.1.1...v0.1.2',
  ].join('\n')), r.stdout);
  assert.doesNotMatch(r.stdout, /\bME-\d+\b|#\d+\b/);
  assert.doesNotMatch(r.stdout, /docs: revise setup/);
  assert.match(r.stdout, /Verified straddle-plugin-0\.1\.2\.zip against the v0\.1\.2 SHA256SUMS\./);
  assert.match(r.stdout, /No agent here has the Straddle plugin installed/);
  assert.equal(recorded(cache).version, '0.1.2');
  assert.deepEqual(keptCopies(cache), []);
});

test('update says where to look when the commits between releases cannot be read', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], OLD, cache);
  const r = await wizard(['update', '--yes'], NEW, cache);

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /I couldn't list the commits \(GET http:\/\/127\.0\.0\.1:\d+\/compare\/v0\.1\.1\.\.\.v0\.1\.2: HTTP 404\); see https:\/\/github\.com\/straddle-build\/skills\/compare\/v0\.1\.1\.\.\.v0\.1\.2/);
  assert.equal(recorded(cache).version, '0.1.2');
});

test('update backs up locally edited skills, lists the edited files, says where the copy went, then installs the release clean', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], OLD, cache);
  appendFileSync(plan(cache), '\nAlways ask about refunds.\n');
  writeFileSync(join(wizardCache(cache), 'plugin', 'skills', 'straddle-plan', 'notes.md'), 'my notes\n');
  writeFiles(join(wizardCache(cache), 'plugin'), { 'docs/private-notes.md': 'keep this private note\n' });
  const r = await wizard(['update', '--yes'], NEW, cache, { compare: { 'v0.1.1...v0.1.2': COMMITS } });
  const status = await wizard(['status', '--json'], NEW, cache);

  assert.equal(r.code, 0, r.stdout + r.stderr);
  const kept = keptCopies(cache);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!, /^plugin-v0\.1\.1-\d{4}-\d\d-\d\dT/);
  const backup = join(wizardCache(cache), 'edited', kept[0]!);
  assert.match(readFileSync(join(backup, 'skills', 'straddle-plan', 'SKILL.md'), 'utf8'), /Always ask about refunds\./);
  assert.equal(readFileSync(join(backup, 'skills', 'straddle-plan', 'notes.md'), 'utf8'), 'my notes\n');
  assert.equal(readFileSync(join(backup, 'docs', 'private-notes.md'), 'utf8'), 'keep this private note\n');
  // Announced before the download, and confirmed with the exact place afterwards.
  assert.match(r.stdout, /Your copy at .*plugin no longer matches release v0\.1\.1\. I'll move it into .*edited rather than delete it, then install the clean release:\n {4}docs\/private-notes\.md \(added\)\n {4}skills\/straddle-plan\/SKILL\.md \(changed\)\n {4}skills\/straddle-plan\/notes\.md \(added\)\n/);
  assert.ok(r.stdout.includes(`Your edited copy of the Straddle skills is kept at ${backup}; ${join(wizardCache(cache), 'plugin')} now holds the clean release.`), r.stdout);
  assert.doesNotMatch(readFileSync(plan(cache), 'utf8'), /Always ask about refunds/);
  assert.equal(existsSync(join(wizardCache(cache), 'plugin', 'skills', 'straddle-plan', 'notes.md')), false);
  assert.equal(existsSync(join(wizardCache(cache), 'plugin', 'docs', 'private-notes.md')), false);
  const bundle = JSON.parse(status.stdout).bundle;
  assert.equal(bundle.error, undefined, bundle.error);
  assert.equal(bundle.pluginVersion, '0.1.2');
});

test('Claude Code bookkeeping does not mark an otherwise intact cache as edited', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], OLD, cache);
  writeFiles(join(wizardCache(cache), 'plugin'), { '.in_use/session': '1234\n', '.orphaned_at': '2026-10-19T12:00:00Z\n' });
  const r = await wizard(['update', '--yes'], NEW, cache);

  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /no longer matches|edited copy/);
  assert.deepEqual(keptCopies(cache), []);
});

test('an edited copy of the newest release is backed up too when the guided run downloads it again, and an intact one is replaced without a backup', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], NEW, cache);
  writeFileSync(plan(cache), 'replaced\n');
  const edited = await wizard(['skill', 'list', '--yes'], NEW, cache);
  const intact = await wizard(['update', '--yes'], [...NEW, { tag: 'v0.1.3' }], cache);

  assert.equal(edited.code, 0, edited.stdout);
  assert.match(edited.stdout, /no longer matches release v0\.1\.2\. .*\n {4}skills\/straddle-plan\/SKILL\.md \(changed\)\n/);
  assert.doesNotMatch(edited.stdout, /What changed since/);
  assert.equal(intact.code, 0, intact.stdout);
  assert.doesNotMatch(intact.stdout, /no longer matches|edited copy/);
  assert.deepEqual(keptCopies(cache).map((name) => name.slice(0, 'plugin-v0.1.2'.length)), ['plugin-v0.1.2']);
  assert.equal(readFileSync(join(wizardCache(cache), 'edited', keptCopies(cache)[0]!, 'skills', 'straddle-plan', 'SKILL.md'), 'utf8'), 'replaced\n');
});

test('an edited copy downloaded before the Wizard recorded each file is still backed up, and says it cannot list the files', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], OLD, cache);
  const { files: _files, ...record } = recorded(cache);
  writeFileSync(join(wizardCache(cache), 'release.json'), JSON.stringify(record));
  appendFileSync(plan(cache), '\nedit\n');
  const r = await wizard(['update', '--yes'], NEW, cache);

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /An earlier Wizard downloaded that copy without recording each file, so I can't list the files that differ\./);
  assert.equal(keptCopies(cache).length, 1);
});

test('update on the newest release changes nothing, reports agents that already have it, and names a release that needs a newer Wizard', async () => {
  const cache = tempDir('cache');
  const claude = fakeClaude();
  const install = await wizard(['install', '--client', 'claude', '--yes'], NEW, cache, { claude });
  const r = await wizard(['update', '--yes'], [...NEW, { tag: 'v0.2.0' }], cache, { claude });

  assert.equal(install.code, 0, install.stdout);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Straddle plugin release v0\.2\.0 is out, and it needs a newer Wizard than \S+: run `npx @straddlecom\/wizard@latest update`/);
  assert.match(r.stdout, /The Straddle skills on this machine are already the newest 0\.1\.x plugin release, v0\.1\.2\./);
  assert.match(r.stdout, /Claude Code already has these skills\./);
  assert.deepEqual(r.requests.filter((path) => path.endsWith('.zip')), []);
  assert.deepEqual(claude.calls().filter((call) => /install|uninstall/.test(call)).length, 1);
});

test('update does not call an offline cache the newest release', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], NEW, cache);
  const r = await runWizard(['update', '--yes'], {
    cwd: tempDir('repo'),
    env: { STRADDLE_WIZARD_BUNDLE: '', XDG_CACHE_HOME: cache, STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases' },
  });

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /I couldn't check for a newer Straddle plugin release/);
  assert.doesNotMatch(r.stdout, /already the newest/);
});

test('update gives a local Cursor copy its manual step even without cursor-agent', async () => {
  const cache = tempDir('cache');
  await wizard(['skill', 'list', '--yes'], OLD, cache);
  const home = tempDir('cursor-home');
  const local = join(home, '.cursor', 'plugins', 'local', 'straddle');
  mkdirSync(join(home, '.cursor', 'plugins', 'local'), { recursive: true });
  cpSync(join(wizardCache(cache), 'plugin'), local, { recursive: true });
  const server = await releaseServer(NEW);
  const r = await runWizard(['update', '--yes'], {
    cwd: tempDir('repo'),
    env: { HOME: home, PATH: '/usr/bin:/bin', STRADDLE_WIZARD_BUNDLE: '', XDG_CACHE_HOME: cache, STRADDLE_WIZARD_RELEASES: server.url },
  });
  await server.close();

  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Update the Straddle plugin in Cursor/);
  assert.match(r.stdout, /Update the "straddle" plugin from its team marketplace in Cursor\./);
  assert.doesNotMatch(r.stdout, /No agent here has the Straddle plugin installed/);
});
