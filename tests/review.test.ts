import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findBundle } from '../src/journey.ts';
import { codeHash, ensureBaseline, parseReport, runRef, saveReport, writeReviewScope } from '../src/review.ts';
import { followCodex } from '../src/codex.ts';
import { SKILLS_SOURCE, tempDir } from './helpers.ts';

const HASH = 'a'.repeat(64);
const REPORT = ['# Straddle payment review', '', 'Status: findings', `Plan hash: ${HASH}`, `Code hash: ${'b'.repeat(64)}`, '', '| Severity | File:line | Risk | Fix |', '| --- | --- | --- | --- |', '| High | src/refund.ts:9 | any user can refund any order | check the order owner |'];
const BEGIN = 'STRADDLE_REPORT_BEGIN {"skill":"straddle-payment-review","file":"straddle-payment-review.md"}';
const END = 'STRADDLE_REPORT_END {"skill":"straddle-payment-review"}';
const handoff = (status: string) => `STRADDLE_HANDOFF {"skill":"straddle-payment-review","status":"${status}","report":"straddle-payment-review.md: summary"}`;
const printed = (report: string[], status = 'findings') => ['Here is the review.', BEGIN, ...report, END, handoff(status)].join('\n');

test('a printed report is accepted only as the contract says: the last complete block, its handoff, its header lines', () => {
  assert.deepEqual(parseReport(printed(REPORT)), { ok: true, payload: `${REPORT.join('\n')}\n`, status: 'findings', statusLine: 'findings', planHash: HASH, codeHash: 'b'.repeat(64) });
  // Carriage returns go; the last of two complete blocks counts.
  const older = REPORT.map((l) => l.replace('findings', 'clean'));
  const both = [BEGIN, ...older, END, handoff('clean'), BEGIN, ...REPORT.map((l) => `${l}\r`), END, handoff('findings')].join('\n');
  const last = parseReport(both);
  assert.equal(last.ok ? last.payload : last.reason, `${REPORT.join('\n')}\n`);
  const rejected = (raw: string) => { const r = parseReport(raw); return r.ok ? 'accepted' : r.reason; };
  assert.equal(rejected('No report here.'), 'the review printed no report');
  assert.equal(rejected([BEGIN, ...REPORT, handoff('findings')].join('\n')), 'the report has no end line');
  assert.equal(rejected([BEGIN, ...REPORT.slice(0, 3), BEGIN, ...REPORT, END, handoff('findings')].join('\n')), 'a second report begins inside the report');
  assert.equal(rejected(printed(REPORT, 'clean')), 'no handoff with status findings follows the report');
  assert.equal(rejected([BEGIN, ...REPORT, END].join('\n')), 'no handoff with status findings follows the report');
  assert.equal(rejected(printed(['```markdown', ...REPORT, '```'])), 'the report has no "# Straddle payment review" heading');
  assert.equal(rejected(printed(REPORT.filter((l) => !l.startsWith('Code hash')))), 'the report lacks its Status, Plan hash or Code hash line');
  assert.equal(rejected(printed(REPORT.map((l) => (l.startsWith('Status') ? 'Status: fine' : l)))), 'the report lacks its Status, Plan hash or Code hash line');
  assert.equal(rejected(printed([...REPORT, 'x'.repeat(64 * 1024)])), 'the report is over 64 KiB');
  // A delimiter for another skill or file is not this report's.
  assert.equal(rejected(printed(REPORT).replace('"file":"straddle-payment-review.md"', '"file":"src/app.ts"')), 'the review printed no report');
  const incomplete = parseReport(printed(REPORT.map((l) => (l.startsWith('Status') ? 'Status: incomplete (no session baseline)' : l.startsWith('Code hash') ? 'Code hash: none' : l)), 'incomplete'));
  assert.deepEqual(incomplete.ok && [incomplete.status, incomplete.statusLine, incomplete.codeHash], ['incomplete', 'incomplete (no session baseline)', null]);
});

