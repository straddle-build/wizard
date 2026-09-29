import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle } from './bundle.ts';
import { CLIENT_NAMES, type ClientName } from './clients.ts';
import type { ObservedEvent, ReportedMarker } from './events.ts';
import { field } from './json.ts';
import { PROGRAMS, isRunnableSkill, type ProgramName, type SkillName } from './programs.ts';

export const RECEIPT_SCHEMA = 'straddle-wizard/receipt@1';
export const WIZARD_DIR = '.straddle-wizard';

export type RunState = 'ready' | 'running' | 'blocked' | 'aborted' | 'completed';

export interface Answer<T extends string = string> { value: T; source: 'detected' | 'developer' }

export const CHOICE_VALUES = {
  products: ['charges', 'payouts', 'charges and payouts', 'not decided'],
  integrationType: ['direct', 'SaaS', 'marketplace', 'not decided'],
  sdk: ['TypeScript', 'Python', 'Ruby', 'C#', 'Go', 'not decided'],
  notificationPath: ['webhook endpoint', 'FIFO endpoint', 'polling endpoint', 'not decided'],
} as const;

export type Choices = { [K in keyof typeof CHOICE_VALUES]: (typeof CHOICE_VALUES)[K][number] };

export interface StepRun {
  skill: SkillName;
  skillVersion: string;
  startedAt: string;
  endedAt: string | null;
  exit: { code: number | null; signal: string | null } | null;
  // How the Wizard learns about this session. Only 'observed' comes from client events it reads.
  eventSurface: 'observed' | 'unverified' | 'unsupported';
  observedSteps: string[];
  observedEvents: ObservedEvent[];
  // Printed by the model. Best-effort, never proof of completion or approval.
  reportedMarkers: ReportedMarker[];
  changedFiles: string[];
  // What the before-and-after comparison could not cover (file limit, unreadable paths). Empty means it covered
  // every file discovery may open.
  evidenceLimits: string[];
  checklist: string[];
  // The Wizard's own decision, saved once: true only when the session ended normally, reported no abort, and printed
  // a handoff status after which the next step may start. Resume reads this, never the markers alone.
  advanced: boolean;
}

// Deliberately no approval field: approvals live in the native client session that asked for them.
export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  runId: string;
  createdAt: string;
  updatedAt: string;
  wizardPid: number;
  program: ProgramName;
  client: ClientName | null;
  pluginLoad: 'installed' | 'session' | 'manual' | null;
  repo: string;
  exclude: string[];
  context: { language: Answer; framework: Answer; choices: Choices | null };
  bundle: Pick<Bundle, 'kind' | 'repository' | 'commit' | 'pluginVersion' | 'path'> | null;
  planSha256: string | null;
  state: RunState;
  stateReason: string;
  steps: StepRun[];
}

export function newReceipt(opts: { repo: string; program: ProgramName; pid: number }): Receipt {
  const now = new Date().toISOString();
  return {
    schema: RECEIPT_SCHEMA,
    runId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    wizardPid: opts.pid,
    program: opts.program,
    client: null,
    pluginLoad: null,
    repo: opts.repo,
    exclude: [],
    context: { language: { value: 'unknown', source: 'detected' }, framework: { value: 'unknown', source: 'detected' }, choices: null },
    bundle: null,
    planSha256: null,
    state: 'ready',
    stateReason: 'context confirmed',
    steps: [],
  };
}

export function receiptPath(repo: string): string {
  return join(repo, WIZARD_DIR, 'receipt.json');
}

