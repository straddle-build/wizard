import { execFileSync } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Bundle } from './bundle.ts';
import { globPattern } from './discovery.ts';
import { field, parseJson, text } from './json.ts';
import { WIZARD_DIR } from './receipt.ts';

// The payment review (skills wizard-program.md, "Payment review"). The skill and its session-state script come from
// the plugin bundle; a bundle without the skill keeps the program as it was.
export const REVIEW_SKILL = 'straddle-payment-review';
export const REVIEW_REPORT = 'straddle-payment-review.md';
export const REVIEW_LINE = "Straddle Wizard review: print the report; don't write files.";
export const REVIEW_SCOPE_LINE = 'Straddle Wizard review scope: ';
const BASELINE = 'session-baseline.json';
const REPORT_LIMIT = 64 * 1024;

export const hasReview = (bundle: Bundle | null): boolean => bundle !== null && Object.hasOwn(bundle.skills, REVIEW_SKILL);

const script = (bundle: Bundle) => join(bundle.path, 'skills', REVIEW_SKILL, 'scripts', 'session-state');
const EXCLUDE_FILE = 'payment-review-exclude';
// Raw Git: no fsmonitor, pager or hook runs (`update-ref` runs the reference-transaction hook otherwise).
const git = (repo: string, args: string[]) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// session-state calls `git commit-tree`, which needs an identity the repository may not configure.
const IDENTITY = { GIT_AUTHOR_NAME: 'Straddle Wizard', GIT_AUTHOR_EMAIL: 'wizard@straddle.invalid', GIT_COMMITTER_NAME: 'Straddle Wizard', GIT_COMMITTER_EMAIL: 'wizard@straddle.invalid' };

// The session-state script's first error line is the specific one ("… nested repository at vendor/pay/ …"); later lines
// only repeat that it stopped.
const failure = (error: unknown): string => {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').trim().split('\n')[0] : '';
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || message).replace(/^session-state: /, '');
};

// The developer's `--exclude` globs, as the patterns discovery matches, for the session-state script to apply with the
// same sensitive-name rules discovery uses. Written before every snapshot and compare, so the script never reads
// excluded bytes and a resume with new globs drops them from both sides of the comparison. Like `saveReport`, it
// never writes through a symlink.
function writeExcludes(repo: string, exclude: readonly string[]): string | null {
  if (exclude.some((g) => /[\r\n]/.test(g))) return 'an --exclude path holds a line break';
  const dir = join(repo, WIZARD_DIR);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) return `${WIZARD_DIR} isn't a directory`;
  const dest = join(dir, EXCLUDE_FILE);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, exclude.map((g) => `${globPattern(g)}\n`).join('')); } finally { closeSync(fd); }
    renameSync(tmp, dest);
    return null;
  } catch (error) {
    rmSync(tmp, { force: true });
    return failure(error);
  }
}

