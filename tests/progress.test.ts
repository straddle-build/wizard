import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { ObservedEvent } from '../src/events.ts';
import type { SkillName } from '../src/programs.ts';
import { approvalHash, nextStep, progress, statusLine } from '../src/progress.ts';
import { nextRepo, writeFiles } from './helpers.ts';

const PLAN_BODY = '# Straddle integration plan\n\n## Status\n\n- Plan state: {state}\n- Approval: {approval}\n- Last reviewed: 2026-09-30\n\n## File changes\n\n| File | Change |\n| --- | --- |\n| src/straddle.ts | add client |\n';
const draftPlan = PLAN_BODY.replace('{state}', 'Draft').replace('{approval}', 'none');
const approve = (plan: string) => plan.replace('- Plan state: Draft', '- Plan state: Approved')
  .replace('- Approval: none', `- Approval: 2026-09-30, "approved", recorded by straddle-plan, sha256 ${approvalHash(plan)}`);
const approvedPlan = approve(draftPlan);
const hash = approvalHash(approvedPlan);
const report = (status: string, planHash = hash) => `# Straddle integration report\n\nStatus: ${status}\nPlan: straddle-integration-plan.md\nPlan hash: ${planHash}\n\n## Changed files\n`;
const evidence = (status: string, planHash = hash) => `# Straddle test evidence\n\nStatus: ${status}\nPlan: straddle-integration-plan.md\nPlan hash: ${planHash}\nLatest run: r2\nTest charge: 0b6f3c0e-8a51-4c6f-9d0e-5b1f2a3c4d5e\n\n## Run r1, 2026-09-29\n\n- Status: partial\n`;
const PROGRAM: SkillName[] = ['straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test', 'straddle-go-live'];
const steps = PROGRAM.map((skill) => ({ skill, total: 5 }));

function next(files: Record<string, string>): string | null {
  const repo = nextRepo();
  writeFiles(repo, files);
  return nextStep(progress(repo, [], steps, []));
}

const done = {
  'straddle-setup.md': '# Straddle setup\n\nStatus: complete\nEnvironment: sandbox\nAPI key present: yes\n',
  'straddle-integration-plan.md': approvedPlan,
  'straddle-integration-report.md': report('complete'),
  'straddle-test-evidence.md': evidence('complete'),
  'straddle-go-live-report.md': `# Straddle Go Live review\n\nStatus: ready\nPlan: straddle-integration-plan.md\nPlan hash: ${hash}\nResult: ready\n`,
};

test('the approval hash is exactly what the skills\' shell command computes', () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': approvedPlan, 'no-newline.md': approvedPlan.trimEnd(), 'crlf.md': approvedPlan.replaceAll('\n', '\r\n') });
  for (const file of ['straddle-integration-plan.md', 'no-newline.md', 'crlf.md']) {
    const shell = execFileSync('/bin/sh', ['-c', `grep -v -e '^- Plan state:' -e '^- Approval:' ${file} | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64`], { cwd: repo, encoding: 'utf8' }).trim();
    const content = { 'straddle-integration-plan.md': approvedPlan, 'no-newline.md': approvedPlan.trimEnd(), 'crlf.md': approvedPlan.replaceAll('\n', '\r\n') }[file]!;
    assert.equal(approvalHash(content), shell, file);
  }
  // Recording the approval changes only the two excluded lines, so the hash is the draft's.
  assert.equal(approvalHash(approvedPlan), approvalHash(draftPlan));
});

test('resume picks the first unfinished step from the files, in program order', () => {
  assert.equal(next({}), 'straddle-setup');
  assert.equal(next({ 'straddle-setup.md': 'Status: blocked (no Sandbox key)\n' }), 'straddle-setup');
  assert.equal(next({ ...done, 'straddle-integration-plan.md': draftPlan }), 'straddle-plan');
  assert.equal(next({ ...done, 'straddle-integration-report.md': report('partial (webhook route deferred)') }), 'straddle-integrate');
  const { 'straddle-integration-report.md': _report, ...withoutReport } = done;
  assert.equal(next(withoutReport), 'straddle-integrate');
  assert.equal(next({ ...done, 'straddle-integration-report.md': report('blocked (plan not approved)') }), 'straddle-integrate');
  assert.equal(next({ ...done, 'straddle-test-evidence.md': evidence('partial (1 failed)') }), 'straddle-test');
  assert.equal(next({ ...done, 'straddle-go-live-report.md': 'Status: not ready (no Production webhook secret)\n' }), 'straddle-go-live');
  assert.equal(next(done), null);
});

