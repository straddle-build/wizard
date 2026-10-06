import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_RELEASES, bundleLabel, downloadRelease, listReleases, loadCachedRelease, loadLocalBundle, pickRelease, releaseDir, type Bundle, type BundleCheck } from './bundle.ts';
import {
  CLIENT_LABEL, CLIENT_NAMES, EVENT_SURFACE, EVENT_SURFACE_NOTE, codexMcpOff, displayCommand, inspectClient, installPlan, launchCommand, manualHandoff, reviewCommand, reviewSettings, runCommands, updatePlan,
  type ClientName, type ClientState, type Command, type CommandResult, type ConfigPlan, type Handoff,
} from './clients.ts';
import { checklistPage, followCodex } from './codex.ts';
import { straddleConfiguration } from './configuration.ts';
import { changedFiles, discover, readRepoFile, snapshot, type RepoFacts } from './discovery.ts';
import { appendEvents, readObservedEvents, transcriptAssistantText, verifyChecklist, type Rollout } from './events.ts';
import { offerLog } from './log.ts';
import { REVIEW_LINE, REVIEW_REPORT, REVIEW_SCOPE_LINE, codeHash, currentBaseline, ensureBaseline, hasReview, parseReport, runRef, saveReport, writeReviewScope } from './review.ts';
import { CONTRACT_FILES, INTEGRATION_PLAN, SKILLS, programFor, programSkills, stepTitles, type ProgramName, type SkillName } from './programs.ts';
import { approvalHash, goLiveSkippable, header, nextStep, progress, statusLine, type StepProgress } from './progress.ts';
import { SESSION_ID, WIZARD_DIR, loadReceipt, newReceipt, receiptPath, saveReceipt, type Answer, type Choices, type LoadedReceipt, type Mode, type Receipt, type RunState, type SessionRun } from './receipt.ts';
import { card, markdown, paint, sanitize, table } from './tui.ts';
import type { Prompter } from './ui.ts';
import { bundledCli, cliSummary, sessionEnv } from './straddle-cli.ts';
import { WIZARD_VERSION } from './version.ts';

export interface JourneyOptions {
  repo: string;
  env: NodeJS.ProcessEnv;
  io: Prompter;
  bundlePath: string | undefined;
  client: ClientName | undefined;
  mode: Mode | undefined;
  exclude: string[];
  // Ask to open the session log when a session ends: a terminal on both ends, and not --json.
  offerLog: boolean;
}

const EXIT_CODE: Record<RunState, number> = { completed: 0, ready: 0, running: 1, blocked: 1, aborted: 130 };
const here = fileURLToPath(import.meta.url);
const HOOK_SCRIPT = join(dirname(here), `hook${extname(here)}`);
const STATUSLINE_SCRIPT = join(dirname(here), `statusline${extname(here)}`);
// The Straddle dashboard serves Sandbox and Production at one address; its Sandbox switch picks the environment.
const DASHBOARD = 'https://dashboard.straddle.com';

// The receipt a Ctrl-C at a Wizard prompt must mark as aborted. While an agent client runs, it owns Ctrl-C. Once a
// session's report is out, its outcome is saved and `settled` holds its exit code: a Ctrl-C at a later optional
// question leaves both alone.
// While the payment review runs, the first Ctrl-C ends the reviewer and its processes and nothing else (`reviewing`).
const active: { receipt: Receipt | null; clientRunning: boolean; settled: number | null; reviewing: boolean; reviewer: ChildProcess | null; reviewCancelled: boolean } = { receipt: null, clientRunning: false, settled: null, reviewing: false, reviewer: null, reviewCancelled: false };