function sessionState(repo: string, bundle: Bundle, args: string[], env: NodeJS.ProcessEnv, exclude: readonly string[]): string {
  const problem = writeExcludes(repo, exclude);
  if (problem) throw new Error(problem);
  // The script applies `exclude` with JavaScript (the skill's exclude-match.mjs); this Node runs it.
  return execFileSync('bash', [script(bundle), ...args], { cwd: repo, env: { ...env, STRADDLE_NODE: process.execPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface Baseline { head: string | null; snapshot: string; startedAt: string }
export type BaselineResult = { ok: true; baseline: Baseline; created: boolean } | { ok: false; reason: string };

export const runRef = (runId: string) => `refs/straddle-wizard/${runId}`;

function readBaseline(repo: string): Baseline | null {
  const path = join(repo, WIZARD_DIR, BASELINE);
  if (!existsSync(path)) return null;
  const raw = parseJson(readFileSync(path, 'utf8'));
  const snapshot = text(field(raw, 'snapshot'));
  const head = field(raw, 'head');
  const startedAt = text(field(raw, 'startedAt'));
  if (!snapshot || !/^[0-9a-f]{40,64}$/.test(snapshot) || !startedAt) return null;
  if (head === null) return { head: null, snapshot, startedAt };
  return typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head) ? { head, snapshot, startedAt } : null;
}

// Once per Wizard run: the start state of every file on disk, kept under the run's own ref so it outlives garbage
// collection, and `.straddle-wizard/session-baseline.json`. A resume, a client switch or a cancelled review finds the
// run's ref and keeps the baseline as it is; when that check fails it fails closed and changes nothing. Only the run's
// first session (`fresh`) may remove another run's baseline, when its own snapshot can't be taken, so no review scopes
// a new run against an earlier run's start.
export function ensureBaseline(repo: string, runId: string, bundle: Bundle, env: NodeJS.ProcessEnv, exclude: readonly string[], fresh: boolean): BaselineResult {
  const path = join(repo, WIZARD_DIR, BASELINE);
  const ref = runRef(runId);
  let kept: string | null = null;
  try { kept = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { kept = null; }
  const existing = readBaseline(repo);
  if (kept && existing?.snapshot === kept) return { ok: true, baseline: existing, created: false };
  if (kept) return { ok: false, reason: `the baseline file no longer matches ${ref}` };
  if (!fresh) return { ok: false, reason: 'this run has no baseline from its first session' };
  rmSync(path, { force: true });
  try {
    const head = (() => { try { return git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); } catch { return null; } })();
    const startedAt = new Date().toISOString();
    const out = sessionState(repo, bundle, ['snapshot'], { ...env, ...IDENTITY }, exclude).trim();
    if (!/^[0-9a-f]{40,64}$/.test(out)) return { ok: false, reason: 'the snapshot script printed no commit' };
    // An empty old value: the ref must not exist yet, so a run's baseline is never moved.
    git(repo, ['update-ref', '-m', 'straddle wizard session baseline', ref, out, '']);
    const baseline: Baseline = { head, snapshot: out, startedAt };
    writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, baseline, created: true };
  } catch (error) {
    return { ok: false, reason: failure(error) };
  }
}

export function currentBaseline(repo: string, runId: string): Baseline | null {
  const existing = readBaseline(repo);
  if (!existing) return null;
  try { return git(repo, ['rev-parse', '--verify', '--quiet', `${runRef(runId)}^{commit}`]) === existing.snapshot ? existing : null; } catch { return null; }
}

// The code hash of the files on disk against the run's snapshot, by the skill's own script, or the reason it can't be
// computed (a nested repository, an unsupported path, an unreadable file).
export function codeHash(repo: string, bundle: Bundle, snapshot: string, env: NodeJS.ProcessEnv, exclude: readonly string[]): { ok: true; hash: string } | { ok: false; reason: string } {
  try {
    const first = sessionState(repo, bundle, ['compare', snapshot], env, exclude).split('\n')[0] ?? '';
    const m = /^code-hash ([0-9a-f]{64})$/.exec(first);
    return m ? { ok: true, hash: m[1]! } : { ok: false, reason: 'the compare script printed no code hash' };
  } catch (error) {
    return { ok: false, reason: failure(error) };
  }
}

// Computed here so the reviewer needs no shell. `git cat-file blob` reads the start bytes raw, with no filter or
// textconv, and the directory sits under `.straddle-wizard/`, which the code hash leaves out.
export function writeReviewScope(repo: string, bundle: Bundle, snapshot: string, planHash: string, env: NodeJS.ProcessEnv, exclude: readonly string[], dir: string): { ok: true; hash: string } | { ok: false; reason: string } {
  try {
    const out = sessionState(repo, bundle, ['compare', snapshot], env, exclude);
    const [first = '', ...changes] = out.split('\n');
    const m = /^code-hash ([0-9a-f]{64})$/.exec(first);
    if (!m) return { ok: false, reason: 'the compare script printed no code hash' };
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'start'), { recursive: true });
    writeFileSync(join(dir, 'changes.txt'), out);
    writeFileSync(join(dir, 'plan-hash.txt'), `${planHash}\n`);
    for (const line of changes) {
      const path = /^(?:modified|deleted) (.+)$/.exec(line)?.[1];
      if (!path) continue;
      const blob = execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${snapshot}:${path}`], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      mkdirSync(dirname(join(dir, 'start', path)), { recursive: true });
      writeFileSync(join(dir, 'start', path), blob);
    }
    return { ok: true, hash: m[1]! };
  } catch (error) {
    return { ok: false, reason: failure(error) };
  }
}

export type ReviewStatus = 'clean' | 'findings' | 'incomplete';
export type ParsedReport =
  | { ok: true; payload: string; status: ReviewStatus; statusLine: string; planHash: string; codeHash: string | null }
  | { ok: false; reason: string };

const BEGIN = /^STRADDLE_REPORT_BEGIN (\{.*\})\s*$/;
const END = /^STRADDLE_REPORT_END (\{.*\})\s*$/;
const HANDOFF = /^STRADDLE_HANDOFF (\{.*\})\s*$/;
const delimiter = (re: RegExp, line: string, file: boolean) => {
  const m = re.exec(line);
  if (!m) return false;
  const body = parseJson(m[1]!);
  return text(field(body, 'skill')) === REVIEW_SKILL && (!file || text(field(body, 'file')) === REVIEW_REPORT);
};

// The review's printed report, by the contract's Report transport rule: the last complete BEGIN and END pair in the
// review session's assistant text that a later STRADDLE_HANDOFF for the skill matches by status. Anything else is
// rejected, and a rejected or missing block is an incomplete review.
export function parseReport(assistantText: string): ParsedReport {
  const lines = assistantText.split('\n').map((l) => l.replace(/\r$/, ''));
  const begins = lines.flatMap((l, i) => (delimiter(BEGIN, l, true) ? [i] : []));
  if (!begins.length) return { ok: false, reason: 'the review printed no report' };
  const start = begins.at(-1)!;
  const endAt = lines.findIndex((l, i) => i > start && delimiter(END, l, false));
  if (endAt < 0) return { ok: false, reason: 'the report has no end line' };
  const body = lines.slice(start + 1, endAt);
  const payload = body.join('\n') + '\n';
  if (Buffer.byteLength(payload) > REPORT_LIMIT) return { ok: false, reason: 'the report is over 64 KiB' };
  if (body[0] !== '# Straddle payment review') return { ok: false, reason: 'the report has no "# Straddle payment review" heading' };
  const statusLine = body.find((l) => l.startsWith('Status: '));
  // An earlier BEGIN with no END before this one: this block opened inside another.
  const previous = begins.at(-2);
  if (previous !== undefined && !lines.slice(previous + 1, start).some((l) => delimiter(END, l, false))) return { ok: false, reason: 'a second report begins inside the report' };
  const status = /^Status: (clean|findings|incomplete \(.+\))$/.exec(statusLine ?? '');
  const plan = body.map((l) => /^Plan hash: ([0-9a-f]{64}|none|unknown)$/.exec(l)).find(Boolean);
  const code = body.map((l) => /^Code hash: ([0-9a-f]{64}|none)$/.exec(l)).find(Boolean);
  if (!status || !plan || !code) return { ok: false, reason: 'the report lacks its Status, Plan hash or Code hash line' };
  const word: ReviewStatus = status[1]!.startsWith('incomplete') ? 'incomplete' : status[1] === 'clean' ? 'clean' : 'findings';
  const handoff = lines.slice(endAt + 1).flatMap((l) => {
    const m = HANDOFF.exec(l.trim());
    const b = m ? parseJson(m[1]!) : undefined;
    return m && text(field(b, 'skill')) === REVIEW_SKILL ? [text(field(b, 'status'))] : [];
  }).at(-1);
  if (handoff !== word) return { ok: false, reason: `no handoff with status ${word} follows the report` };
  return { ok: true, payload, status: word, statusLine: status[1]!, planHash: plan[1]!, codeHash: code[1] === 'none' ? null : code[1]! };
}

// Atomically replaces the repository's review report with `payload`. Refuses a destination that isn't a regular file,
// so a symlink planted at the report's name is never followed or replaced.
export function saveReport(repo: string, payload: string): { ok: true } | { ok: false; reason: string } {
  const dest = join(repo, REVIEW_REPORT);
  try {
    const info = lstatSync(dest);
    if (!info.isFile()) return { ok: false, reason: `${REVIEW_REPORT} in the repository isn't a regular file, so I didn't replace it` };
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) return { ok: false, reason: failure(error) };
  }
  const tmp = join(repo, WIZARD_DIR, `${REVIEW_REPORT}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeFileSync(fd, payload); } finally { closeSync(fd); }
    renameSync(tmp, dest);
    return { ok: true };
  } catch (error) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: failure(error) };
  }
}
