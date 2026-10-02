// The state-file contract, read from the skills themselves (SKILLS_SOURCE): each step's header template, filled in the
// way the skill says, must mean to the Wizard what the skill means by it. The approval hash comes from the command in
// Integrate step 1, not a copy. A template or hash format the Wizard can't read fails here, before a real run loops.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SkillName } from '../src/programs.ts';
import { approvalHash, nextStep, progress, stepRecord } from '../src/progress.ts';
import { SKILLS_SOURCE, nextRepo, tempDir } from './helpers.ts';

const skillFile = (path: string) => readFileSync(join(SKILLS_SOURCE, 'skills', path), 'utf8');

// The header block of the template that starts with heading `h1` in a skill file: the heading, then its label lines up
// to the first blank line after them.
function headerTemplate(path: string, h1: string): string[] {
  const lines = skillFile(path).split('\n');
  const start = lines.findIndex((l) => l.trim() === h1);
  assert.ok(start >= 0, `${path} has no "${h1}" template`);
  let i = start + 1;
  while (lines[i]?.trim() === '') i++;
  const block = [h1, ''];
  while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('```')) block.push(lines[i++]!);
  return block;
}

// `Label: a | b | c` with the alternative `pick` chooses (the first by default), and the hash placeholder filled.
function fill(block: readonly string[], hash: string, pick: Record<string, (alternatives: string[]) => string> = {}): string {
  return block.map((line) => {
    const m = /^((?:- )?([A-Za-z][A-Za-z ]*)): (.*)$/.exec(line);
    if (!m) return line;
    const alternatives = m[3]!.split(' | ');
    const value = (pick[m[2]!] ?? ((a) => a[0]!))(alternatives);
    return `${m[1]}: ${value.replace('<64 hex characters>', hash)}`;
  }).join('\n') + '\n';
}

const statusAlternatives = (block: readonly string[]) => /^Status: (.*)$/m.exec(block.join('\n'))![1]!.split(' | ');

// The approval hash exactly as Integrate step 1 tells the agent to compute it, run on `file` in `repo`.
function skillsHash(repo: string, file: string): string {
  const command = skillFile('straddle-integrate/steps/01-begin.md').split('\n').find((l) => l.startsWith("grep -v -e '^- Plan state:'"));
  assert.ok(command, 'Integrate step 1 has no approval hash command');
  return execFileSync('/bin/sh', ['-c', command.replaceAll('straddle-integration-plan.md', file)], { cwd: repo, encoding: 'utf8' }).trim();
}

// A plan from its template, approved the way the skills record an approval: the recorded line's format, with the hash
// the skills' command prints for the plan.
function approvedPlan(repo: string, file: string, template: string, approvalLine: string): string {
  const draft = template.replace(/^- Plan state: .*$/m, '- Plan state: Draft').replace(/^- Approval: .*$/m, '- Approval: none');
  writeFileSync(join(repo, file), draft);
  const hash = skillsHash(repo, file);
  assert.equal(hash, approvalHash(draft), `the Wizard's hash of ${file} is the skills' command's`);
  const plan = draft.replace('- Plan state: Draft', '- Plan state: Approved').replace('- Approval: none', approvalLine.replace(/<64 hex characters>|<hash>/, hash));
  writeFileSync(join(repo, file), plan);
  assert.equal(skillsHash(repo, file), hash, 'recording the approval leaves the hash as it was');
  return hash;
}

const PROGRAM: SkillName[] = ['straddle-setup', 'straddle-plan', 'straddle-migrate', 'straddle-integrate', 'straddle-test', 'straddle-go-live'];

test('state files written from the skills\' own templates carry the program through to the end, and only each step\'s finished status finishes it', () => {
  const repo = nextRepo();

  // Plans, approved in the format the approving step tells the agent to write: Integrate step 1's Recorded approval for
  // the integration plan, Migrate step 5 for the migration plan.
  const recorded = skillFile('straddle-integrate/steps/01-begin.md').split('\n').find((l) => l.startsWith('- Approval: <YYYY-MM-DD>'));
  assert.ok(recorded, 'Integrate step 1 has no recorded Approval line');
  const planHash = approvedPlan(repo, 'straddle-integration-plan.md', skillFile('straddle-plan/references/plan-template.md'), recorded);
  const migrationApproval = /`(- Approval: [^`]*recorded by straddle-migrate[^`]*)`/.exec(skillFile('straddle-migrate/steps/05-approval.md'))?.[1];
  assert.ok(migrationApproval, 'Migrate step 5 has no recorded Approval line');
  const migrationHash = approvedPlan(repo, 'straddle-migration-plan.md', skillFile('straddle-migrate/references/plan-template.md'), migrationApproval);

  // Reports: each header template, and the Status alternative the Wizard counts as finished.
  const reports: Array<{ skill: SkillName; file: string; block: string[]; hash: string; finished: string }> = [
    { skill: 'straddle-setup', file: 'straddle-setup.md', block: headerTemplate('straddle-setup/steps/05-report.md', '# Straddle Setup report'), hash: planHash, finished: 'complete' },
    { skill: 'straddle-migrate', file: 'straddle-migration-report.md', block: headerTemplate('straddle-migrate/steps/08-report.md', '# Straddle migration report'), hash: migrationHash, finished: 'migrated' },
    { skill: 'straddle-integrate', file: 'straddle-integration-report.md', block: headerTemplate('straddle-integrate/steps/07-handoff.md', '# Straddle integration report'), hash: planHash, finished: 'complete' },
    { skill: 'straddle-test', file: 'straddle-test-evidence.md', block: headerTemplate('straddle-test/steps/06-evidence.md', '# Straddle test evidence'), hash: planHash, finished: 'complete' },
    { skill: 'straddle-go-live', file: 'straddle-go-live-report.md', block: headerTemplate('straddle-go-live/steps/06-report.md', '# Straddle Go Live review'), hash: planHash, finished: 'ready' },
  ];
  for (const r of reports) {
    const finishing = statusAlternatives(r.block).filter((status) => {
      writeFileSync(join(repo, r.file), fill(r.block, r.hash, { Status: () => status }));
      return stepRecord(repo, [], r.skill)!.done;
    });
    assert.deepEqual(finishing.map((s) => s.split(' (')[0]), [r.finished], `${r.file}: only Status: ${r.finished} finishes ${r.skill}`);
    writeFileSync(join(repo, r.file), fill(r.block, r.hash, { Status: (a) => a.find((s) => s.startsWith(r.finished))! }));
  }

  const steps = PROGRAM.map((skill) => ({ skill, total: 0 }));
  const items = progress(repo, [], steps, [], true);
  assert.equal(nextStep(items), null, items.map((p) => `${p.skill}: ${p.record?.detail}`).join('\n'));
});

test('the approval hash command in Integrate step 1 and the Wizard agree on plans with or without a final newline and with Windows line endings', () => {
  const repo = tempDir('hash');
  const plan = '# Straddle integration plan\n\n- Plan state: Approved\n- Approval: 2026-09-30, "yes", recorded by straddle-plan, sha256 x\n\n## File changes\n| a | b |\n';
  for (const variant of [plan, plan.trimEnd(), plan.replaceAll('\n', '\r\n')]) {
    writeFileSync(join(repo, 'straddle-integration-plan.md'), variant);
    assert.equal(approvalHash(variant), skillsHash(repo, 'straddle-integration-plan.md'), JSON.stringify(variant.slice(-6)));
  }
});