export function handleInterrupt(io: Prompter): void {
  if (active.reviewing) {
    if (!active.reviewCancelled && active.reviewer?.pid) for (const pid of processTree(active.reviewer.pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    active.reviewCancelled = true;
    return;
  }
  if (active.clientRunning) return;
  if (active.settled !== null) {
    io.say();
    process.exit(active.settled);
  }
  if (active.receipt) {
    finish(active.receipt, 'aborted', 'you cancelled at a Wizard prompt');
    io.say('\nStopped. Everything done so far stays in place. Run `wizard resume` to pick up where you left off.');
  } else {
    io.say("\nStopped. I haven't saved or changed anything.");
  }
  process.exit(130);
}

function finish(receipt: Receipt, state: RunState, reason: string): number {
  receipt.state = state;
  receipt.stateReason = reason;
  saveReceipt(receipt);
  return EXIT_CODE[state];
}

function row(io: Prompter, label: string, value: string): void {
  io.say(`  ${label.padEnd(18)}${value}`);
}

function answerText(answer: Answer, evidence: string[]): string {
  if (answer.source === 'developer') return `${answer.value} (you)`;
  return evidence.length ? `${answer.value} (detected: ${evidence.join(', ')})` : answer.value;
}

const CHOICE_LABELS: Record<keyof Choices, string> = { products: 'products', integrationType: 'integration type', sdk: 'SDK', notificationPath: 'notification path' };
const CHOICE_KEYS = Object.keys(CHOICE_LABELS) as (keyof Choices)[];
const PLAN_LABELS = { ...CHOICE_LABELS, bankConnection: 'bank connection' };
type PlanDecisions = Partial<Record<keyof typeof PLAN_LABELS, string>>;

// What the integration plan's Decisions table settles, in any plan state. A choice settled there supersedes the one
// the Wizard saved or detected; reading it approves nothing, and Integrate and Test still run only an approved plan.
// Template placeholders (`a / b`), `open (round N)` and `Unresolved` settle nothing (plan-template.md, Decisions).
function planDecisions(receipt: Receipt): PlanDecisions {
  const plan = readRepoFile(receipt.repo, INTEGRATION_PLAN, receipt.exclude);
  if (plan.kind !== 'read') return {};
  const settled: PlanDecisions = {};
  for (const row of tableRows(section(plan.text, 'Decisions'))) {
    const key = (Object.keys(PLAN_LABELS) as (keyof typeof PLAN_LABELS)[]).find((k) => PLAN_LABELS[k].toLowerCase() === row.Decision?.toLowerCase());
    const answer = sanitize(row.Answer ?? '');
    if (key && answer && !answer.includes(' / ') && !answer.startsWith('open (') && answer !== 'Unresolved') settled[key] = answer;
  }
  return settled;
}

function choicesText(receipt: Receipt): string {
  const c = receipt.context.choices;
  if (!c) return programFor(receipt.program).asksChoices ? "not answered yet; I'll ask before your agent starts" : 'not asked for this program';
  const plan = planDecisions(receipt);
  const decided = CHOICE_KEYS.filter((k) => plan[k]);
  const values = CHOICE_KEYS.map((k) => plan[k] ?? c[k]).join(', ');
  return decided.length ? `${values} (${titleList(decided.map((k) => CHOICE_LABELS[k]))} from ${INTEGRATION_PLAN}, which supersedes the choices saved here)` : values;
}

const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Ruby', 'C#', 'Go', 'Other'] as const;
const SDK_FOR_LANGUAGE: Record<string, Choices['sdk']> = { TypeScript: 'TypeScript', JavaScript: 'TypeScript', Python: 'Python', Ruby: 'Ruby', 'C#': 'C#', Go: 'Go' };

// ---------- First screen ----------

function printWelcome(io: Prompter, facts: RepoFacts, context: Receipt['context'], program: ProgramName): void {
  const skills = programSkills(program, facts.providers);
  const rows: [string, string][] = [
    ['Directory', facts.root],
    ['Language', answerText(context.language, facts.language.evidence)],
    ['Framework', answerText(context.framework, facts.framework.evidence)],
    ['Straddle SDK', facts.straddleSdk ? `${facts.straddleSdk.package} ${facts.straddleSdk.version} (declared in ${facts.straddleSdk.manifest})`.trim() : 'none declared'],
    ['Provider code', facts.providers.length ? facts.providers.join(', ') : 'none to migrate from'],
    ...facts.bankLink ? [['Bank connection', 'Plaid Link found: Plan will ask whether to keep Plaid tokens or move to Straddle Bridge'] as [string, string]] : [],
    ['Program', stepTitles(skills) + (skills.includes('straddle-migrate') && program === 'integration' ? ` (Migrate, because you already use ${facts.providers.join(', ')})` : '')],
    ['Purpose', programFor(program).purpose],
  ];
  const errors = facts.errors.map((err) => `Detection error: ${err}`);
  const privacy = [
    'Your coding agent reads and edits this repo on your machine. I read dependency manifests and file names, and hash',
    `other files locally so I can tell you what changed. I never open .env files, keys or credential files (${facts.excluded.length} skipped),`,
    'and I send nothing to Straddle.',
    ...facts.bankLink || facts.providers.includes('plaid') ? ['Plaid is declared, so I also searched your source files for its Transfer, Identity Verification and Link calls.'] : [],
  ];
  const intro = "I'll set up Straddle in this repo with your coding agent. Here's what I found; correct anything that's off.";
  const look = io.look;
  if (look) {
    io.say(intro);
    // Values come from the repo (its path, manifests, detection errors), so they're sanitized like a report.
    const values = rows.map(([label, value]) => [label, sanitize(value)] as const);
    io.say(card(look, `Straddle Wizard ${WIZARD_VERSION}`, [...values, ...errors.length ? ['', ...errors.map(sanitize)] : [], '', privacy.join(' ')]));
    io.say();
    return;
  }
  io.say(io.bold(`Straddle Wizard ${WIZARD_VERSION}`));
  io.say(intro);
  io.say();
  for (const [label, value] of rows) row(io, label, value);
  if (errors.length) {
    io.say();
    for (const err of errors) io.say(`  ${err}`);
  }
  io.say();
  for (const line of privacy) io.say(`  ${line}`);
  io.say();
}

function printPrivacy(io: Prompter, facts: RepoFacts): void {
  io.say(io.bold('Privacy and data'));
  io.say('  I read package.json, pyproject.toml, requirements.txt, Pipfile, Gemfile, go.mod and *.csproj, and file names, in this repo only.');
  io.say('  When a manifest declares Plaid, I search source files for its Transfer, Identity Verification and Link calls.');
  io.say('  I hash other non-sensitive files locally so I can tell you which files changed. Nothing leaves this machine.');
  const skipped = facts.excluded.slice(0, 20).map((e) => `${e.path} (${e.reason})`);
  if (facts.excluded.length > 20) skipped.push(`and ${facts.excluded.length - 20} more`);
  io.say(`  Skipped without opening: ${skipped.length ? skipped.join(', ') : 'nothing sensitive found'}`);
  if (facts.truncated) io.say("  Discovery stopped at its file limit, so I didn't inspect the rest of the repo.");
  io.say('  I send nothing to Straddle and host no model. Your coding agent reads and edits the repo under its own settings and');
  io.say('  sends content to its own model provider. Straddle requests happen only in your agent, with your approval.');
  io.say(`  I keep run state in ${WIZARD_DIR}/ (git-ignored): receipt.json and events.jsonl. Neither ever holds your API key.`);
  io.say();
}

async function correctContext(io: Prompter, context: Receipt['context']): Promise<void> {
  const which = await io.choose('What should I change?', [
    { label: 'Language', value: 'language' as const },
    { label: 'Framework', value: 'framework' as const },
    { label: 'Back', value: 'back' as const },
  ]);
  if (which === 'language') {
    const language = await io.choose('Language', LANGUAGES.map((l) => ({ label: l, value: l })));
    if (language) context.language = { value: language, source: 'developer' };
  } else if (which === 'framework') {
    const framework = await io.ask(`Framework (leave blank to keep ${context.framework.value}): `);
    if (framework) context.framework = { value: framework, source: 'developer' };
  }
  io.say();
}

async function askChoices(io: Prompter, language: string): Promise<Choices | null> {
  const notDecided = { label: 'Not decided yet (your agent asks later)', value: 'not decided' as const };
  const cancel = { label: 'Cancel', value: null };
  const products = await io.choose('What do you want to build?', [
    { label: 'Pay by Bank charges (collect from customers)', value: 'charges' as const },
    { label: 'Payouts (send money)', value: 'payouts' as const },
    { label: 'Charges and payouts', value: 'charges and payouts' as const },
    notDecided, cancel,
  ]);
  if (!products) return null;
  const integrationType = await io.choose('How does your business use Straddle?', [
    { label: 'Direct: payments for your own business', value: 'direct' as const },
    { label: "SaaS platform: payments for your customers' businesses", value: 'SaaS' as const },
    { label: 'Marketplace: payments between parties you onboard', value: 'marketplace' as const },
    notDecided, cancel,
  ]);
  if (!integrationType) return null;
  const sdkOptions = (['TypeScript', 'Python', 'Ruby', 'C#', 'Go'] as const).map((s) => ({ label: s, value: s }));
  const suggested = SDK_FOR_LANGUAGE[language];
  const suggestedIndex = suggested ? sdkOptions.findIndex((o) => o.value === suggested) : -1;
  const sdk = await io.choose(suggested ? `Which Straddle SDK? (suggested: ${suggested})` : 'Which Straddle SDK?', [...sdkOptions, notDecided, cancel], suggestedIndex >= 0 ? suggestedIndex : undefined);
  if (!sdk) return null;
  const notificationPath = await io.choose('How should your app learn about payment status?', [
    { label: 'Webhook endpoint (Straddle sends events)', value: 'webhook endpoint' as const },
    { label: 'FIFO endpoint', value: 'FIFO endpoint' as const },
    { label: 'Polling endpoint (your app pulls events)', value: 'polling endpoint' as const },
    notDecided, cancel,
  ]);
  if (!notificationPath) return null;
  io.say();
  return { products, integrationType, sdk, notificationPath };
}

// Every supported agent, installed here or not: Manual needs none of them on PATH, and Auto's readiness check stops
// at one that isn't installed. The default is the first one installed.
async function chooseClient(io: Prompter, env: NodeJS.ProcessEnv): Promise<ClientName | null> {
  const states = CLIENT_NAMES.map((name) => inspectClient(name, env));
  const options: Array<{ label: string; value: ClientName | null; hint?: string }> = states.map((state) => ({ label: state.version ? `${state.label} ${state.version}` : `${state.label} (not installed here)`, value: state.name, hint: EVENT_SURFACE_NOTE[state.name] }));
  options.push({ label: 'Cancel', value: null });
  const picked = await io.choose('Which coding agent should do the work?', options, Math.max(0, states.findIndex((s) => s.version)));
  io.say();
  return picked;
}

// Auto is the default when the chosen agent is installed here and logged in, else Manual.
async function chooseMode(io: Prompter, client: ClientName, env: NodeJS.ProcessEnv): Promise<Mode | null> {
  const state = inspectClient(client, env);
  const ready = state.version !== null && state.loggedIn === true;
  const picked = await io.choose('How do you want to run the setup?', [
    { label: 'Auto', value: 'auto' as const, hint: `I start ${state.label} here and it works through the steps` },
    { label: 'Manual', value: 'manual' as const, hint: 'I set everything up and tell you what to paste into your own agent' },
    { label: 'Cancel', value: null },
  ], ready ? 0 : 1);
  io.say();
  return picked;
}

// ---------- Readiness ----------

function printCommandResults(io: Prompter, results: readonly CommandResult[]): boolean {
  for (const r of results) {
    io.say(`${r.outcome.padEnd(8)}${displayCommand(r.command)}`);
    if (r.outcome === 'failed') io.say(r.output.split('\n').slice(-5).map((l) => `        ${l}`).join('\n'));
  }
  return results.every((r) => r.outcome !== 'failed');
}

// ---------- Skill bundle ----------

export interface BundleRequest { override: string | undefined; env: NodeJS.ProcessEnv }

// The developer's --bundle, else the verified plugin release already on this machine. Never fetches.
export function findBundle(req: BundleRequest): BundleCheck {
  return req.override ? loadLocalBundle(req.override) : loadCachedRelease(req.env);
}

// The developer's --bundle, else the newest plugin release in range: the cached copy when it is that release,
// otherwise downloaded and verified after the developer agrees. When the release list cannot be read, the release
// already on this machine is used. Resolves null when the developer cancels.
export async function prepareBundle(io: Prompter, req: BundleRequest, yes: boolean): Promise<BundleCheck | null> {
  if (req.override) return loadLocalBundle(req.override);
  const cached = loadCachedRelease(req.env);
  let listed: unknown;
  try {
    listed = await listReleases(req.env);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (!cached.ok) return { ok: false, reason: `I couldn't read the Straddle plugin releases (${why}). ${cached.reason}` };
    io.say(`I couldn't check for a newer Straddle plugin release (${why}), so I'm using the ${bundleLabel(cached.bundle)} already on this machine.`);
    io.say();
    return cached;
  }
  const release = pickRelease(listed);
  if (typeof release === 'string') return { ok: false, reason: release };
  if (cached.ok && cached.bundle.pluginVersion === release.version) return cached;
  io.say(io.bold('Straddle skills'));
  io.say(`  ${cached.ok ? `Plugin release v${cached.bundle.pluginVersion} is on this machine. ` : ''}The newest ${PLUGIN_RELEASES.range} plugin release is ${release.tag} (${release.page}).`);
  io.say(`  I'll download it into ${releaseDir(req.env)}, check it against the release's SHA256SUMS, and change nothing else:`);
  io.say(`    GET ${release.archiveUrl}`);
  io.say(`    GET ${release.sumsUrl}`);
  if (!yes) {
    const go = await io.choose('Download the Straddle skills?', [{ label: 'Download', value: true }, { label: 'Cancel', value: false }], 0);
    io.say();
    if (!go) return null;
  }
  const check = await downloadRelease(release, req.env);
  if (check.ok) io.say(`Verified straddle-plugin-${release.version}.zip against the ${release.tag} SHA256SUMS.\n`);
  return check;
}

export function printPlan(say: (line: string) => void, plan: ConfigPlan): void {
  if (plan.kind === 'nothing') { say(plan.note); return; }
  if (plan.kind === 'manual') { for (const step of plan.steps) say(`  ${step}`); return; }
  for (const command of plan.commands) say(`    ${displayCommand(command)}`);
  say(`  ${plan.note}`);
}

function printReadiness(io: Prompter, receipt: Receipt, bundle: Bundle, client: ClientState, env: NodeJS.ProcessEnv): void {
  const config = straddleConfiguration(env);
  io.say(io.bold(`Checking ${client.label}`));
  row(io, 'Mode', receipt.mode === 'manual'
    ? "Manual: I start no agent; I tell you what to paste into yours (change with `wizard resume --mode auto`)"
    : `Auto: I start ${client.label} here (change with \`wizard resume --mode manual\`)`);
  row(io, 'Skill bundle', bundleLabel(bundle));
  row(io, 'Agent', client.version ? `${client.label} ${client.version}` : `${client.label}: not found`);
  if (client.loggedIn !== null) row(io, 'Agent login', client.loggedIn ? 'logged in' : 'not logged in');
  row(io, 'Straddle CLI', cliSummary(bundledCli()));
  const installed = client.plugin.state === 'installed'
    ? `installed ${client.plugin.version ?? ''}, ${client.plugin.verified ? "matches the Wizard's bundle" : "differs from the Wizard's bundle"}`
    : client.plugin.state === 'missing' ? 'not installed' : "unverified (I can't inspect this client)";
  if (receipt.pluginLoad === 'session' && client.name === 'cursor') {
    row(io, 'Straddle plugin', `loaded into the Wizard's session from that bundle with --plugin-dir (your Cursor install: ${installed})`);
    row(io, 'API MCP', 'declared by that plugin, which Cursor names plugin-<bundle folder>-straddle-api; cursor-agent sends STRADDLE_API_KEY from your shell');
    row(io, 'Session settings', "yours: I start cursor-agent with your own approval mode, sandbox and workspace trust, and don't change them.");
  } else if (receipt.pluginLoad === 'session') {
    row(io, 'Straddle plugin', `loaded into the Wizard's session from that bundle with --plugin-dir (your Claude Code install: ${installed})`);
    row(io, 'API MCP', 'declared by that plugin; Claude Code sends STRADDLE_API_KEY from its session environment: your shell, or your Claude Code settings `env` if it sets the key');
    row(io, 'Session settings', "yours: I start Claude Code with your own settings, including your permission mode and any `env` values, and don't change them. My session settings add the checklist status line, which replaces yours for this session, progress hooks and the pre-plan edit hook.");
  } else {
    row(io, 'Straddle plugin', installed);
    row(io, 'API MCP', client.apiMcp);
    if (client.name === 'codex' && receipt.mode !== 'manual') row(io, 'Session settings', "yours: I start Codex with your own sandbox, approval policy and configuration and don't change them.");
  }
  const override = receipt.pluginLoad === 'session' && client.name === 'claude' ? '; any `env` value in your Claude Code settings overrides it in the session, and the skills check the environment again there' : '';
  row(io, 'Straddle key', config.key === 'present' ? "STRADDLE_API_KEY is set in your shell (I didn't read the value)" : 'STRADDLE_API_KEY is not set in your shell');
  row(io, 'Environment', `${config.environment} in your shell${override}`);
  io.say();
}

async function ensureReady(io: Prompter, receipt: Receipt, opts: JourneyOptions): Promise<{ bundle: Bundle; client: ClientState } | number> {
  const check = await prepareBundle(io, { override: opts.bundlePath, env: opts.env }, false);
  if (!check) return finish(receipt, 'aborted', 'you cancelled the Straddle skills download');
  if (!check.ok) {
    io.say(`I can't use the Straddle skills: ${check.reason}`);
    return finish(receipt, 'blocked', `skill bundle: ${check.reason}`);
  }
  const bundle = check.bundle;
  receipt.bundle = { kind: bundle.kind, pluginVersion: bundle.pluginVersion, contentSha256: bundle.contentSha256, path: bundle.path };
  const name = receipt.client!;
  const manual = receipt.mode === 'manual';
  // Auto Claude Code and Cursor sessions load the Wizard's bundle with --plugin-dir, which wins over an installed
  // `straddle` plugin, so nothing needs installing. A managed enabledPlugins lock or a `"straddle@inline": false` entry
  // can still keep it out of Claude Code.
  receipt.pluginLoad = !manual && name !== 'codex' ? 'session' : null;
  let repaired = false;
  for (;;) {
    const client = inspectClient(name, opts.env, bundle);
    printReadiness(io, receipt, bundle, client, opts.env);
    // Manual into an agent I can't see or install into: the handoff steps say to install the plugin there.
    if (manual && (name === 'cursor' || !client.version || client.plugin.state === 'unverified')) { receipt.pluginLoad = 'manual'; return { bundle, client }; }
    if (!client.version) {
      io.say(`${client.label} isn't installed or isn't on your PATH. Install it, or run \`wizard\` again and pick another agent.`);
      return finish(receipt, 'blocked', `${client.label} not found`);
    }
    // Manual: you log in to your own agent; I start none.
    if (!manual && client.loggedIn === false) {
      io.say(`${client.label} isn't logged in. Run \`${{ claude: 'claude auth login', codex: 'codex login', cursor: 'cursor-agent login' }[name]}\` in your terminal, then choose Recheck. I never handle your agent's credentials.`);
      const next = await io.choose('Next', [{ label: 'Recheck', value: 'recheck' as const }, { label: 'Stop here (resume later with `wizard resume`)', value: 'stop' as const }]);
      if (next === 'recheck') continue;
      return finish(receipt, 'blocked', `${client.label} is not logged in`);
    }
    if (receipt.pluginLoad === 'session') return { bundle, client };
    // Codex loads its own installed copy, so that copy, not just its version, must be the Wizard's bundle.
    if (client.plugin.verified) {
      receipt.pluginLoad = 'installed';
      return { bundle, client };
    }
    if (repaired) {
      io.say(`The Straddle plugin ${client.label} would load still differs from the Wizard's bundle after the repair.`);
      return finish(receipt, 'blocked', `the Straddle plugin in ${client.label} differs from the Wizard's bundle`);
    }

    const outdated = client.plugin.state === 'installed';
    const plan = outdated ? updatePlan(client, bundle) : installPlan(client, bundle);
    io.say(outdated ? `The Straddle plugin ${client.label} would load (${client.plugin.version ?? 'unknown version'}) differs from the Wizard's bundle.` : `The Straddle plugin isn't installed in ${client.label}.`);
    type Repair = 'apply' | 'manual' | 'cancel';
    const options: Array<{ label: string; value: Repair }> = [];
    if (plan.kind === 'commands') options.push({ label: outdated ? 'Update it with these commands' : 'Install it with these commands', value: 'apply' });
    options.push({ label: 'Show manual steps and stop', value: 'manual' }, { label: 'Cancel', value: 'cancel' });
    printPlan((line) => io.say(line), plan);
    const repair = await io.choose('How should I get the plugin?', options, 0);
    io.say();
    if (repair === 'apply' && plan.kind === 'commands') {
      if (!printCommandResults(io, runCommands(plan.commands, opts.env))) return finish(receipt, 'blocked', 'plugin installation failed');
      io.say();
      repaired = true;
      continue;
    }
    if (repair === 'manual') {
      io.say('Manual steps:');
      if (plan.kind === 'commands') for (const command of plan.commands) io.say(`  ${displayCommand(command)}`);
      else printPlan((line) => io.say(line), plan);
      return finish(receipt, 'blocked', 'Straddle plugin not installed');
    }
    return finish(receipt, 'aborted', 'you cancelled at the readiness check');
  }
}

// ---------- Progress ----------

type Steps = ReadonlyArray<{ skill: SkillName; total: number }>;

const eventsPath = (repo: string) => join(repo, WIZARD_DIR, 'events.jsonl');

function stepCounts(bundle: Bundle | null, skills: readonly SkillName[]): Steps {
  return skills.map((skill) => {
    const dir = bundle ? join(bundle.path, 'skills', skill, 'steps') : '';
    return { skill, total: dir && existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{2}-.*\.md$/.test(f)).length : 0 };
  });
}

// The steps as the files and recorded events show them, and how many event lines were skipped as unreadable.
interface Progress { items: StepProgress[]; skipped: number }

// Claude Code and Codex in Auto show the Wizard the agent's handoffs; Cursor and Manual don't.
const observedRun = (receipt: Receipt) => receipt.client !== null && receipt.mode !== 'manual' && EVENT_SURFACE[receipt.client] === 'observed';

function currentProgress(receipt: Receipt, steps: Steps): Progress {
  const { events, skipped } = readObservedEvents(eventsPath(receipt.repo));
  return { items: progress(receipt.repo, receipt.exclude, steps, events, observedRun(receipt)), skipped };
}

const skippedNote = (skipped: number) =>
  `I skipped ${skipped} unreadable line${skipped === 1 ? '' : 's'} in ${WIZARD_DIR}/events.jsonl, so the checklist can miss some progress. The step files still decide where you resume.`;

// One row per step: the tick, what its file says (read by the Wizard), what the agent reported, and what the client
// showed of the step files the agent opened.
function stepCells(items: readonly StepProgress[], observed: boolean): ['✓' | '▶' | ' ', string, string, string, string][] {
  return items.map((p) => {
    const route = SKILLS[p.skill];
    const file = p.skipped ? 'skipped: you finished after Test' : p.record && route.record ? `${route.record.file}: ${p.record.detail}` : 'writes no status file';
    const said = !p.reported ? 'no handoff reported'
      : p.reported.kind === 'abort' ? `reported STRADDLE_ABORT${p.reported.reason ? ` (${p.reported.reason})` : ''}`
        : `reported ${p.reported.status ?? 'a handoff with no status'}`;
    const seen = observed ? `${p.total ? `${p.entered} of ${p.total}` : p.entered} step file${(p.total || p.entered) === 1 ? '' : 's'} opened` : 'progress not observable';
    return [p.done ? '✓' : p.entered ? '▶' : ' ', route.title, file, said, seen];
  });
}

function stepRows(items: readonly StepProgress[], observed: boolean): string[] {
  const width = Math.max(...items.map((p) => SKILLS[p.skill].title.length)) + 2;
  return stepCells(items, observed).map(([mark, title, ...rest]) => `${mark} ${title.padEnd(width)}${rest.join(' · ')}`);
}

// In a terminal the checklist is a table, its tick a status mark: green done, yellow under way, a dim dot not started.
const MARK = { '✓': 'green', '▶': 'yellow', ' ': 'dim' } as const;

function printSteps(io: Prompter, { items, skipped }: Progress, observed: boolean): void {
  const look = io.look;
  if (look) {
    // The File column quotes the step file's header, so it's sanitized like a report.
    const rows = stepCells(items, observed).map(([mark, ...rest]) => [paint(look, MARK[mark], mark === ' ' ? '○' : mark), ...rest.map(sanitize)]);
    io.say(table({ ...look, width: look.width - 2 }, ['', 'Step', 'File', 'Handoff', 'Progress'], rows).replace(/^/gm, '  '));
  } else for (const line of stepRows(items, observed)) io.say(`  ${line}`);
  if (skipped) io.say(`  ${skippedNote(skipped)}`);
}

const LEGEND = "✓ means the file and your agent's handoff agree. I read each file myself; a handoff is what your agent reported.";
const FILE_LEGEND = "✓ means the file says the step is done. I read each file myself; I can't see your agent's handoffs here.";

// ---------- Session ----------

// The first section whose heading starts with `heading`, at any level from `##`, so a revised plan's
// `## Future Sandbox writes (revised)` or a run's `### Server-side resources` still matches. It ends at the next heading
// of the same or a higher level.
function section(textContent: string, heading: string): string[] {
  const lines = textContent.split('\n');
  const name = heading.toLowerCase();
  const start = lines.findIndex((l) => /^#{2,6} /.test(l.trim()) && l.trim().replace(/^#+ +/, '').toLowerCase().startsWith(name));
  if (start < 0) return [];
  const closes = new RegExp(`^#{1,${/^#+/.exec(lines[start]!.trim())![0].length}} `);
  const end = lines.findIndex((l, i) => i > start && closes.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim());
}

function tableRows(lines: readonly string[]): Record<string, string>[] {
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const table = lines.filter((l) => l.trim().startsWith('|'));
  if (table.length < 2) return [];
  const head = cells(table[0]!);
  return table.slice(2).map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i] ?? '', c])));
}

