import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle } from './bundle.ts';
import type { ClientName } from './clients.ts';
import type { ObservedEvent, ReportedMarker } from './events.ts';
import { field } from './json.ts';
import type { ProgramName, SkillName } from './programs.ts';

export const RECEIPT_SCHEMA = 'straddle-wizard/receipt@1';
export const WIZARD_DIR = '.straddle-wizard';

export type RunState = 'ready' | 'running' | 'blocked' | 'aborted' | 'completed';

export interface Answer<T extends string = string> { value: T; source: 'detected' | 'developer' }

export interface Choices {
  products: 'charges' | 'payouts' | 'charges and payouts' | 'not decided';
  integrationType: 'direct' | 'SaaS' | 'marketplace' | 'not decided';
  sdk: 'TypeScript' | 'Python' | 'Ruby' | 'C#' | 'Go' | 'not decided';
  notificationPath: 'webhook endpoint' | 'FIFO endpoint' | 'polling endpoint' | 'not decided';
}

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
  checklist: string[];
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
  if (field(parsed, 'schema') !== RECEIPT_SCHEMA) return { kind: 'invalid', reason: `unknown schema ${JSON.stringify(field(parsed, 'schema'))}` };
  if (!Array.isArray(field(parsed, 'steps')) || typeof field(parsed, 'state') !== 'string') return { kind: 'invalid', reason: 'missing state or steps' };
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