test('the saved report replaces only a regular file: a symlink at its name is refused and its target untouched', () => {
  const repo = tempDir('review-save');
  mkdirSync(join(repo, '.straddle-wizard'));
  assert.deepEqual(saveReport(repo, 'first\n'), { ok: true });
  assert.deepEqual(saveReport(repo, 'second\n'), { ok: true });
  assert.equal(readFileSync(join(repo, 'straddle-payment-review.md'), 'utf8'), 'second\n');
  const linked = tempDir('review-link');
  mkdirSync(join(linked, '.straddle-wizard'));
  mkdirSync(join(linked, 'src'));
  writeFileSync(join(linked, 'src', 'app.ts'), 'export const app = 1;\n');
  symlinkSync('src/app.ts', join(linked, 'straddle-payment-review.md'));
  assert.deepEqual(saveReport(linked, '# Straddle payment review\n'), { ok: false, reason: "straddle-payment-review.md in the repository isn't a regular file, so I didn't replace it" });
  assert.equal(readFileSync(join(linked, 'src', 'app.ts'), 'utf8'), 'export const app = 1;\n');
});

function gitRepo(label: string): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = realpathSync(tempDir(label));
  // No user identity anywhere: the baseline still commits.
  const env = { ...process.env, HOME: tempDir(`${label}-home`), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: tempDir(`${label}-xdg`) };
  delete env.GIT_AUTHOR_NAME; delete env.GIT_AUTHOR_EMAIL; delete env.GIT_COMMITTER_NAME; delete env.GIT_COMMITTER_EMAIL;
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  mkdirSync(join(repo, '.straddle-wizard'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = 1;\n');
  return { repo, env };
}

test('one baseline per Wizard run: taken once, kept under the run ref across resumes, never by a repository hook, and a new run takes its own', () => {
  const check = findBundle({ override: SKILLS_SOURCE, env: process.env });
  assert.ok(check.ok, check.ok ? '' : check.reason);
  const bundle = check.bundle;
  const { repo, env } = gitRepo('review-base');
  const sentinel = join(repo, 'hook-ran');
  writeFileSync(join(repo, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${sentinel}'\n`);
  chmodSync(join(repo, '.git', 'hooks', 'reference-transaction'), 0o755);
  const run = '6f1c2a3b-0000-4000-8000-000000000001';
  const first = ensureBaseline(repo, run, bundle, env, [], true);
  assert.ok(first.ok && first.created, JSON.stringify(first));
  const saved = readFileSync(join(repo, '.straddle-wizard', 'session-baseline.json'), 'utf8');
  assert.equal(JSON.parse(saved).snapshot, execFileSync('git', ['rev-parse', runRef(run)], { cwd: repo, encoding: 'utf8' }).trim());
  assert.equal(JSON.parse(saved).head, null);
  assert.equal(existsSync(sentinel), false, 'the repository hook ran');
  const start = codeHash(repo, bundle, first.baseline.snapshot, env, []);
  // A session edit after the baseline: the resume keeps the start, so the edit stays attributed to the session.
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = 2;\n');
  const again = ensureBaseline(repo, run, bundle, env, [], false);
  assert.deepEqual(again, { ok: true, baseline: first.baseline, created: false });
  assert.equal(readFileSync(join(repo, '.straddle-wizard', 'session-baseline.json'), 'utf8'), saved);
  const now = codeHash(repo, bundle, first.baseline.snapshot, env, []);
  assert.ok(start.ok && now.ok && start.hash !== now.hash);
  const next = ensureBaseline(repo, '6f1c2a3b-0000-4000-8000-000000000002', bundle, env, [], true);
  assert.ok(next.ok && next.created && next.baseline.snapshot !== first.baseline.snapshot);
});

test('sensitive and --exclude paths never enter the snapshot or the review scope, at start or after a resume adds a glob', () => {
  const check = findBundle({ override: SKILLS_SOURCE, env: process.env });
  assert.ok(check.ok, check.ok ? '' : check.reason);
  const { repo, env } = gitRepo('review-exclusions');
  const marker = 'zqsentinel-not-a-secret';
  const sensitive = ['.npmrc', 'id_rsa', 'certs/certificate.CRT', 'deploy/.ssh/config', 'app/Secrets.json', 'infra/prod.tfvars'];
  const globbed = ['fixtures/[draft].ts', 'notes/a.md', 'deep/x/notes/b.md'];
  const later = 'src/legacy.ts';
  for (const rel of [...sensitive, ...globbed, later]) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), `${marker}\n`);
  }
  // `*` stays within one directory, `**/` matches zero or more, and brackets are literal.
  const exclude = ['fixtures/[draft].ts', '**/notes/*.md'];
  const run = '6f1c2a3b-0000-4000-8000-000000000007';
  const first = ensureBaseline(repo, run, check.bundle, env, exclude, true);
  assert.ok(first.ok, JSON.stringify(first));
  const stored = execFileSync('git', ['ls-tree', '-r', '--name-only', first.baseline.snapshot], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(stored.sort(), ['src/app.ts', later].sort());
  for (const rel of [...sensitive, ...globbed, later, 'src/app.ts']) writeFileSync(join(repo, rel), `${marker} changed\n`);
  // A resume adds a glob for a file already in the snapshot: its old bytes never reach the scope.
  const resumed = [...exclude, 'src/legacy.ts'];
  const dir = join(repo, '.straddle-wizard', 'runs', run, 'review-scope');
  const scope = writeReviewScope(repo, check.bundle, first.baseline.snapshot, 'none', env, resumed, dir);
  assert.ok(scope.ok, JSON.stringify(scope));
  assert.deepEqual(readFileSync(join(dir, 'changes.txt'), 'utf8').split('\n').slice(1), ['modified src/app.ts', '']);
  assert.deepEqual(readdirSync(join(dir, 'start'), { recursive: true }).sort(), ['src', 'src/app.ts']);
  const now = codeHash(repo, check.bundle, first.baseline.snapshot, env, resumed);
  assert.ok(now.ok && scope.ok && now.hash === scope.hash);
  assert.deepEqual(writeReviewScope(repo, check.bundle, first.baseline.snapshot, 'none', env, ['a\nb'], dir), { ok: false, reason: 'an --exclude path holds a line break' });
});

test('the review scope is written before launch from raw bytes: a configured clean filter, textconv and hook never run', () => {
  const check = findBundle({ override: SKILLS_SOURCE, env: process.env });
  assert.ok(check.ok, check.ok ? '' : check.reason);
  const { repo, env } = gitRepo('review-scope');
  const run = '6f1c2a3b-0000-4000-8000-000000000003';
  const first = ensureBaseline(repo, run, check.bundle, env, [], true);
  assert.ok(first.ok);
  writeFileSync(join(repo, '.gitattributes'), '*.ts filter=trap diff=trap\n');
  for (const [key, value] of [['filter.trap.clean', 'touch ran-clean; cat'], ['filter.trap.smudge', 'touch ran-smudge; cat'], ['diff.trap.textconv', 'touch ran-textconv; cat'], ['core.hooksPath', join(repo, '.git', 'trap-hooks')]] as const) execFileSync('git', ['config', key, value], { cwd: repo });
  mkdirSync(join(repo, '.git', 'trap-hooks'));
  writeFileSync(join(repo, '.git', 'trap-hooks', 'post-index-change'), '#!/bin/sh\ntouch ran-hook\n');
  chmodSync(join(repo, '.git', 'trap-hooks', 'post-index-change'), 0o755);
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = 2;\n');
  const dir = join(repo, '.straddle-wizard', 'runs', run, 'review-scope');
  const scope = writeReviewScope(repo, check.bundle, first.baseline.snapshot, 'none', env, [], dir);
  const now = codeHash(repo, check.bundle, first.baseline.snapshot, env, []);
  assert.ok(scope.ok && now.ok && scope.hash === now.hash, JSON.stringify(scope));
  assert.deepEqual(readFileSync(join(dir, 'changes.txt'), 'utf8').split('\n').slice(1), ['added .gitattributes', 'modified src/app.ts', '']);
  assert.equal(readFileSync(join(dir, 'start', 'src', 'app.ts'), 'utf8'), 'export const app = 1;\n');
  assert.equal(readFileSync(join(dir, 'plan-hash.txt'), 'utf8'), 'none\n');
  assert.deepEqual(['ran-clean', 'ran-smudge', 'ran-textconv', 'ran-hook'].filter((f) => existsSync(join(repo, f))), []);
  // The positive control: an ordinary Git command in this repository runs the trap.
  execFileSync('git', ['add', 'src/app.ts'], { cwd: repo });
  assert.deepEqual(['ran-clean', 'ran-hook'].filter((f) => existsSync(join(repo, f))), ['ran-clean', 'ran-hook']);
});

test('a resume never erases scope: a missing or mismatched baseline file, or a run without one, fails closed and changes nothing', () => {
  const check = findBundle({ override: SKILLS_SOURCE, env: process.env });
  assert.ok(check.ok);
  const { repo, env } = gitRepo('review-resume');
  const path = join(repo, '.straddle-wizard', 'session-baseline.json');
  const run = '6f1c2a3b-0000-4000-8000-000000000005';
  const first = ensureBaseline(repo, run, check.bundle, env, [], true);
  assert.ok(first.ok);
  const saved = readFileSync(path, 'utf8');
  // The run's file was replaced by hand: the resume refuses and leaves both the file and the run's ref.
  writeFileSync(path, saved.replace(first.baseline.snapshot, 'f'.repeat(40)));
  assert.deepEqual(ensureBaseline(repo, run, check.bundle, env, [], false), { ok: false, reason: `the baseline file no longer matches refs/straddle-wizard/${run}` });
  assert.equal(readFileSync(path, 'utf8'), saved.replace(first.baseline.snapshot, 'f'.repeat(40)));
  assert.equal(execFileSync('git', ['rev-parse', `refs/straddle-wizard/${run}`], { cwd: repo, encoding: 'utf8' }).trim(), first.baseline.snapshot);
  writeFileSync(path, saved);
  // A resumed run that never got a baseline takes none now (its code already changed) and keeps the file it found.
  assert.deepEqual(ensureBaseline(repo, '6f1c2a3b-0000-4000-8000-000000000006', check.bundle, env, [], false), { ok: false, reason: 'this run has no baseline from its first session' });
  assert.equal(readFileSync(path, 'utf8'), saved);
});

test('a new run in a repository the review cannot scope gets no baseline, and the earlier run\'s baseline file goes', () => {
  const check = findBundle({ override: SKILLS_SOURCE, env: process.env });
  assert.ok(check.ok);
  const { repo, env } = gitRepo('review-nested');
  assert.ok(ensureBaseline(repo, '6f1c2a3b-0000-4000-8000-000000000003', check.bundle, env, [], true).ok);
  execFileSync('git', ['init', '-q', join(repo, 'vendor', 'pay')], { env });
  writeFileSync(join(repo, 'vendor', 'pay', 'x.ts'), 'x\n');
  // The earlier run, resumed, keeps its baseline: its ref answers without a new snapshot.
  assert.ok(ensureBaseline(repo, '6f1c2a3b-0000-4000-8000-000000000003', check.bundle, env, [], false).ok);
  const r = ensureBaseline(repo, '6f1c2a3b-0000-4000-8000-000000000004', check.bundle, env, [], true);
  assert.deepEqual(r, { ok: false, reason: "submodule or nested repository at vendor/pay/ isn't supported" });
  assert.equal(existsSync(join(repo, '.straddle-wizard', 'session-baseline.json')), false);
  assert.equal(execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/straddle-wizard/'], { cwd: repo, encoding: 'utf8' }).trim(), 'refs/straddle-wizard/6f1c2a3b-0000-4000-8000-000000000003');
});

// Codex has no hook: the review's text comes from its session rollout log, read by the same follower the program
// session uses, in the shape Codex writes it (one output_text per assistant message, the block and handoff split).
test('a Codex review\'s printed report is read from its rollout log: the block and a later handoff, across messages', () => {
  const home = tempDir('codex-review-home');
  const repo = realpathSync(tempDir('codex-review-repo'));
  const events = join(tempDir('codex-review-events'), 'events.jsonl');
  const since = Date.now() - 1000;
  mkdirSync(join(home, 'sessions', '2026', '10', '04'), { recursive: true });
  const at = new Date().toISOString();
  const said = (t: string) => JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] } });
  writeFileSync(join(home, 'sessions', '2026', '10', '04', 'rollout-2026-10-04T01-00-00-01a0ee00-0000-7000-8000-000000000967.jsonl'), [
    JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: '01a0ee00-0000-7000-8000-000000000967', cwd: repo, timestamp: at } }),
    said(`Reviewing.\n${BEGIN}\n${REPORT.join('\n')}`),
    said(END),
    said(handoff('findings')),
  ].join('\n') + '\n');
  const rollout = followCodex({ ...process.env, CODEX_HOME: home }, repo, events, since, null).stop();
  assert.equal(rollout.session, '01a0ee00-0000-7000-8000-000000000967');
  const report = parseReport(rollout.text.join('\n'));
  assert.equal(report.ok ? report.payload : report.reason, `${REPORT.join('\n')}\n`);
});