// Integrate and Test apply the same approval rule to the plan (skills straddle-integrate and straddle-test, step 01-begin).
function showPlan(io: Prompter, receipt: Receipt, skill: SkillName): void {
  const route = SKILLS[skill];
  const planFile = route.requiresAnyOf.find((f) => existsSync(join(receipt.repo, f))) ?? route.requiresAnyOf[0];
  if (!planFile) return;
  const plan = readRepoFile(receipt.repo, planFile, receipt.exclude);
  if (plan.kind === 'absent') return;
  if (plan.kind === 'skipped') {
    io.say(io.bold(`Plan: ${planFile}`));
    io.say(`  Not shown: I don't open it because ${plan.reason}. Review it in your coding agent.`);
    io.say();
    return;
  }
  io.say(io.bold(`Plan: ${planFile} (Plan state: ${header(plan.text, 'Plan state') ?? 'not recorded'})`));
  for (const heading of ['File changes', 'Future Sandbox writes']) {
    io.say(`  ${heading}`);
    const lines = section(plan.text, heading);
    for (const line of lines.length ? lines : ['(section not found)']) io.say(`    ${line}`);
  }
  io.say(`  ${route.title} runs only an approved plan: an approval recorded in the file that matches the current plan, or your`);
  io.say(`  approval of the current plan in the session. Editing the plan after approval voids the record. If ${route.title} stops`);
  io.say("  because the plan isn't approved, approve the current plan there and ask it to continue. Every Sandbox write");
  io.say('  still gets its own preview and approval there. Nothing here counts as approval.');
  io.say();
}

// Auto's audit findings. In a terminal the report at the end of the session renders the whole file instead.
function showAuditFindings(io: Prompter, receipt: Receipt): void {
  const report = readRepoFile(receipt.repo, 'straddle-audit-report.md', receipt.exclude);
  if (report.kind === 'absent') { io.say("  straddle-audit-report.md wasn't written."); return; }
  if (report.kind === 'skipped') { io.say(`  straddle-audit-report.md isn't shown: I don't open it because ${report.reason}.`); return; }
  if (io.look) return;
  io.say(io.bold('Findings (straddle-audit-report.md)'));
  const table = section(report.text, 'Findings').filter((l) => l.trim().startsWith('|'));
  for (const line of table.length ? table : ['(no findings table in the report)']) io.say(`  ${line.trim()}`);
  io.say();
}