test('resume goes back to Plan when the plan changed after approval, and redoes a step recorded for an older plan', () => {
  const edited = approvedPlan.replace('add client', 'add client and payouts');
  assert.equal(next({ ...done, 'straddle-integration-plan.md': edited }), 'straddle-plan');
  assert.equal(next({ ...done, 'straddle-integration-plan.md': approvedPlan.replace(/sha256 [0-9a-f]{64}/, 'none') }), 'straddle-plan');

  const older = approvalHash(draftPlan.replace('add client', 'an earlier row'));
  assert.equal(next({ ...done, 'straddle-integration-report.md': report('complete', older) }), 'straddle-integrate');
  assert.equal(next({ ...done, 'straddle-test-evidence.md': evidence('complete', older) }), 'straddle-test');
  assert.equal(next({ ...done, 'straddle-go-live-report.md': done['straddle-go-live-report.md'].replace(hash, older) }), 'straddle-go-live');
});

test('Migrate is finished only when its approved plan is on file and it reported `migrated`, because its edits come after approval', () => {
  const repo = nextRepo();
  writeFiles(repo, { ...done, 'straddle-migration-plan.md': approvedPlan });
  const withMigrate = [steps[0]!, steps[1]!, { skill: 'straddle-migrate' as const, total: 8 }, ...steps.slice(2)];
  const migrated: ObservedEvent = { at: 't', kind: 'marker', key: 'm', marker: { kind: 'handoff', skill: 'straddle-migrate', status: 'migrated' } };
  assert.equal(nextStep(progress(repo, [], withMigrate, [])), 'straddle-migrate');
  assert.equal(nextStep(progress(repo, [], withMigrate, [migrated])), null);
});

test('a contract file the Wizard must not open counts as unfinished, and its detail says why', () => {
  const repo = nextRepo();
  writeFiles(repo, done);
  const items = progress(repo, ['straddle-integration-report.md'], steps, []);
  assert.equal(nextStep(items), 'straddle-integrate');
  assert.match(items[2]!.record!.detail, /not opened: it's a configured sensitive path/);
});

test('the checklist ticks a step only when its file and the reported handoff agree, and shows observed progress on the current step', () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-setup.md': done['straddle-setup.md'] });
  const at = '2026-09-30T00:00:00Z';
  const handoff = (skill: string, status: string): ObservedEvent => ({ at, kind: 'marker', key: `${skill}-${status}`, marker: { kind: 'handoff', skill, status } });
  const entered = (skill: string, step: string): ObservedEvent => ({ at, kind: 'step-entered', skill, step });

  assert.equal(statusLine(progress(repo, [], steps, [])), 'Setup · Plan ▶ 0/5 · Integrate · Test · Go Live');
  // Setup's file is complete and it reported ready: ticked. Plan is approved on file but its handoff isn't reported yet.
  const events = [entered('straddle-setup', '01-begin'), handoff('straddle-setup', 'ready'), entered('straddle-plan', '01-decisions'), entered('straddle-plan', '02-sources')];
  assert.equal(statusLine(progress(repo, [], steps, events)), 'Setup ✓ · Plan ▶ 2/5 · Integrate · Test · Go Live');
  // A reported handoff alone never ticks: Integrate says complete, but no report is on file.
  writeFiles(repo, { 'straddle-integration-plan.md': approvedPlan });
  const later = [...events, handoff('straddle-plan', 'draft'), entered('straddle-integrate', '01-begin'), handoff('straddle-integrate', 'complete')];
  assert.equal(statusLine(progress(repo, [], steps, later)), 'Setup ✓ · Plan ✓ · Integrate ▶ 1/5 · Test · Go Live');
  // A later abort outranks an earlier handoff.
  const aborted: ObservedEvent = { at, kind: 'marker', key: 'abort', marker: { kind: 'abort', skill: 'straddle-setup', reason: 'stopped' } };
  assert.equal(statusLine(progress(repo, [], steps, [...later, aborted])).split(' · ')[0], 'Setup ▶ 1/5');
});

test('resuming from repository state files places the play marker on the first unfinished step without division by zero', () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-setup.md': done['straddle-setup.md'], 'straddle-integration-plan.md': approvedPlan });
  assert.equal(statusLine(progress(repo, [], steps, [])), 'Setup · Plan · Integrate ▶ 0/5 · Test · Go Live');
  const zeroSteps = steps.map((s) => ({ ...s, total: 0 }));
  assert.equal(statusLine(progress(repo, [], zeroSteps, [])), 'Setup · Plan · Integrate ▶ 0 · Test · Go Live');
});

