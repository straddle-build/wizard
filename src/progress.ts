// Where a run stands, from two sources the Wizard keeps apart: the contract files the skills write, which the Wizard
// reads itself, and the events the client exposes (observed step entries, and the markers the agent printed), with
// the Wizard's own record of a choice to finish without Go Live.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { readRepoFile } from './discovery.ts';
import { stepEntries, type ObservedEvent, type ReportedMarker } from './events.ts';
import { INTEGRATION_PLAN, MIGRATION_PLAN, SKILLS, type SkillName } from './programs.ts';

// The first `Label: value` line, plain or as a list item, as the skills write their status headers.
export function header(textContent: string, label: string): string | undefined {
  return new RegExp(`^[ \\t]*(?:- )?${label}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(textContent)?.[1];
}

// `not ready (2 gaps)` → `not ready`.
const statusWord = (value: string | undefined) => value?.split(' (')[0]!.trim().toLowerCase();

// The plan approval hash the skills record (straddle-integrate step 1, Recorded approval): SHA-256 of the plan without
// its `- Plan state:` and `- Approval:` lines, byte for byte what
// `grep -v -e '^- Plan state:' -e '^- Approval:' <plan> | sha256sum` hashes.
export function approvalHash(plan: string): string {
  const lines = plan.split('\n');
  if (plan.endsWith('\n')) lines.pop();
  const kept = lines.filter((l) => !l.startsWith('- Plan state:') && !l.startsWith('- Approval:'));
  return createHash('sha256').update(kept.map((l) => `${l}\n`).join('')).digest('hex');
}

// `hash`: the plan hash the file is for: a finished plan's approved hash, or the `Plan hash:` a report names.
export interface StepRecord { done: boolean; detail: string; hash?: string }
type Read = (name: string) => { text: string } | { missing: string };

// A plan is done when it says Approved and its recorded hash is the current content's: an edit after approval voids it.
function planRecord(read: Read, file: string): StepRecord {
  const plan = read(file);
  if ('missing' in plan) return { done: false, detail: plan.missing };
  const state = header(plan.text, 'Plan state') ?? 'not recorded';
  if (statusWord(state) !== 'approved') return { done: false, detail: `Plan state: ${state}` };
  const recorded = /sha256 ([0-9a-f]{64})\b/.exec(header(plan.text, 'Approval') ?? '')?.[1];
  const hash = approvalHash(plan.text);
  if (recorded !== hash) return { done: false, detail: recorded ? 'the plan changed after you approved it' : 'Approved, but no approval hash is recorded' };
  return { done: true, detail: 'Plan state: Approved, and the plan is unchanged since', hash };
}

// A report is done when its Status says so and, where it names a plan, it was made for the current approved plan: the
// plan its `Plan:` line names.
function reportRecord(read: Read, file: string, complete: string, forPlan: boolean): StepRecord {
  const report = read(file);
  if ('missing' in report) return { done: false, detail: report.missing };
  const status = header(report.text, 'Status') ?? 'not recorded';
  const hash = header(report.text, 'Plan hash');
  if (statusWord(status) !== complete) return { done: false, detail: `Status: ${status}`, hash };
  if (!forPlan) return { done: true, detail: `Status: ${status}` };
  // `./straddle-migration-plan.md` names the same file.
  const planFile = posix.normalize(header(report.text, 'Plan') ?? '') === MIGRATION_PLAN ? MIGRATION_PLAN : INTEGRATION_PLAN;
  const plan = planRecord(read, planFile);
  if (!plan.done) return { done: false, detail: `Status: ${status}, but ${planFile} is not approved as it stands`, hash };
  if (hash !== plan.hash) return { done: false, detail: `Status: ${status}, but for an earlier version of ${planFile}`, hash };
  return { done: true, detail: `Status: ${status}, for the current approved plan`, hash };
}

// What the step's contract file says, read under discovery's boundary: never a symlink or an excluded path.
export function stepRecord(repo: string, exclude: readonly string[], skill: SkillName): StepRecord | null {
  const record = SKILLS[skill].record;
  if (!record) return null;
  const read: Read = (name) => {
    const f = readRepoFile(repo, name, exclude);
    return f.kind === 'read' ? { text: f.text } : { missing: f.kind === 'absent' ? 'not written yet' : `not opened: ${f.reason}` };
  };
  if (!record.finished) return planRecord(read, record.file);
  // Setup comes before any plan; every later report counts only for the current approved plan.
  return reportRecord(read, record.file, record.finished, skill !== 'straddle-setup');
}

export interface StepProgress {
  skill: SkillName;
  record: StepRecord | null;
  // Distinct step files the client showed the agent opening, out of the skill's step files.
  entered: number;
  total: number;
  // The agent's last handoff or abort for this skill.
  reported: ReportedMarker | undefined;
  // Ticked: the Wizard's own evidence (the file, or observed step entries for a skill without one) and the agent's
  // report agree. Where the Wizard sees no report (Cursor, Manual), the file alone.
  done: boolean;
  // Finished for the resume rule: the file says so. A skill without a file is finished when it is ticked.
  finished: boolean;
  // Finished without running: you chose to finish the program after Test, for the plan Test is complete at.
  skipped: boolean;
}

// `observed`: the client shows the Wizard the agent's handoffs (Claude Code and Codex in Auto).
export function progress(repo: string, exclude: readonly string[], steps: ReadonlyArray<{ skill: SkillName; total: number }>, events: readonly ObservedEvent[], observed: boolean): StepProgress[] {
  const items = steps.map(({ skill, total }) => {
    const record = stepRecord(repo, exclude, skill);
    const entered = stepEntries(events, skill).length;
    const reported = events.findLast((e) => e.kind === 'marker' && e.marker.skill === skill && e.marker.kind !== 'progress');
    const marker = reported?.kind === 'marker' ? reported.marker : undefined;
    const agrees = marker?.kind === 'handoff' && SKILLS[skill].advanceOn.includes(marker.status ?? '');
    const done = observed ? agrees && (record ? record.done : entered > 0) : record?.done === true;
    const finished = record ? record.done : done;
    return { skill, record, entered, total, reported: marker, done, finished, skipped: false };
  });
  // A skip counts only for the plan Test is complete at now, so a changed plan brings Go Live back.
  const skippable = goLiveSkippable(items);
  const goLive = items.find((p) => p.skill === 'straddle-go-live');
  if (goLive && skippable && events.some((e) => e.kind === 'go-live-skipped' && e.planHash === skippable)) Object.assign(goLive, { finished: true, skipped: true });
  return items;
}

// When Go Live is the only step left, the plan hash Test is complete at, so you can finish without Go Live; else null.
// A Go Live report for that plan (not ready, say) is a real result, so it's never hidden behind a skip.
export function goLiveSkippable(items: readonly StepProgress[]): string | null {
  const tested = nextStep(items) === 'straddle-go-live' ? items.find((p) => p.skill === 'straddle-test')?.record?.hash : undefined;
  return tested && items.find((p) => p.skill === 'straddle-go-live')?.record?.hash !== tested ? tested : null;
}

// Resume rule: the first step in program order that is not finished.
export function nextStep(items: readonly StepProgress[]): SkillName | null {
  return items.find((p) => !p.finished)?.skill ?? null;
}

// `Setup ✓ · Plan ▶ 2/6 · Integrate · Test · Go Live`: ticked steps, then the current step and any later step the
// agent has entered with their observed step counts, then the steps still to come. The current step is the first
// unfinished one from `start`, where the session began: a session that leaves Setup for later starts past it.
export function statusLine(items: readonly StepProgress[], start?: SkillName): string {
  const from = Math.max(0, items.findIndex((p) => p.skill === start));
  const current = items.findIndex((p, i) => i >= from && !p.finished);
  return items.map((p, i) => `${SKILLS[p.skill].title}${p.done ? ' ✓' : p.skipped ? ' skipped' : i === current || p.entered ? ` ▶ ${p.total ? `${p.entered}/${p.total}` : p.entered}` : ''}`).join(' · ');
}