// Everything the developer confirmed in the Wizard, with where each value came from. Skill instructions stay in the skill.
function contextForAgent(receipt: Receipt): string {
  const { language, framework, choices: c } = receipt.context;
  const origin = (a: Answer) => (a.source === 'developer' ? 'corrected by the developer' : 'detected');
  const link = receipt.context.bankLink;
  const plan = planDecisions(receipt);
  // A bank connection the plan settled supersedes the detected one, so the agent isn't told both.
  const bank = link && !plan.bankConnection ? ` Bank connection already in the repo: Plaid Link${link.processorTokens ? ' with processor tokens' : ''} (detected; a Plan decision, not part of a migration).` : '';
  const context = `Repository context confirmed in the Straddle Wizard: language ${language.value} (${origin(language)}); framework ${framework.value} (${origin(framework)}).${bank}`;
  const saved = c ? CHOICE_KEYS.filter((k) => !plan[k]).map((k) => `${CHOICE_LABELS[k]} ${c[k]}`) : [];
  const decided = (Object.keys(PLAN_LABELS) as (keyof typeof PLAN_LABELS)[]).filter((k) => plan[k] && (c || k === 'bankConnection')).map((k) => `${PLAN_LABELS[k]} ${plan[k]}`);
  return [
    context,
    ...saved.length ? [`Developer choices from the Straddle Wizard: ${saved.join('; ')}.`] : [],
    ...decided.length ? [`Decided in ${INTEGRATION_PLAN}, which supersedes the Wizard's saved choices: ${decided.join('; ')}.`] : [],
  ].join(' ');
}

// Said to a reopened session, whose earlier previews and yeses are back in its context (wizard-program.md).
const REOPENED = "This session was reopened by the Straddle Wizard. Approvals given before this message don't count: show every Sandbox write preview again and ask; a plan approval counts only as recorded in the plan file.";

// The skills recognize a line beginning `Straddle Wizard program:` and walk the listed steps in this one session.
function programPrompt(run: readonly SkillName[], receipt: Receipt, reopened: boolean): string {
  return [
    `Straddle Wizard program: ${run.join(' → ')}. Start at ${run[0]}.`,
    "Run the listed steps in order in this one session: after each step's STRADDLE_HANDOFF, continue with the next listed step without waiting for the Wizard; stop and ask whenever a step needs the developer (plan approval, each Sandbox write).",
    ...(reopened ? [REOPENED] : []),
    contextForAgent(receipt),
  ].join('\n');
}

// The exact configuration errors, what can still run, and how to fix them. `setupLeft`: Setup stops at a configuration
// error, so the session leaves it until the values are set.
function printConfigurationError(io: Prompter, errors: string[], env: NodeJS.ProcessEnv, canRun: readonly SkillName[], stopsAt: SkillName | undefined, setupLeft: boolean): void {
  io.say(`Configuration error: ${errors.join('; ')}.`);
  if (setupLeft) io.say("  Setup stops at this error, so I'll leave it until you've fixed it.");
  const titles = canRun.map((s) => SKILLS[s].title).join(' and ');
  if (titles) io.say(`  ${titles} ${canRun.length === 1 ? 'sends' : 'send'} no Straddle request, so I'll start the session there and list only ${titles}.`);
  if (stopsAt) {
    io.say(`  ${SKILLS[stopsAt].title} can send Straddle requests, and the skill refuses every one until this is fixed, so ${titles ? 'it won\'t start' : 'I won\'t start it'}: zero Straddle requests are sent.`);
    io.say(`  ${SKILLS[stopsAt].title} won't start until you fix this in your own shell and run \`wizard resume\`:`);
  } else {
    io.say('  Fix this in your own shell, then run `wizard resume`:');
  }
  io.say('    export STRADDLE_API_KEY=<your Sandbox key>    # type it in your shell, never into the Wizard');
  io.say('    export STRADDLE_ENVIRONMENT=sandbox');
  if (env.STRADDLE_BASE_URL) io.say('    unset STRADDLE_BASE_URL                       # or set it to https://sandbox.straddle.com');
  if (setupLeft) io.say('  When you resume, Setup runs first and checks the values.');
  io.say("  I check only these shell variables, not a saved Straddle CLI login.");
  io.say();
}

interface ClientExit { code: number | null; signal: string | null; error: string | null }

// The process and its descendants, read before any of them is signalled so none is reparented away first. A
// descendant that already left the tree (a double-forked daemon) isn't found. Without `ps`, the process alone.
function processTree(root: number): number[] {
  let out = '';
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return [root]; }
  const children = new Map<number, number[]>();
  for (const line of out.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree: number[] = [];
  for (const stack = [root]; stack.length;) { const pid = stack.pop()!; tree.push(pid); stack.push(...(children.get(pid) ?? [])); }
  return tree;
}

function runInteractive(command: Command, cwd: string, env: NodeJS.ProcessEnv, onChild?: (child: ChildProcess) => void): Promise<ClientExit> {
  const { promise, resolve } = Promise.withResolvers<ClientExit>();
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  active.clientRunning = true;
  const child = spawn(command.bin, command.args, { cwd, env, stdio: 'inherit' });
  onChild?.(child);
  process.on('SIGTERM', forward);
  process.on('SIGHUP', forward);
  const done = (exit: ClientExit) => {
    active.clientRunning = false;
    process.off('SIGTERM', forward);
    process.off('SIGHUP', forward);
    resolve(exit);
  };
  child.on('error', (error) => done({ code: null, signal: null, error: error.message }));
  child.on('exit', (code, signal) => done({ code, signal, error: null }));
  return promise;
}

interface Ready { bundle: Bundle; client: ClientState }

// `Setup, Plan and Integrate`.
const titleList = (titles: readonly string[]) => titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0] ?? '';

// The steps one session runs from `start`: `start` and every unfinished step after it, never a finished one. When the
// configuration isn't ready, Setup waits (it stops at the error) and the session ends before the first step that can
// send Straddle requests (`sends`; 0 means the session can't start). `wizard`, `wizard resume` and `wizard status` share it.
function sessionSteps(repo: string, items: readonly StepProgress[], start: SkillName, env: NodeJS.ProcessEnv) {
  const skills = items.map((p) => p.skill);
  let run = skills.slice(skills.indexOf(start)).filter((s) => s === start || !items.find((p) => p.skill === s)!.finished);
  const config = straddleConfiguration(env);
  const setupLeft = config.errors.length > 0 && run[0] === 'straddle-setup' && run.length > 1;
  if (setupLeft) run = run.slice(1);
  const sends = config.errors.length ? run.findIndex((s) => SKILLS[s].sendsStraddleRequests) : -1;
  const first = SKILLS[run[0]!];
  const missing = first.requiresAnyOf.length && !first.requiresAnyOf.some((f) => existsSync(join(repo, f))) ? first.requiresAnyOf : null;
  return { run, config, setupLeft, sends, missing, runnable: sends > 0 ? run.slice(0, sends) : run };
}

// The payment review (skills wizard-program.md, Payment review) applies to a program that writes code (Integrate or
// Migrate) and reaches Go Live, with a bundle that carries the review: in Auto with Claude Code or Codex, and in Manual
// with Claude Code, whose printed review command carries the Wizard's hooks so its transcript is known. A Manual Codex
// review has no such binding yet (a rollout can't be tied to the printed command), so there, in Cursor, and anywhere
// else the program runs as it did, and Go Live itself warns that no current review ran. The review never blocks.
function reviewApplies(receipt: Receipt, skills: readonly SkillName[], bundle: Bundle): boolean {
  const client = receipt.mode === 'manual' ? receipt.client === 'claude' : receipt.client !== 'cursor';
  return hasReview(bundle) && client && skills.includes('straddle-go-live') && (skills.includes('straddle-integrate') || skills.includes('straddle-migrate'));
}

function recordBaseline(io: Prompter, receipt: Receipt, skills: readonly SkillName[], bundle: Bundle, env: NodeJS.ProcessEnv): void {
  if (!hasReview(bundle) || !skills.includes('straddle-go-live') || !(skills.includes('straddle-integrate') || skills.includes('straddle-migrate'))) return;
  const result = ensureBaseline(receipt.repo, receipt.runId, bundle, env, receipt.exclude, receipt.sessions.length === 0);
  if (result.ok && result.created) io.say(`  I recorded this repo's starting state (${runRef(receipt.runId)}) for ${reviewApplies(receipt, skills, bundle) ? 'the payment review after Test' : "Go Live's payment review row; no review runs in this client"}.`);
  else if (!result.ok) io.say(`  The payment review can't scope this repo: ${result.reason}. Go Live will list that as a warning.`);
}

function reviewCurrent(receipt: Receipt, bundle: Bundle, env: NodeJS.ProcessEnv): boolean {
  const baseline = currentBaseline(receipt.repo, receipt.runId);
  const report = readRepoFile(receipt.repo, REVIEW_REPORT, receipt.exclude);
  const plan = readRepoFile(receipt.repo, INTEGRATION_PLAN, receipt.exclude);
  if (!baseline || report.kind !== 'read' || plan.kind !== 'read') return false;
  const now = codeHash(receipt.repo, bundle, baseline.snapshot, env, receipt.exclude);
  const status = header(report.text, 'Status');
  return now.ok && (status === 'clean' || status === 'findings') && header(report.text, 'Code hash') === now.hash && header(report.text, 'Plan hash') === approvalHash(plan.text);
}