export function saveReceipt(receipt: Receipt): void {
  const dir = join(receipt.repo, WIZARD_DIR);
  mkdirSync(dir, { recursive: true });
  // Keeps Wizard state out of the developer's commits without editing their .gitignore.
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
  receipt.updatedAt = new Date().toISOString();
  const tmp = `${receiptPath(receipt.repo)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(tmp, receiptPath(receipt.repo));
}

export type LoadedReceipt = { kind: 'none' } | { kind: 'invalid'; reason: string } | { kind: 'found'; receipt: Receipt };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_STATES: Record<string, true> = { ready: true, running: true, blocked: true, aborted: true, completed: true };
const PLUGIN_LOADS: Record<string, true> = { installed: true, session: true, manual: true };

// The receipt sits in the repository, so it is untrusted input: every value that names a path, a program, a skill or
// a client is checked before the Wizard uses it. The first problem found, or null.
function receiptProblem(r: unknown): string | null {
  if (field(r, 'schema') !== RECEIPT_SCHEMA) return `unknown schema ${JSON.stringify(field(r, 'schema'))}`;
  const runId = field(r, 'runId');
  if (typeof runId !== 'string' || !UUID.test(runId)) return 'runId is not a Wizard run id';
  const program = field(r, 'program');
  if (typeof program !== 'string' || !(Object.hasOwn(PROGRAMS, program) || (program.startsWith('skill:') && isRunnableSkill(program.slice(6))))) return 'unknown program';
  const client = field(r, 'client');
  if (client !== null && !(CLIENT_NAMES as readonly unknown[]).includes(client)) return 'unknown client';
  const pluginLoad = field(r, 'pluginLoad');
  if (pluginLoad !== null && !(typeof pluginLoad === 'string' && Object.hasOwn(PLUGIN_LOADS, pluginLoad))) return 'unknown plugin load';
  const state = field(r, 'state');
  if (typeof state !== 'string' || !Object.hasOwn(RUN_STATES, state) || typeof field(r, 'stateReason') !== 'string') return 'missing state';
  if (typeof field(r, 'wizardPid') !== 'number' || typeof field(r, 'updatedAt') !== 'string') return 'missing run details';
  const exclude = field(r, 'exclude');
  if (!Array.isArray(exclude) || !exclude.every((s) => typeof s === 'string')) return 'exclusions are not a list of paths';
  const context = field(r, 'context');
  for (const key of ['language', 'framework']) {
    const answer = field(context, key);
    if (typeof field(answer, 'value') !== 'string' || !['detected', 'developer'].includes(field(answer, 'source') as string)) return `invalid ${key}`;
  }
  const choices = field(context, 'choices');
  if (choices !== null && !Object.entries(CHOICE_VALUES).every(([key, values]) => (values as readonly unknown[]).includes(field(choices, key)))) return 'invalid choices';
  const bundlePath = field(field(r, 'bundle'), 'path');
  if (field(r, 'bundle') !== null && typeof bundlePath !== 'string') return 'invalid bundle';
  const planSha256 = field(r, 'planSha256');
  if (planSha256 !== null && typeof planSha256 !== 'string') return 'invalid plan hash';
  const steps = field(r, 'steps');
  if (!Array.isArray(steps)) return 'missing steps';
  for (const step of steps) {
    const skill = field(step, 'skill');
    if (typeof skill !== 'string' || !isRunnableSkill(skill)) return 'unknown step skill';
    for (const key of ['observedSteps', 'changedFiles', 'evidenceLimits', 'checklist']) {
      const list = field(step, key);
      if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) return `invalid step ${key}`;
    }
    for (const key of ['observedEvents', 'reportedMarkers']) if (!Array.isArray(field(step, key))) return `invalid step ${key}`;
    if (typeof field(step, 'advanced') !== 'boolean') return 'invalid step advanced';
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return field(error, 'code') === 'EPERM';
  }
}

export function loadReceipt(repo: string): LoadedReceipt {
  const path = receiptPath(repo);
  if (!existsSync(path)) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { kind: 'invalid', reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const problem = receiptProblem(parsed);
  if (problem) return { kind: 'invalid', reason: problem };
  const receipt = parsed as Receipt;
  receipt.repo = repo;
  if (receipt.state === 'running' && !pidAlive(receipt.wizardPid)) {
    receipt.state = 'aborted';
    receipt.stateReason = 'the Wizard stopped while a step was running; work already done is kept';
    const last = receipt.steps.at(-1);
    if (last && last.endedAt === null) last.endedAt = receipt.updatedAt;
  }
  return { kind: 'found', receipt };
}