// The fresh, read-only review session after Test. It writes nothing; the Wizard saves the report it prints, only when
// the printed block passes the contract's checks and the code hash before the review, after it and in the report
// match. A cancelled review saves nothing, and an earlier report stays as it was.
async function runReview(io: Prompter, receipt: Receipt, ready: Ready, opts: JourneyOptions): Promise<{ ok: true } | { ok: false; reason: string; stopped?: true }> {
  const { repo } = receipt;
  const client = receipt.client!;
  const label = CLIENT_LABEL[client];
  const baseline = currentBaseline(repo, receipt.runId);
  if (!baseline) return { ok: false, reason: "this run has no baseline from its first session, so the review can't tell its changes apart" };
  const runDir = join(repo, WIZARD_DIR, 'runs', receipt.runId);
  mkdirSync(runDir, { recursive: true });
  const scope = `${WIZARD_DIR}/runs/${receipt.runId}/review-scope`;
  const planFile = readRepoFile(repo, INTEGRATION_PLAN, receipt.exclude);
  const before = writeReviewScope(repo, ready.bundle, baseline.snapshot, planFile.kind === 'read' ? approvalHash(planFile.text) : 'none', opts.env, receipt.exclude, join(repo, scope));
  if (!before.ok) return { ok: false, reason: before.reason };
  const eventsFile = eventsPath(repo);
  const settingsPath = join(runDir, `review-${receipt.sessions.length + 1}.settings.json`);
  const mcp = client === 'codex' ? codexMcpOff(repo, opts.env) : { ok: true as const, config: [] };
  if (!mcp.ok) return { ok: false, reason: mcp.reason };
  const command = reviewCommand({ client, repo, settingsPath, pluginDir: ready.bundle.path, line: `${REVIEW_LINE}\n${REVIEW_SCOPE_LINE}${scope}`, codexConfig: mcp.config });
  if (!command) return { ok: false, reason: `the payment review runs in Claude Code or Codex, not ${label}` };
  const manual = receipt.mode === 'manual';
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const hook = [{ type: 'command', command: [process.execPath, HOOK_SCRIPT, '--events', eventsFile, '--repo', repo, '--gate', ''].map(quote).join(' ') }];
  const writeSettings = () => { if (client === 'claude') writeFileSync(settingsPath, JSON.stringify(reviewSettings({ SessionStart: [{ hooks: hook }], SessionEnd: [{ hooks: hook }], Stop: [{ hooks: hook }], PostToolUse: [{ hooks: hook }] }), null, 2)); };
  const session: SessionRun = { client, sessionId: null, skills: [], role: 'review', startedAt: new Date().toISOString(), endedAt: null, exit: null, changedFiles: [], evidenceLimits: [], checklist: [] };
  io.say(io.bold(`Payment review in ${label}`));
  let exit: ClientExit = { code: 0, signal: null, error: null };
  let rollout: Rollout | undefined;
  let cancelled = false;
  if (manual) {
    // Manual: the developer starts the reviewer, a new session with this review's own read-only settings file. Only
    // that file carries the Wizard's hooks, so the session that started from it after this point is the review's.
    writeSettings();
    io.say(`  Test is done. Run this in a new terminal in ${repo}. It starts a new ${label} session, not your earlier one, that reviews the code this run changed. It can't edit files, reach the network or change your settings, and it prints a report I save to ${REVIEW_REPORT}:`);
    io.say(`    ${displayCommand(command)}`);
    io.say('  Come back here when it ends.');
    receipt.sessions.push(session);
    saveReceipt(receipt);
    const back = await io.choose('Next', [{ label: "I'm back: read the review", value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
    io.say();
    if (!back) return { ok: false, reason: 'you stopped before the payment review', stopped: true };
  } else {
    io.say(`  Test is done. ${label} opens once more, in a fresh read-only session, to review the code this run changed. It can't edit files, reach the network or change your settings; I save the report it prints to ${REVIEW_REPORT}.`);
    io.say('  Press Ctrl-C once to cancel it. Your original session and the run\'s starting state stay as they are.');
    const go = await io.choose('Next', [{ label: 'Start the payment review', value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
    io.say();
    if (!go) return { ok: false, reason: 'you stopped before the payment review', stopped: true };
    writeSettings();
    session.startedAt = new Date().toISOString();
    receipt.sessions.push(session);
    receipt.state = 'running';
    receipt.stateReason = `payment review running in ${label}`;
    saveReceipt(receipt);
    const follower = client === 'codex' ? followCodex(opts.env, repo, eventsFile, Date.now() - 1000, null) : null;
    active.reviewing = true;
    active.reviewCancelled = false;
    exit = await runInteractive(command, repo, opts.env, (child) => { active.reviewer = child; });
    rollout = follower?.stop();
    active.reviewer = null;
    cancelled = active.reviewCancelled;
    active.reviewing = false;
  }
  session.endedAt = new Date().toISOString();
  session.exit = { code: exit.code, signal: exit.signal };
  const events = readObservedEvents(eventsFile).events.filter((e) => e.at >= session.startedAt);
  const started = events.findLast((e) => e.kind === 'session-start' && e.session);
  session.sessionId = rollout?.session ?? (started?.kind === 'session-start' ? started.session ?? null : null);
  saveReceipt(receipt);
  if (manual && !started) return { ok: false, reason: 'no review session started from the printed command' };
  if (cancelled) return { ok: false, reason: 'you cancelled the payment review', stopped: true };
  if (exit.error) return { ok: false, reason: `${label} couldn't start: ${exit.error}` };
  const transcripts = [...new Set(events.flatMap((e) => (e.kind === 'session-start' && e.transcript ? [e.transcript] : [])))];
  const report = parseReport(rollout ? rollout.text.join('\n') : transcripts.map(transcriptAssistantText).join('\n'));
  if (!report.ok) return { ok: false, reason: report.reason };
  const after = codeHash(repo, ready.bundle, baseline.snapshot, opts.env, receipt.exclude);
  if (!after.ok || after.hash !== before.hash) return { ok: false, reason: 'the code changed while the payment review ran' };
  if (report.codeHash !== null ? report.codeHash !== before.hash : report.status !== 'incomplete') return { ok: false, reason: "the report's Code hash isn't the code's" };
  // The same plan binding Go Live and a saved report need: a review of another plan never counts.
  const plan = readRepoFile(repo, INTEGRATION_PLAN, receipt.exclude);
  if (report.status !== 'incomplete' && (plan.kind !== 'read' || report.planHash !== approvalHash(plan.text))) return { ok: false, reason: "the report's Plan hash isn't the current plan's" };
  const saved = saveReport(repo, report.payload);
  if (!saved.ok) return { ok: false, reason: saved.reason };
  io.say(`  Payment review: ${report.statusLine}. I saved it to ${REVIEW_REPORT}.`);
  return report.status === 'incomplete' ? { ok: false, reason: `the review reported ${report.statusLine}` } : { ok: true };
}

async function runSession(io: Prompter, receipt: Receipt, steps: Steps, start: SkillName, ready: Ready, opts: JourneyOptions): Promise<number> {
  const { repo } = receipt;
  const client = receipt.client!;
  const label = CLIENT_LABEL[client];
  const skills = steps.map((s) => s.skill);
  const atStart = currentProgress(receipt, steps).items;
  const { run: planned, config, setupLeft, sends, missing, runnable: run } = sessionSteps(repo, atStart, start, opts.env);
  const begin = run[0]!;
  const first = SKILLS[begin];

  if (missing) {
    io.say(`${first.title} needs ${missing.join(' or ')}. Run \`wizard plan\` first: no code changes happen before there's a plan.`);
    return finish(receipt, 'blocked', `${first.title} needs ${missing.join(' or ')}`);
  }
  if (begin === 'straddle-integrate' || begin === 'straddle-test') showPlan(io, receipt, begin);

  if (sends >= 0 || setupLeft) {
    printConfigurationError(io, config.errors, opts.env, sends < 0 ? planned : planned.slice(0, sends), sends < 0 ? undefined : planned[sends], setupLeft);
    if (sends === 0) return finish(receipt, 'blocked', `configuration error: ${config.errors.join('; ')}`);
  }

  // Go Live runs after a current review: the one just run, or a saved one whose hashes still match. The review is
  // advisory, so a failed or incomplete one only warns; only the developer stopping or cancelling it waits for resume.
  const reviewed = reviewApplies(receipt, skills, ready.bundle);
  if (reviewed && begin === 'straddle-go-live' && !reviewCurrent(receipt, ready.bundle, opts.env)) {
    const review = await runReview(io, receipt, ready, opts);
    if (!review.ok && review.stopped) {
      io.say(`  ${review.reason[0]!.toUpperCase()}${review.reason.slice(1)}. I didn't start Go Live. Run \`wizard resume\` to review again.`);
      finish(receipt, 'blocked', `payment review not run: ${review.reason}`);
      io.say();
      return printReport(io, receipt, currentProgress(receipt, steps), ready.bundle);
    }
    if (!review.ok) io.say(`  The payment review is incomplete: ${review.reason}. It's advisory, so Go Live runs and lists it as a warning.`);
  }
  const split = reviewed && run.includes('straddle-go-live') && begin !== 'straddle-go-live';
  const leg = split ? run.filter((s) => s !== 'straddle-go-live') : run;

  const previous = receipt.sessions.findLast((s) => s.client === client && s.sessionId && s.role !== 'review');
  const done = atStart.filter((p) => p.finished).map((p) => SKILLS[p.skill].title);
  const render = () => {
    const now = currentProgress(receipt, steps);
    return [`Straddle Wizard: ${stepTitles(skills)} in Codex`, '', statusLine(now.items, begin), '', ...stepRows(now.items, true), ...(now.skipped ? [skippedNote(now.skipped)] : []), '', LEGEND].join('\n');
  };
  const manual = receipt.mode === 'manual';
  const page = client === 'codex' && !manual ? await checklistPage(render) : null;
  io.say(io.bold(`Your session in ${label}: ${stepTitles(run)}`));
  if (done.length) io.say(`  ${titleList(done)} ${done.length === 1 ? 'is' : 'are'} done; I read that from ${done.length === 1 ? 'its file' : 'their files'}. I'll start at ${first.title}.`);
  if (manual) { recordBaseline(io, receipt, skills, ready.bundle, opts.env); return manualSession(io, receipt, steps, leg, ready.bundle, reviewed && begin === 'straddle-go-live'); }
  const watch = page ? `Follow the checklist at ${page.url}` : client === 'claude' ? 'Its status line shows the checklist as it goes' : "I can't watch Cursor's progress; when it stops I read the files the skills wrote";
  io.say(`  ${label} opens here and runs ${run.length === 1 ? 'the step' : 'these steps'} in one session. ${watch}.`);
  io.say('  Answer its questions there, and approve or deny each change and each Sandbox request. Starting isn\'t approval of anything.');
  if (previous) io.say("  I'm reopening your earlier session, so I tell your agent that approvals from before don't count: every Sandbox write gets a fresh preview and question.");
  io.say(`  To stop, exit ${label} (${client === 'codex' ? 'Ctrl-C twice' : '/exit'}). Run \`wizard resume\` later and I'll reopen the session at the next unfinished step.`);
  const go = await io.choose('Next', [{ label: 'Start', value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
  io.say();
  if (!go) { page?.close(); return finish(receipt, 'ready', `stopped before ${first.title}`); }
  recordBaseline(io, receipt, skills, ready.bundle, opts.env);

  const runDir = join(repo, WIZARD_DIR, 'runs', receipt.runId);
  mkdirSync(runDir, { recursive: true });
  const eventsFile = eventsPath(repo);
  const settingsPath = join(runDir, `session-${receipt.sessions.length + 1}.settings.json`);
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const gate = [...new Set(leg.flatMap((s) => SKILLS[s].editGate))];
  const hook = [{ type: 'command', command: [process.execPath, HOOK_SCRIPT, '--events', eventsFile, '--repo', repo, '--gate', gate.join(',')].map(quote).join(' ') }];
  const statusCommand = [process.execPath, STATUSLINE_SCRIPT, '--repo', repo, '--steps', steps.map((s) => `${s.skill}:${s.total}`).join(','), '--start', begin, ...receipt.exclude.flatMap((e) => ['--exclude', e])];
  // The status line, progress hooks and the pre-plan edit hook; nothing else. Claude Code merges this file with the
  // developer's own settings and keeps their permissions, default mode and env, which the Wizard never sets.
  if (client === 'claude') writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: statusCommand.map(quote).join(' '), padding: 0 },
    hooks: {
      SessionStart: [{ hooks: hook }],
      SessionEnd: [{ hooks: hook }],
      Stop: [{ hooks: hook }],
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: hook }],
      // Every tool, so a turn's markers are swept after each call (MCP and Skill calls included).
      PostToolUse: [{ hooks: hook }],
    },
  }, null, 2));

  const session: SessionRun = { client, sessionId: null, skills: leg, startedAt: new Date().toISOString(), endedAt: null, exit: null, changedFiles: [], evidenceLimits: [], checklist: [] };
  const before = snapshot(repo, receipt.exclude);
  receipt.sessions.push(session);
  receipt.state = 'running';
  receipt.stateReason = `${stepTitles(leg)} running in ${label}`;
  saveReceipt(receipt);

  const follower = client === 'codex' ? followCodex(opts.env, repo, eventsFile, Date.now() - 1000, previous?.sessionId ?? null) : null;
  const chatsBefore = client === 'cursor' ? cursorTranscripts(opts.env, repo) : null;
  const command = launchCommand({ client, skill: begin, repo, context: programPrompt(leg, receipt, previous !== undefined), settingsPath, pluginDir: ready.bundle.path, resume: previous?.sessionId ?? null });
  const exit = await runInteractive(command, repo, sessionEnv(opts.env, bundledCli(), process.platform));
  const rollout = follower?.stop();
  page?.close();

  session.endedAt = new Date().toISOString();
  session.exit = { code: exit.code, signal: exit.signal };
  const events = readObservedEvents(eventsFile).events.filter((e) => e.at >= session.startedAt);
  const claudeSession = events.findLast((e) => e.kind === 'session-start' && e.session);
  const chat = chatsBefore ? cursorChat(opts.env, repo, previous?.sessionId ?? null, chatsBefore) : null;
  session.sessionId = rollout?.session ?? (claudeSession?.kind === 'session-start' ? claudeSession.session ?? null : chat?.id ?? null);
  const transcripts = chat?.transcript ? [chat.transcript] : [...new Set(events.flatMap((e) => (e.kind === 'session-start' && e.transcript ? [e.transcript] : [])))];
  session.checklist = verifyChecklist(rollout ? rollout.text.join('\n') : transcripts.map(transcriptAssistantText).join('\n'));
  const after = snapshot(repo, receipt.exclude);
  session.changedFiles = changedFiles(before, after);
  session.evidenceLimits = [...new Set([...before.limits, ...after.limits])];

  const atEnd = currentProgress(receipt, steps);
  const next = nextStep(atEnd.items);
  const ended = exit.error ? `${label} couldn't start: ${exit.error}` : exit.signal ? `${label} ended by signal ${exit.signal}` : `${label} exited with code ${exit.code}`;
  io.say(io.bold(`Session ended (${ended})`));
  for (const e of events) if (e.kind === 'edit-denied') io.say(`  Blocked an edit before the plan existed: ${e.path}`);
  let advanced = false;
  if (next === null) finish(receipt, 'completed', 'every step is done and on file');
  else if (exit.error) finish(receipt, 'blocked', ended);
  else if (exit.signal) interrupted(io, receipt, session, `${ended} during ${SKILLS[next].title}`);
  else if (exit.code !== 0) finish(receipt, 'blocked', `${ended} during ${SKILLS[next].title}; I don't advance past a failed session`);
  else if (!run.includes(next) && (sends > 0 || setupLeft)) finish(receipt, 'blocked', `configuration error: ${config.errors.join('; ')}`);
  else {
    const at = atEnd.items.find((p) => p.skill === next)!;
    const said = at.reported;
    if (said?.kind === 'abort') interrupted(io, receipt, session, `your agent reported STRADDLE_ABORT for ${SKILLS[next].title}: ${said.reason ?? 'no reason given'}`);
    else if (said?.kind === 'handoff' && !SKILLS[next].advanceOn.includes(said.status ?? '')) finish(receipt, 'blocked', `${SKILLS[next].title} stopped at ${said.status ?? 'no status'}${at.record ? `; ${SKILLS[next].record!.file}: ${at.record.detail}` : ''}`);
    else { finish(receipt, 'ready', `next: ${SKILLS[next].title}`); advanced = true; }
  }
  if (split && next === 'straddle-go-live' && advanced) {
    io.say();
    return runSession(io, receipt, steps, 'straddle-go-live', ready, opts);
  }
  io.say();
  if (skills.includes('straddle-audit')) showAuditFindings(io, receipt);
  const code = await printReport(io, receipt, atEnd, ready.bundle);
  if (opts.offerLog && events.length) {
    active.settled = code;
    await offerLog(io, repo);
  }
  return code;
}

function interrupted(io: Prompter, receipt: Receipt, session: SessionRun, reason: string): void {
  io.say(`  ${reason[0]!.toUpperCase()}${reason.slice(1)}.`);
  io.say(`  Nothing is rolled back. The work already done stays in place: ${session.changedFiles.length ? session.changedFiles.join(', ') : 'no file changes'}.`);
  io.say("  Run `wizard resume` and I'll reopen the session at the next unfinished step, telling your agent that approvals from before don't count.");
  finish(receipt, 'aborted', reason);
}

// cursor-agent keeps each chat at ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl, in Claude Code's
// transcript format; the slug is the workspace's real path with / and . as -. Chat id → transcript.
function cursorTranscripts(env: NodeJS.ProcessEnv, repo: string): Map<string, string> {
  const dir = join(env.HOME || homedir(), '.cursor', 'projects', realpathSync(repo).replace(/[/.]/g, '-').replace(/^-+/, ''), 'agent-transcripts');
  const found = new Map<string, string>();
  for (const id of existsSync(dir) ? readdirSync(dir) : []) {
    const transcript = join(dir, id, `${id}.jsonl`);
    if (SESSION_ID.test(id) && existsSync(transcript)) found.set(id, transcript);
  }
  return found;
}

// The chat this Wizard launched: the one it resumed, else the first chat created in this workspace after launch (not
// in `before`). Another Cursor chat in the same repo can still be writing its own transcript, so which file changed
// last says nothing.
function cursorChat(env: NodeJS.ProcessEnv, repo: string, resumed: string | null, before: ReadonlyMap<string, string>): { id: string; transcript: string | null } | null {
  const now = cursorTranscripts(env, repo);
  if (resumed) return { id: resumed, transcript: now.get(resumed) ?? null };
  let found: { id: string; transcript: string; at: number } | null = null;
  for (const [id, transcript] of now) {
    if (before.has(id)) continue;
    const at = statSync(transcript).birthtimeMs;
    if (!found || at < found.at) found = { id, transcript, at };
  }
  return found;
}

function handoffFor(receipt: Receipt, run: readonly SkillName[]): Handoff {
  const cli = bundledCli();
  return manualHandoff({ client: receipt.client!, skill: run[0]!, repo: receipt.repo, context: programPrompt(run, receipt, false), cliDir: cli.kind === 'bundled' ? cli.dir : null, platform: process.platform });
}

// Manual: the developer runs the program in their own agent and the files decide. I start no process.
async function manualSession(io: Prompter, receipt: Receipt, steps: Steps, run: readonly SkillName[], bundle: Bundle, afterReview = false): Promise<number> {
  const label = CLIENT_LABEL[receipt.client!];
  const { prompt, steps: todo } = handoffFor(receipt, run);
  io.say("  Manual: I start no agent. Here's the handoff:");
  if (afterReview) io.say(`  Paste it into your earlier ${label} session, the one that ran Test, not the review session.`);
  todo.slice(0, 2).forEach((s, i) => io.say(`    ${i + 1}. ${s}`));
  for (const line of prompt.split('\n')) io.say(`         ${line}`);
  todo.slice(2).forEach((s, i) => io.say(`    ${i + 3}. ${s}`));
  io.say(`  I can't see ${label}'s progress, so I show none. When you're back, I read the files the skills wrote.`);
  io.say();
  const back = await io.choose('Next', [{ label: "I'm back: read the files", value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
  io.say();
  receipt.sessions.push({ client: receipt.client!, sessionId: null, skills: [...run], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exit: null, changedFiles: [], evidenceLimits: ['I compared no files for a Manual session'], checklist: [] });
  if (!back) return finish(receipt, 'ready', `handed off to ${label} at ${SKILLS[run[0]!].title}`);
  const now = currentProgress(receipt, steps);
  const next = nextStep(now.items);
  finish(receipt, next ? 'ready' : 'completed', next ? `next: ${SKILLS[next].title}` : 'every step is done and on file');
  return printReport(io, receipt, now, bundle);
}

// ---------- Report ----------

function checklistFromBundle(bundle: Bundle, skill: SkillName): string[] {
  const dir = join(bundle.path, 'skills', skill, 'steps');
  for (const file of readdirSync(dir).sort().reverse()) {
    const items = verifyChecklist(readFileSync(join(dir, file), 'utf8'));
    if (items.length) return items;
  }
  return [];
}

// Where the test charge is in Straddle: its dashboard page when the test evidence names it, else the payments list.
function printInStraddle(io: Prompter, receipt: Receipt): void {
  const evidence = readRepoFile(receipt.repo, 'straddle-test-evidence.md', receipt.exclude);
  if (evidence.kind !== 'read') return;
  const charge = header(evidence.text, 'Test charge');
  io.say(io.bold('See it in Straddle'));
  if (charge && /^[A-Za-z0-9_-]{1,64}$/.test(charge) && charge !== 'none') {
    row(io, 'Test charge', `${DASHBOARD}/charges/${charge}`);
  } else {
    row(io, 'Payments', `${DASHBOARD}/payments`);
    io.say("  The test evidence names no charge, so here's your payments list instead.");
  }
  io.say("  Turn on Sandbox in the dashboard if it opens in Production: the link can't choose the environment for you.");
  io.say();
}

// You end the program after Test without Go Live. The choice goes in events.jsonl for the plan Test is complete at, so
// `wizard status`, the status line and resume show the program finished until that plan changes.
function finishWithoutGoLive(io: Prompter, receipt: Receipt, planHash: string): number {
  appendEvents(eventsPath(receipt.repo), [{ at: new Date().toISOString(), kind: 'go-live-skipped', planHash }]);
  io.say('Finished, without Go Live. `wizard status` and `wizard resume` now show the program as finished; if the plan changes, Go Live is back on the list. Run `wizard go-live` whenever you want the Production readiness review.');
  return finish(receipt, 'completed', 'you finished after Test and skipped Go Live');
}

const FINISH_HERE = 'Finish here (skip Go Live)';

// Where the skills record the Sandbox resources the agent created: the file, its section, and the column naming each
// row (skills straddle-integrate step 07-handoff and straddle-test step 06-evidence).
const RECORDED_IDS = [
  ['straddle-integration-report.md', 'Sandbox writes run', 'Operation', 'Created or reused'],
  ['straddle-test-evidence.md', 'Server-side resources', 'Resource', 'Created, reused, or observed'],
] as const;

// Straddle resource IDs are UUIDs. A row with any other ID cell (a key, a token, free text), or whose label isn't plain
// words, is counted and never printed. Only a known origin is shown.
const SANDBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_LABEL = /^[a-z][a-z ]{0,40}$/i;
const ORIGIN = /^(created|reused|observed)$/i;

// The test evidence keeps every run, latest first. Only the run `Latest run:` names counts (else the first run
// section; a file with no run sections is one run). When that run is missing, nothing counts: an older run's
// resources are never shown as the latest.
function latestRun(text: string): string {
  const lines = text.split('\n');
  const runs = lines.flatMap((l, i) => (l.startsWith('## Run ') ? [i] : []));
  if (!runs.length) return text;
  const latest = header(text, 'Latest run');
  const start = latest ? runs.find((i) => lines[i]!.slice('## Run '.length).split(',')[0]!.trim() === latest) : runs[0];
  if (start === undefined) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

// `synthetic`: the files whose run targeted an offline synthetic upstream (`Target: offline synthetic localhost ...`),
// whose records are nothing Straddle holds, so none of them is listed as a Sandbox ID.
function recordedSandboxIds(receipt: Receipt): { ids: string[]; leftOut: number; synthetic: string[] } {
  const ids: string[] = [];
  const synthetic: string[] = [];
  let leftOut = 0;
  for (const [file, heading, name, origin] of RECORDED_IDS) {
    const recorded = readRepoFile(receipt.repo, file, receipt.exclude);
    if (recorded.kind !== 'read') continue;
    const run = file === 'straddle-test-evidence.md' ? latestRun(recorded.text) : recorded.text;
    if (/offline synthetic/i.test(header(run, 'Target') ?? '')) { synthetic.push(file); continue; }
    for (const row of tableRows(section(run, heading))) {
      const id = row.ID ?? '';
      if (!id || /^(none|-|n\/a)$/i.test(id)) continue;
      if (!SANDBOX_ID.test(id) || !ROW_LABEL.test(row[name] ?? '')) { leftOut++; continue; }
      ids.push(`${file}: ${row[name]} ${id}${ORIGIN.test(row[origin] ?? '') ? ` (${row[origin]!.toLowerCase()})` : ''}`);
    }
  }
  return { ids, leftOut, synthetic };
}

async function printReport(io: Prompter, receipt: Receipt, now: Progress, bundle: Bundle | null): Promise<number> {
  const title = `Straddle Wizard report: ${receipt.program} program, ${receipt.state}`;
  const rows: [string, string][] = [
    ['Reason', receipt.stateReason],
    ['Repository', receipt.repo],
    ...receipt.client ? [['Agent', `${CLIENT_LABEL[receipt.client]}, plugin ${receipt.pluginLoad === 'session' ? 'loaded into the session with --plugin-dir (not installed)' : receipt.pluginLoad ?? 'not ready'}`] as [string, string]] : [],
    ...bundle ? [['Skill bundle', bundleLabel(bundle)] as [string, string]] : [],
    ['Run record', `${WIZARD_DIR}/receipt.json and ${WIZARD_DIR}/events.jsonl`],
    ...readObservedEvents(eventsPath(receipt.repo)).events.length ? [['Session log', 'wizard log'] as [string, string]] : [],
  ];
  const look = io.look;
  if (look) io.say(card(look, title, rows));
  else {
    io.say(io.bold(title));
    for (const [label, value] of rows) row(io, label, value);
  }
  io.say();
  io.say(io.bold('Steps'));
  const observed = observedRun(receipt);
  printSteps(io, now, observed);
  io.say(`  ${observed ? LEGEND : FILE_LEGEND}`);
  io.say();
  const changed = [...new Set(receipt.sessions.flatMap((s) => s.changedFiles))].sort();
  io.say(io.bold('Changed files (I compared them before and after each session)'));
  for (const file of changed.length ? changed : ['none']) io.say(`  ${file}`);
  for (const limit of new Set(receipt.sessions.flatMap((s) => s.evidenceLimits))) io.say(`  Not a complete list: ${limit}`);
  io.say();
  io.say(io.bold('Server-side resources'));
  const { ids, leftOut, synthetic } = recordedSandboxIds(receipt);
  if (ids.length) {
    io.say("  The Wizard created or enabled none. Your agent recorded these Sandbox IDs; I didn't verify them:");
    for (const id of ids) io.say(`    ${id}`);
  } else {
    io.say(`  The Wizard created or enabled none. Your agent recorded no Sandbox IDs in ${RECORDED_IDS.map(([file]) => file).join(' or ')}.`);
  }
  if (leftOut) io.say(`  I left out ${leftOut === 1 ? "1 row that doesn't" : `${leftOut} rows that don't`} look like a Sandbox resource record.`);
  for (const file of synthetic) io.say(`  ${file} records an offline synthetic target, so I list none of its records as Sandbox IDs.`);
  io.say(io.bold('Checks'));
  io.say('  I sent no Straddle request and ran no test. The checks your agent reports running are its own.');
  io.say();
  const printed = receipt.sessions.findLast((s) => s.checklist.length);
  // Else the skill's own checklist, for the last step this run's sessions covered that the files say finished, or
  // that has no file to say so (Audit, Get started): never a step that hasn't run.
  const ran = now.items.findLast((p) => (p.finished || p.record === null) && !p.skipped && receipt.sessions.some((s) => s.skills.includes(p.skill)))?.skill;
  if (printed) {
    io.say(io.bold('Verify before merging (as your agent last printed it)'));
    if (look) io.say(markdown({ ...look, width: look.width - 2 }, printed.checklist.join('\n')).replace(/^(?=.)/gm, '  '));
    else for (const item of printed.checklist) io.say(`  ${item}`);
    io.say();
  } else if (bundle && ran) {
    io.say(io.bold(`Verify before merging (from the ${ran} ${bundle.skills[ran]?.version ?? ''} skill; ${receipt.mode === 'manual' ? "I can't see what your agent printed" : "your agent didn't print it"})`));
    const items = checklistFromBundle(bundle, ran);
    if (look && items.length) io.say(markdown({ ...look, width: look.width - 2 }, items.join('\n')).replace(/^(?=.)/gm, '  '));
    else for (const item of items) io.say(`  ${item}`);
    io.say();
  }
  printInStraddle(io, receipt);
  const evidence = CONTRACT_FILES.filter((f) => existsSync(join(receipt.repo, f)));
  if (evidence.length) {
    io.say(io.bold('Evidence'));
    for (const f of evidence) io.say(`  ${f}`);
    io.say();
  }
  // In a terminal, each report the steps this run covered wrote (a plan has its own screen), rendered from its Markdown.
  // A pipe keeps the plain lines above.
  const shown = new Set<string>();
  if (look) {
    for (const skill of new Set(receipt.sessions.flatMap((s) => s.skills))) {
      const file = SKILLS[skill].report;
      const report = file ? readRepoFile(receipt.repo, file, receipt.exclude) : null;
      if (!file || report?.kind !== 'read') continue;
      shown.add(file);
      io.say(io.bold(`${SKILLS[skill].title} report (${file})`));
      io.say(markdown({ ...look, width: look.width - 2 }, report.text).replace(/^(?=.)/gm, '  '));
      io.say();
    }
  }
  const next = nextStep(now.items);
  const goLive = next === 'straddle-go-live' && !shown.has('straddle-go-live-report.md') ? readRepoFile(receipt.repo, 'straddle-go-live-report.md', receipt.exclude) : null;
  if (goLive?.kind === 'read') {
    io.say(io.bold('Go Live gaps (straddle-go-live-report.md)'));
    const gaps = section(goLive.text, 'Blocking gaps').filter((l) => l.trim().startsWith('|'));
    for (const line of gaps.length ? gaps : [`Status: ${header(goLive.text, 'Status') ?? 'not recorded'}`]) io.say(`  ${line.trim()}`);
    io.say();
  }
  // A file that says done while the agent's latest report for it doesn't agree, as when the client refused the rewrite.
  const contradicted = now.items.filter((p) => p.finished && !p.done && !p.skipped && p.reported);
  if (receipt.state === 'completed') {
    for (const p of contradicted) {
      const file = SKILLS[p.skill].record!.file;
      io.say(`${file} says done, but your agent reported ${p.reported!.kind === 'abort' ? 'STRADDLE_ABORT' : p.reported!.status ?? 'no status'}; check that ${file} was rewritten.`);
    }
    if (!contradicted.length) io.say(receipt.program !== 'integration' ? 'Next: review the changed files and the checklist before you merge.'
      : now.items.some((p) => p.skipped) ? "That's the program, finished without Go Live: your integration is built and tested in Sandbox. Review the changed files and the checklist before you merge, and run `wizard go-live` when you want the Production readiness review."
        : "That's the whole program: your integration is built, tested in Sandbox, and reviewed for Go Live. Review the changed files and the checklist before you merge.");
  } else {
    const where = next ? ` at ${SKILLS[next].title}` : '';
    const asksWrites = now.items.some((p) => !p.finished && SKILLS[p.skill].sendsStraddleRequests);
    const reopen = receipt.mode === 'manual' ? `I'll read the files and tell you what to paste${where}` : `I'll reopen the session${where}`;
    const nextLine = receipt.state === 'ready'
      ? `Next: run \`wizard resume\` and ${reopen}.`
      : `Next: fix what stopped the run (${receipt.stateReason}), then run \`wizard resume\` and ${reopen}.${asksWrites ? " Approvals from before don't count there, so every Sandbox write is asked again." : ''}`;
    const skippable = goLiveSkippable(now.items);
    if (skippable) {
      io.say("Test is done, and Go Live is the only step left. If you're not going to Production now, you can finish here.");
      const finishHere = await io.choose('Next', [{ label: 'Resume at Go Live later (run `wizard resume`)', value: false }, { label: FINISH_HERE, value: true }], 0);
      io.say();
      if (finishHere) return finishWithoutGoLive(io, receipt, skippable);
    }
    io.say(nextLine);
  }
  return EXIT_CODE[receipt.state];
}

// ---------- Entry points ----------

async function runProgram(io: Prompter, receipt: Receipt, opts: JourneyOptions, providers: readonly string[]): Promise<number> {
  active.receipt = receipt;
  const ready = await ensureReady(io, receipt, opts);
  if (typeof ready === 'number') {
    io.say('Fix that, then run `wizard resume` and I\'ll pick up from there.');
    return ready;
  }
  saveReceipt(receipt);
  const steps = stepCounts(ready.bundle, programSkills(receipt.program, providers));
  const now = currentProgress(receipt, steps);
  // A single-skill program always runs its skill; the integration program starts at its first unfinished step.
  const start = steps.length === 1 ? steps[0]!.skill : nextStep(now.items);
  if (!start) {
    finish(receipt, 'completed', 'every step is done and on file');
    return printReport(io, receipt, now, ready.bundle);
  }
  return runSession(io, receipt, steps, start, ready, opts);
}

function existingContractFiles(repo: string): string[] {
  return CONTRACT_FILES.filter((f) => existsSync(join(repo, f)));
}

function printSaved(io: Prompter, receipt: Receipt, now: Progress): void {
  io.say(io.bold(`Saved run: ${receipt.program} program, ${receipt.state}: ${receipt.stateReason}`));
  row(io, 'Updated', receipt.updatedAt);
  row(io, 'Agent', receipt.client ? CLIENT_LABEL[receipt.client] : 'not chosen');
  row(io, 'Mode', receipt.mode === 'manual' ? 'Manual (I tell you what to paste)' : receipt.mode === 'auto' ? 'Auto (I start your agent here)' : "not chosen yet; I'll ask");
  row(io, 'Language', answerText(receipt.context.language, []));
  row(io, 'Framework', answerText(receipt.context.framework, []));
  row(io, 'Choices', choicesText(receipt));
  if (receipt.exclude.length) row(io, 'Never opened', receipt.exclude.join(', '));
  printSteps(io, now, observedRun(receipt));
  io.say("  Sandbox write approvals from earlier sessions don't carry over. A recorded plan approval does, while the plan is unchanged.");
  io.say('  I recheck the skills, your agent and your files before we continue.');
  io.say();
}

function savedProgress(receipt: Receipt, providers: readonly string[]): Progress {
  return currentProgress(receipt, programSkills(receipt.program, providers).map((skill) => ({ skill, total: 0 })));
}

// The run's providers and bank connection as recorded when it started, so Migrate replacing Plaid Transfer calls
// doesn't drop Migrate from the run. A receipt saved before the Wizard recorded them started under the earlier rule,
// where a declared Plaid always added Migrate, so it keeps that program and gets only the bank connection from the
// repo now. Resume records them; status and Manual's next step read the same values without saving.
function withRunFacts(receipt: Receipt): Receipt {
  if (receipt.context.providers) return receipt;
  const facts = discover(receipt.repo, receipt.exclude);
  // A bank connection is detected only where Plaid is declared.
  const providers = facts.bankLink && !facts.providers.includes('plaid') ? [...facts.providers, 'plaid'].sort() : facts.providers;
  return { ...receipt, context: { ...receipt.context, providers, bankLink: facts.bankLink } };
}

async function resumeRun(io: Prompter, saved: Receipt, opts: JourneyOptions, confirm: boolean): Promise<number> {
  const receipt = withRunFacts(saved);
  const providers = receipt.context.providers!;
  const now = savedProgress(receipt, providers);
  const start = nextStep(now.items);
  if (confirm) {
    printSaved(io, receipt, now);
    if (!start) {
      if (!now.items.some((p) => p.skipped)) {
        io.say(`Everything in the saved ${receipt.program} run is done and on file. There's nothing to resume.`);
        return 0;
      }
      io.say(`You finished the saved ${receipt.program} run after Test and skipped Go Live, so there's nothing to resume. Run \`wizard go-live\` whenever you want the Production readiness review.`);
      const fresh = await io.choose('Next', [{ label: 'Leave it finished', value: false }, { label: 'Start fresh (I keep your current files beside the new ones)', value: true }], 0);
      io.say();
      return fresh ? newRun(receipt.program, opts, { kind: 'found', receipt }, true) : 0;
    }
    const skippable = goLiveSkippable(now.items);
    const go = await io.choose('Next', [
      { label: `Resume at ${SKILLS[start].title}`, value: 'resume' as const },
      ...(skippable ? [{ label: FINISH_HERE, value: 'finish' as const }] : []),
      { label: 'Cancel', value: 'cancel' as const },
    ], 0);
    io.say();
    if (go === 'finish') return finishWithoutGoLive(io, receipt, skippable!);
    if (go !== 'resume') { io.say('Cancelled. The saved run is unchanged.'); return 130; }
  }
  active.receipt = receipt;
  receipt.wizardPid = process.pid;
  // Choices the first run didn't finish are finished now, before any readiness check or agent session.
  if (programFor(receipt.program).asksChoices && !receipt.context.choices) {
    receipt.context.choices = await askChoices(io, receipt.context.language.value);
    if (!receipt.context.choices) return finish(receipt, 'aborted', 'you cancelled while choosing');
    saveReceipt(receipt);
  }
  if (opts.client && opts.client !== receipt.client) { receipt.client = opts.client; receipt.pluginLoad = null; }
  if (!receipt.client) {
    receipt.client = await chooseClient(io, opts.env);
    if (!receipt.client) return finish(receipt, 'aborted', 'you cancelled at agent choice');
  }
  // A run saved before the Wizard asked has no mode; `--mode` changes a saved one.
  receipt.mode = opts.mode ?? receipt.mode ?? await chooseMode(io, receipt.client, opts.env);
  if (!receipt.mode) return finish(receipt, 'aborted', 'you cancelled at the Auto or Manual choice');
  saveReceipt(receipt);
  return runProgram(io, receipt, opts, providers);
}

export async function resume(opts: JourneyOptions): Promise<number> {
  const { io, repo } = opts;
  const loaded = loadReceipt(repo);
  if (loaded.kind === 'found') {
    // Paths excluded now are added to the saved ones before anything is inspected; saved exclusions stay.
    loaded.receipt.exclude = [...new Set([...loaded.receipt.exclude, ...opts.exclude])];
    return resumeRun(io, loaded.receipt, opts, true);
  }
  if (loaded.kind === 'invalid') io.say(`I can't read the saved Wizard receipt (${loaded.reason}). I'm leaving it as it is at ${WIZARD_DIR}/receipt.json.`);
  // Without a receipt, the skills' files still say where the integration stands.
  if (!existingContractFiles(repo).length) {
    io.say(loaded.kind === 'none' ? "There's no saved Wizard run in this repo. Start one with `wizard`." : 'Start a new run with `wizard`; the unreadable file stays beside it.');
    return 1;
  }
  io.say("I'll pick up from the Straddle files in this repo. First, confirm the details.");
  io.say();
  return newRun('integration', opts, loaded, false);
}

export async function start(program: ProgramName, opts: JourneyOptions): Promise<number> {
  const { io, repo } = opts;
  const loaded = loadReceipt(repo);
  const files = program === 'integration' ? existingContractFiles(repo) : [];
  if (loaded.kind === 'found' || files.length) {
    let label: string | null;
    let skippable: string | null = null;
    if (loaded.kind === 'found') {
      const saved = loaded.receipt;
      saved.exclude = [...new Set([...saved.exclude, ...opts.exclude])];
      const now = savedProgress(saved, withRunFacts(saved).context.providers!);
      printSaved(io, saved, now);
      const at = nextStep(now.items);
      label = at ? `Resume the ${saved.program} run at ${SKILLS[at].title}` : null;
      skippable = goLiveSkippable(now.items);
    } else {
      const now = currentProgress({ ...newReceipt({ repo, program, pid: process.pid }), exclude: opts.exclude }, programSkills(program, discover(repo, opts.exclude).providers).map((skill) => ({ skill, total: 0 })));
      io.say(io.bold('This repo already has Straddle files from an earlier run'));
      printSteps(io, now, false);
      io.say();
      const at = nextStep(now.items);
      label = at ? `Resume at ${SKILLS[at].title}` : null;
    }
    const next = await io.choose('Start fresh or resume?', [
      ...(label ? [{ label, value: 'resume' as const }] : []),
      ...(skippable ? [{ label: FINISH_HERE, value: 'finish' as const }] : []),
      { label: 'Start fresh (I keep your current files beside the new ones)', value: 'fresh' as const },
      { label: 'Cancel', value: 'cancel' as const },
    ], 0);
    io.say();
    if (next === 'finish' && loaded.kind === 'found') return finishWithoutGoLive(io, loaded.receipt, skippable!);
    if (next === 'resume') return loaded.kind === 'found' ? resumeRun(io, loaded.receipt, opts, false) : newRun('integration', opts, loaded, false);
    if (next !== 'fresh') { io.say('Cancelled. Nothing changed.'); return 130; }
  }
  return newRun(program, opts, loaded, true);
}

// Renames each existing file to `<name>.<suffix>` beside it, and names the kept copies.
function keepAside(io: Prompter, dir: string, names: readonly string[], suffix: string): void {
  const kept = names.filter((n) => existsSync(join(dir, n)));
  for (const n of kept) renameSync(join(dir, n), join(dir, `${n}.${suffix}`));
  if (kept.length) io.say(`I kept the earlier ${kept.join(', ')} beside the new ones as ${kept.map((n) => `${n}.${suffix}`).join(', ')}.`);
}

// A new receipt after the context screen, choices and agent. `fresh` also sets the earlier run's files aside, once you've
// confirmed the new run by choosing an agent; a resume from files keeps them and starts at the first unfinished step.
async function newRun(program: ProgramName, opts: JourneyOptions, loaded: LoadedReceipt, fresh: boolean): Promise<number> {
  const { io, repo } = opts;
  // A new run over a saved one keeps its exclusions too; nothing here removes a protection the developer added.
  const exclude = loaded.kind === 'found' ? loaded.receipt.exclude : opts.exclude;
  const facts = discover(repo, exclude);
  const context: Receipt['context'] = {
    language: { value: facts.language.value, source: 'detected' },
    framework: { value: facts.framework.value, source: 'detected' },
    choices: null,
    providers: facts.providers,
    bankLink: facts.bankLink,
  };
  for (;;) {
    printWelcome(io, facts, context, program);
    const pick = await io.choose('Ready?', [
      { label: 'Continue', value: 'continue' as const },
      { label: 'Change detected context', value: 'change' as const },
      { label: 'Privacy and data', value: 'privacy' as const },
      { label: 'Cancel', value: 'cancel' as const },
    ], 0);
    io.say();
    if (pick === 'continue') break;
    if (pick === 'change') await correctContext(io, context);
    else if (pick === 'privacy') printPrivacy(io, facts);
    else { io.say("Cancelled. I haven't saved or changed anything."); return 130; }
  }

  // The saved receipt goes aside now, so the new run has a record of its own from here. The earlier run's files and
  // events stay in place until you've chosen an agent.
  const stamp = Date.now();
  const suffix = `${loaded.kind === 'found' ? loaded.receipt.state : loaded.kind === 'invalid' ? 'invalid' : 'previous'}-${stamp}`;
  if (loaded.kind !== 'none') keepAside(io, join(repo, WIZARD_DIR), ['receipt.json'], suffix);
  const receipt = newReceipt({ repo, program, pid: process.pid });
  receipt.context = context;
  receipt.exclude = exclude;
  saveReceipt(receipt);
  active.receipt = receipt;
  const cancel = (reason: string) => {
    io.say(fresh && program === 'integration' && existingContractFiles(repo).length ? 'Cancelled. Your earlier Straddle files stay where they were.' : 'Cancelled.');
    return finish(receipt, 'aborted', reason);
  };

  if (programFor(program).asksChoices) {
    const choices = await askChoices(io, context.language.value);
    if (!choices) return cancel('you cancelled while choosing');
    receipt.context.choices = choices;
    saveReceipt(receipt);
  }
  receipt.client = opts.client ?? await chooseClient(io, opts.env);
  if (!receipt.client) return cancel('you cancelled at agent choice');
  receipt.mode = opts.mode ?? await chooseMode(io, receipt.client, opts.env);
  if (!receipt.mode) return cancel('you cancelled at the Auto or Manual choice');
  if (fresh) {
    keepAside(io, join(repo, WIZARD_DIR), ['events.jsonl'], suffix);
    if (program === 'integration') keepAside(io, repo, CONTRACT_FILES, `previous-${stamp}`);
  }
  saveReceipt(receipt);
  return runProgram(io, receipt, opts, facts.providers);
}

// For `wizard status`: the saved program as the status line shows it, from the files and recorded events, and the
// steps you chose to finish without.
export function savedStatus(receipt: Receipt): { progress: string; skippedSteps: SkillName[] } {
  const now = savedProgress(receipt, withRunFacts(receipt).context.providers!);
  return { progress: `${statusLine(now.items)}${now.skipped ? ` (${skippedNote(now.skipped)})` : ''}`, skippedSteps: now.items.filter((p) => p.skipped).map((p) => p.skill) };
}

// For `wizard status` on a Manual run: what `wizard resume` would hand off next, from the files and `env`; null when
// nothing is left or the next session can't start.
export function savedHandoff(saved: Receipt, env: NodeJS.ProcessEnv): Handoff | null {
  if (saved.mode !== 'manual' || !saved.client) return null;
  const receipt = withRunFacts(saved);
  const now = savedProgress(receipt, receipt.context.providers!);
  const next = nextStep(now.items);
  if (!next) return null;
  const { sends, missing, runnable } = sessionSteps(receipt.repo, now.items, next, env);
  return sends === 0 || missing ? null : handoffFor(receipt, runnable);
}
