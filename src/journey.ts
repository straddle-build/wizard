import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_RELEASES, bundleLabel, downloadRelease, listReleases, loadCachedRelease, loadLocalBundle, pickRelease, releaseDir, type Bundle, type BundleCheck } from './bundle.ts';
import {
  CLIENT_LABEL, EVENT_SURFACE, EVENT_SURFACE_NOTE, displayCommand, inspectClient, installPlan, launchCommand, runCommands, updatePlan,
  type ClientName, type ClientState, type Command, type CommandResult, type ConfigPlan,
} from './clients.ts';
import { checklistPage, followCodex } from './codex.ts';
import { straddleConfiguration } from './configuration.ts';
import { changedFiles, discover, readRepoFile, snapshot, type RepoFacts } from './discovery.ts';
import { readObservedEvents, transcriptAssistantText, verifyChecklist } from './events.ts';
import { CONTRACT_FILES, SKILLS, programFor, programSkills, stepTitles, type ProgramName, type SkillName } from './programs.ts';
import { header, nextStep, progress, statusLine, type StepProgress } from './progress.ts';
import { WIZARD_DIR, loadReceipt, newReceipt, receiptPath, saveReceipt, type Answer, type Choices, type LoadedReceipt, type Receipt, type RunState, type SessionRun } from './receipt.ts';
import type { Prompter } from './ui.ts';
import { WIZARD_VERSION } from './version.ts';

export interface JourneyOptions {
  repo: string;
  env: NodeJS.ProcessEnv;
  io: Prompter;
  bundlePath: string | undefined;
  client: ClientName | undefined;
  exclude: string[];
}

const EXIT_CODE: Record<RunState, number> = { completed: 0, ready: 0, running: 1, blocked: 1, aborted: 130 };
const here = fileURLToPath(import.meta.url);
const HOOK_SCRIPT = join(dirname(here), `hook${extname(here)}`);
const STATUSLINE_SCRIPT = join(dirname(here), `statusline${extname(here)}`);
// The Straddle dashboard serves Sandbox and Production at one address; its Sandbox switch picks the environment.
const DASHBOARD = 'https://dashboard.straddle.com';

// The receipt a Ctrl-C at a Wizard prompt must mark as aborted. While an agent client runs, it owns Ctrl-C.
const active: { receipt: Receipt | null; clientRunning: boolean } = { receipt: null, clientRunning: false };

export function handleInterrupt(io: Prompter): void {
  if (active.clientRunning) return;
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

function choicesText(receipt: Receipt): string {
  const c = receipt.context.choices;
  if (c) return [c.products, c.integrationType, c.sdk, c.notificationPath].join(', ');
  return programFor(receipt.program).asksChoices ? "not answered yet; I'll ask before your agent starts" : 'not asked for this program';
}

const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Ruby', 'C#', 'Go', 'Other'] as const;
const SDK_FOR_LANGUAGE: Record<string, Choices['sdk']> = { TypeScript: 'TypeScript', JavaScript: 'TypeScript', Python: 'Python', Ruby: 'Ruby', 'C#': 'C#', Go: 'Go' };

// ---------- First screen ----------

function printWelcome(io: Prompter, facts: RepoFacts, context: Receipt['context'], program: ProgramName): void {
  const skills = programSkills(program, facts.providers);
  io.say(io.bold(`Straddle Wizard ${WIZARD_VERSION}`));
  io.say("I'll set up Straddle in this repo with your coding agent. Here's what I found; correct anything that's off.");
  io.say();
  row(io, 'Directory', facts.root);
  row(io, 'Language', answerText(context.language, facts.language.evidence));
  row(io, 'Framework', answerText(context.framework, facts.framework.evidence));
  row(io, 'Straddle SDK', facts.straddleSdk ? `${facts.straddleSdk.package} ${facts.straddleSdk.version} (declared in ${facts.straddleSdk.manifest})`.trim() : 'none declared');
  row(io, 'Provider code', facts.providers.length ? facts.providers.join(', ') : 'none in your manifests');
  row(io, 'Program', stepTitles(skills) + (skills.includes('straddle-migrate') && program === 'integration' ? ` (Migrate, because you already use ${facts.providers.join(', ')})` : ''));
  row(io, 'Purpose', programFor(program).purpose);
  if (facts.errors.length) {
    io.say();
    for (const err of facts.errors) io.say(`  Detection error: ${err}`);
  }
  io.say();
  io.say('  Your coding agent reads and edits this repo on your machine. I read dependency manifests and file names, and hash');
  io.say(`  other files locally so I can tell you what changed. I never open .env files, keys or credential files (${facts.excluded.length} skipped),`);
  io.say('  and I send nothing to Straddle.');
  io.say();
}

function printPrivacy(io: Prompter, facts: RepoFacts): void {
  io.say(io.bold('Privacy and data'));
  io.say('  I read package.json, pyproject.toml, requirements.txt, Pipfile, Gemfile, go.mod and *.csproj, and file names, in this repo only.');
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

async function chooseClient(io: Prompter, env: NodeJS.ProcessEnv): Promise<ClientName | null> {
  const options: Array<{ label: string; value: ClientName | null; hint?: string }> = [];
  for (const name of ['claude', 'codex'] as const) {
    const state = inspectClient(name, env);
    if (state.version) options.push({ label: `${state.label} ${state.version}`, value: name, hint: EVENT_SURFACE_NOTE[name] });
  }
  options.push({ label: 'Cursor', value: 'cursor', hint: EVENT_SURFACE_NOTE.cursor }, { label: 'Cancel', value: null });
  const picked = await io.choose('Which coding agent should do the work?', options, 0);
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
  row(io, 'Skill bundle', bundleLabel(bundle));
  row(io, 'Agent', client.version ? `${client.label} ${client.version}` : `${client.label}: not found`);
  if (client.loggedIn !== null) row(io, 'Agent login', client.loggedIn ? 'logged in' : 'not logged in');
  const installed = client.plugin.state === 'installed'
    ? `installed ${client.plugin.version ?? ''}, ${client.plugin.verified ? "matches the Wizard's bundle" : "differs from the Wizard's bundle"}`
    : client.plugin.state === 'missing' ? 'not installed' : "unverified (I can't inspect this client)";
  if (receipt.pluginLoad === 'session') {
    row(io, 'Straddle plugin', `loaded into the Wizard's session from that bundle with --plugin-dir (your Claude Code install: ${installed})`);
    row(io, 'API MCP', 'declared by that plugin; Claude Code sends STRADDLE_API_KEY from the environment it starts in');
    row(io, 'Session settings', "Isolated. Your user and project allow and deny rules, hooks, plugins, default mode and settings-based login (apiKeyHelper, env) don't apply. The session starts in Claude Code's default permission mode. Your organization's managed policy still applies and can allow edits, commands or MCP calls without asking. I don't read it.");
  } else {
    row(io, 'Straddle plugin', installed);
    row(io, 'API MCP', client.apiMcp);
    if (client.name === 'codex') row(io, 'Session settings', 'not isolated: the session runs with --sandbox workspace-write and --ask-for-approval on-request; the rest of your Codex configuration, hooks, MCP servers and plugins still apply');
  }
  row(io, 'Straddle key', config.key === 'present' ? "STRADDLE_API_KEY is set (I didn't read the value)" : 'STRADDLE_API_KEY is not set');
  row(io, 'Environment', config.environment);
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
  // Claude Code sessions always load exactly the Wizard's bundle; they ignore user settings, where an install is enabled.
  if (name === 'claude') receipt.pluginLoad = 'session';
  let repaired = false;
  for (;;) {
    const client = inspectClient(name, opts.env, bundle);
    printReadiness(io, receipt, bundle, client, opts.env);
    if (name === 'cursor') { receipt.pluginLoad = 'manual'; return { bundle, client }; }
    if (!client.version) {
      io.say(`${client.label} isn't installed or isn't on your PATH. Install it, or run \`wizard\` again and pick another agent.`);
      return finish(receipt, 'blocked', `${client.label} not found`);
    }
    if (client.loggedIn === false) {
      io.say(`${client.label} isn't logged in. Run \`${name === 'claude' ? 'claude auth login' : 'codex login'}\` in your terminal, then choose Recheck. I never handle your agent's credentials.`);
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

function currentProgress(receipt: Receipt, steps: Steps): StepProgress[] {
  return progress(receipt.repo, receipt.exclude, steps, readObservedEvents(eventsPath(receipt.repo)));
}

// One row per step: the tick, what its file says (read by the Wizard), what the agent reported, and what the client
// showed of the step files the agent opened.
function stepRows(items: readonly StepProgress[], observed: boolean): string[] {
  const width = Math.max(...items.map((p) => SKILLS[p.skill].title.length)) + 2;
  return items.map((p) => {
    const route = SKILLS[p.skill];
    const file = p.record ? `${route.record}: ${p.record.detail}` : 'writes no status file';
    const said = !p.reported ? 'no handoff reported'
      : p.reported.kind === 'abort' ? `reported STRADDLE_ABORT${p.reported.reason ? ` (${p.reported.reason})` : ''}`
        : `reported ${p.reported.status ?? 'a handoff with no status'}`;
    const seen = observed ? `${p.total ? `${p.entered} of ${p.total}` : p.entered} step files opened` : 'progress not observable';
    return `${p.done ? '✓' : p.entered ? '▶' : ' '} ${route.title.padEnd(width)}${[file, said, seen].join(' · ')}`;
  });
}

const LEGEND = "✓ means the file and your agent's handoff agree. I read each file myself; a handoff is what your agent reported.";

// ---------- Session ----------

function section(textContent: string, heading: string): string[] {
  const lines = textContent.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim());
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

function showAuditFindings(io: Prompter, receipt: Receipt): void {
  const report = readRepoFile(receipt.repo, 'straddle-audit-report.md', receipt.exclude);
  if (report.kind === 'absent') { io.say("  straddle-audit-report.md wasn't written."); return; }
  if (report.kind === 'skipped') { io.say(`  straddle-audit-report.md isn't shown: I don't open it because ${report.reason}.`); return; }
  io.say(io.bold('Findings (straddle-audit-report.md)'));
  const table = section(report.text, 'Findings').filter((l) => l.trim().startsWith('|'));
  for (const line of table.length ? table : ['(no findings table in the report)']) io.say(`  ${line.trim()}`);
  io.say();
}

// Everything the developer confirmed in the Wizard, with where each value came from. Skill instructions stay in the skill.
function contextForAgent(receipt: Receipt): string {
  const { language, framework, choices: c } = receipt.context;
  const origin = (a: Answer) => (a.source === 'developer' ? 'corrected by the developer' : 'detected');
  const context = `Repository context confirmed in the Straddle Wizard: language ${language.value} (${origin(language)}); framework ${framework.value} (${origin(framework)}).`;
  if (!c) return context;
  const decided = ([['products', c.products], ['integration type', c.integrationType], ['SDK', c.sdk], ['notification path', c.notificationPath]] as const)
    .map(([k, v]) => `${k} ${v}`);
  return `${context} Developer choices from the Straddle Wizard: ${decided.join('; ')}.`;
}

// The skills recognize `Straddle Wizard program:` and walk the listed steps in this one session.
function programPrompt(run: readonly SkillName[], receipt: Receipt): string {
  return `Straddle Wizard program: ${run.join(' → ')}. Start at ${run[0]}. Run the steps in order in this one session: after each step's STRADDLE_HANDOFF, `
    + 'continue with the next unfinished step without waiting for the Wizard; stop and ask whenever a step needs the developer (plan approval, each Sandbox write). '
    + contextForAgent(receipt);
}

// The exact configuration errors, what can still run, and how to fix them.
function printConfigurationError(io: Prompter, errors: string[], env: NodeJS.ProcessEnv, canRun: readonly SkillName[], stopsAt: SkillName): void {
  io.say(`Configuration error: ${errors.join('; ')}.`);
  const titles = canRun.map((s) => SKILLS[s].title);
  if (titles.length) io.say(`  ${titles.join(' and ')} send no Straddle request, so they can run now. I'll end the session before ${SKILLS[stopsAt].title}.`);
  io.say(`  ${SKILLS[stopsAt].title} can send Straddle requests, and the skill refuses every one until this is fixed, so ${titles.length ? 'it won\'t start' : 'I won\'t start it'}: zero Straddle requests are sent.`);
  io.say(`  ${SKILLS[stopsAt].title} won't start until you fix this in your own shell and run \`wizard resume\`:`);
  io.say('    export STRADDLE_API_KEY=<your Sandbox key>    # type it in your shell, never into the Wizard');
  io.say('    export STRADDLE_ENVIRONMENT=sandbox');
  if (env.STRADDLE_BASE_URL) io.say('    unset STRADDLE_BASE_URL                       # or set it to https://sandbox.straddle.com');
  io.say("  I check only these shell variables, not a saved Straddle CLI login.");
  io.say();
}

interface ClientExit { code: number | null; signal: string | null; error: string | null }

function runInteractive(command: Command, cwd: string, env: NodeJS.ProcessEnv): Promise<ClientExit> {
  const { promise, resolve } = Promise.withResolvers<ClientExit>();
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  active.clientRunning = true;
  const child = spawn(command.bin, command.args, { cwd, env, stdio: 'inherit' });
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

// One agent session for the rest of the program: from `start` to the last step, or to the step before the first one
// that can send Straddle requests when the configuration isn't ready.
async function runSession(io: Prompter, receipt: Receipt, steps: Steps, start: SkillName, ready: Ready, opts: JourneyOptions): Promise<number> {
  const { repo } = receipt;
  const client = receipt.client!;
  const label = CLIENT_LABEL[client];
  const skills = steps.map((s) => s.skill);
  let run = skills.slice(skills.indexOf(start));
  const first = SKILLS[start];

  if (first.requiresAnyOf.length && !first.requiresAnyOf.some((f) => existsSync(join(repo, f)))) {
    io.say(`${first.title} needs ${first.requiresAnyOf.join(' or ')}. Run \`wizard plan\` first: no code changes happen before there's a plan.`);
    return finish(receipt, 'blocked', `${first.title} needs ${first.requiresAnyOf.join(' or ')}`);
  }
  if (start === 'straddle-integrate' || start === 'straddle-test') showPlan(io, receipt, start);

  const config = straddleConfiguration(opts.env);
  const sends = config.errors.length ? run.findIndex((s) => SKILLS[s].sendsStraddleRequests) : -1;
  if (sends >= 0) {
    printConfigurationError(io, config.errors, opts.env, run.slice(0, sends), run[sends]!);
    if (sends === 0) return finish(receipt, 'blocked', `configuration error: ${config.errors.join('; ')}`);
    run = run.slice(0, sends);
  }

  const previous = receipt.sessions.findLast((s) => s.client === client && s.sessionId);
  const done = skills.slice(0, skills.indexOf(start)).map((s) => SKILLS[s].title);
  const render = () => {
    const items = currentProgress(receipt, steps);
    return [`Straddle Wizard: ${stepTitles(skills)} in Codex`, '', statusLine(items), '', ...stepRows(items, true), '', LEGEND].join('\n');
  };
  const page = client === 'codex' ? await checklistPage(render) : null;
  io.say(io.bold(`Your session in ${label}: ${stepTitles(run)}`));
  if (done.length) io.say(`  ${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} done; I read that from ${done.length === 1 ? 'its file' : 'their files'}. I'll start at ${first.title}.`);
  if (client === 'cursor') return manualHandoff(io, receipt, steps, run);
  io.say(`  ${label} opens here and runs ${run.length === 1 ? 'the step' : 'these steps'} in one session. ${page ? `Follow the checklist at ${page.url}` : 'Its status line shows the checklist as it goes'}.`);
  io.say('  Answer its questions there, and approve or deny each change and each Sandbox request. Starting isn\'t approval of anything.');
  io.say(`  To stop, exit ${label} (${client === 'claude' ? '/exit' : 'Ctrl-C twice'}). Run \`wizard resume\` later and I'll ${previous ? 'reopen your session' : 'reopen the session'} at the next unfinished step.`);
  const go = await io.choose('Next', [{ label: 'Start', value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
  io.say();
  if (!go) { page?.close(); return finish(receipt, 'ready', `stopped before ${first.title}`); }

  const runDir = join(repo, WIZARD_DIR, 'runs', receipt.runId);
  mkdirSync(runDir, { recursive: true });
  const eventsFile = eventsPath(repo);
  const settingsPath = join(runDir, `session-${receipt.sessions.length + 1}.settings.json`);
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const gate = [...new Set(run.flatMap((s) => SKILLS[s].editGate))];
  const hook = [{ type: 'command', command: [process.execPath, HOOK_SCRIPT, '--events', eventsFile, '--repo', repo, '--gate', gate.join(',')].map(quote).join(' ') }];
  const statusCommand = [process.execPath, STATUSLINE_SCRIPT, '--repo', repo, '--steps', steps.map((s) => `${s.skill}:${s.total}`).join(','), ...receipt.exclude.flatMap((e) => ['--exclude', e])];
  // Flag settings override the developer's user settings, so an auto or accept-edits default mode never approves
  // the session's tool calls. Managed policy still wins, as it should, and can allow them without a prompt.
  writeFileSync(settingsPath, JSON.stringify({
    permissions: { defaultMode: 'default' },
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

  const session: SessionRun = { client, sessionId: null, skills: run, startedAt: new Date().toISOString(), endedAt: null, exit: null, changedFiles: [], evidenceLimits: [], checklist: [] };
  const before = snapshot(repo, receipt.exclude);
  receipt.sessions.push(session);
  receipt.state = 'running';
  receipt.stateReason = `${stepTitles(run)} running in ${label}`;
  saveReceipt(receipt);

  const follower = client === 'codex' ? followCodex(opts.env, repo, eventsFile, Date.now() - 1000, previous?.sessionId ?? null) : null;
  const command = launchCommand({ client, skill: run[0]!, repo, context: programPrompt(run, receipt), settingsPath, pluginDir: ready.bundle.path, resume: previous?.sessionId ?? null });
  const exit = await runInteractive(command, repo, opts.env);
  const rollout = follower?.stop();
  page?.close();

  session.endedAt = new Date().toISOString();
  session.exit = { code: exit.code, signal: exit.signal };
  const events = readObservedEvents(eventsFile).filter((e) => e.at >= session.startedAt);
  const claudeSession = events.findLast((e) => e.kind === 'session-start' && e.session);
  session.sessionId = rollout?.session ?? (claudeSession?.kind === 'session-start' ? claudeSession.session ?? null : null);
  const transcripts = [...new Set(events.flatMap((e) => (e.kind === 'session-start' && e.transcript ? [e.transcript] : [])))];
  session.checklist = verifyChecklist(rollout ? rollout.text.join('\n') : transcripts.map(transcriptAssistantText).join('\n'));
  const after = snapshot(repo, receipt.exclude);
  session.changedFiles = changedFiles(before, after);
  session.evidenceLimits = [...new Set([...before.limits, ...after.limits])];

  const items = currentProgress(receipt, steps);
  const next = nextStep(items);
  const ended = exit.error ? `${label} couldn't start: ${exit.error}` : exit.signal ? `${label} ended by signal ${exit.signal}` : `${label} exited with code ${exit.code}`;
  io.say(io.bold(`Session ended (${ended})`));
  for (const e of events) if (e.kind === 'edit-denied') io.say(`  Blocked an edit before the plan existed: ${e.path}`);
  if (next === null) finish(receipt, 'completed', 'every step is done and on file');
  else if (exit.error) finish(receipt, 'blocked', ended);
  else if (exit.signal) interrupted(io, receipt, session, `${ended} during ${SKILLS[next].title}`);
  else if (exit.code !== 0) finish(receipt, 'blocked', `${ended} during ${SKILLS[next].title}; I don't advance past a failed session`);
  else if (!run.includes(next) && sends > 0) finish(receipt, 'blocked', `configuration error: ${config.errors.join('; ')}`);
  else {
    const said = items.find((p) => p.skill === next)!.reported;
    if (said?.kind === 'abort') interrupted(io, receipt, session, `your agent reported STRADDLE_ABORT for ${SKILLS[next].title}: ${said.reason ?? 'no reason given'}`);
    else if (said?.kind === 'handoff' && !SKILLS[next].advanceOn.includes(said.status ?? '')) finish(receipt, 'blocked', `${SKILLS[next].title} reported ${said.status ?? 'no status'}`);
    else finish(receipt, 'ready', `next: ${SKILLS[next].title}`);
  }
  io.say();
  if (skills.includes('straddle-audit')) showAuditFindings(io, receipt);
  return printReport(io, receipt, items, ready.bundle);
}

function interrupted(io: Prompter, receipt: Receipt, session: SessionRun, reason: string): void {
  io.say(`  ${reason[0]!.toUpperCase()}${reason.slice(1)}.`);
  io.say(`  Nothing is rolled back. The work already done stays in place: ${session.changedFiles.length ? session.changedFiles.join(', ') : 'no file changes'}.`);
  io.say("  Run `wizard resume` and I'll reopen the session at the next unfinished step. Sandbox write approvals are asked again.");
  finish(receipt, 'aborted', reason);
}

// Cursor has no session the Wizard can start or watch, so the developer runs the program there and the files decide.
async function manualHandoff(io: Prompter, receipt: Receipt, steps: Steps, run: readonly SkillName[]): Promise<number> {
  io.say("  I can't drive Cursor, so here's the handoff:");
  io.say(`    1. Open ${receipt.repo} in Cursor with the Straddle plugin installed from its team marketplace.`);
  io.say(`    2. Ask the Cursor agent: "Use the ${run[0]} skill. ${programPrompt(run, receipt)}"`);
  io.say('    3. Answer its questions and approvals in Cursor, then come back here.');
  io.say("  I can't see Cursor's progress, so I show none. When you're back, I read the files the skills wrote.");
  io.say();
  const back = await io.choose('Next', [{ label: "I'm back: read the files", value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
  io.say();
  receipt.sessions.push({ client: 'cursor', sessionId: null, skills: [...run], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exit: null, changedFiles: [], evidenceLimits: ['I compared no files for a Cursor session'], checklist: [] });
  if (!back) return finish(receipt, 'ready', `handed off to Cursor at ${SKILLS[run[0]!].title}`);
  const items = currentProgress(receipt, steps);
  const next = nextStep(items);
  finish(receipt, next ? 'ready' : 'completed', next ? `next: ${SKILLS[next].title}` : 'every step is done and on file');
  return printReport(io, receipt, items, null);
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

function printReport(io: Prompter, receipt: Receipt, items: readonly StepProgress[], bundle: Bundle | null): number {
  io.say(io.bold(`Straddle Wizard report: ${receipt.program} program, ${receipt.state}`));
  row(io, 'Reason', receipt.stateReason);
  row(io, 'Repository', receipt.repo);
  if (receipt.client) row(io, 'Agent', `${CLIENT_LABEL[receipt.client]}, plugin ${receipt.pluginLoad === 'session' ? 'loaded into the session with --plugin-dir (not installed)' : receipt.pluginLoad ?? 'not ready'}`);
  if (bundle) row(io, 'Skill bundle', bundleLabel(bundle));
  row(io, 'Run record', `${WIZARD_DIR}/receipt.json and ${WIZARD_DIR}/events.jsonl`);
  io.say();
  io.say(io.bold('Steps'));
  for (const line of stepRows(items, receipt.client !== null && EVENT_SURFACE[receipt.client] === 'observed')) io.say(`  ${line}`);
  io.say(`  ${LEGEND}`);
  io.say();
  const changed = [...new Set(receipt.sessions.flatMap((s) => s.changedFiles))].sort();
  io.say(io.bold('Changed files (I compared them before and after each session)'));
  for (const file of changed.length ? changed : ['none']) io.say(`  ${file}`);
  for (const limit of new Set(receipt.sessions.flatMap((s) => s.evidenceLimits))) io.say(`  Not a complete list: ${limit}`);
  io.say();
  io.say(io.bold('Server-side resources'));
  io.say("  I created or enabled none. What your agent reports creating is in its handoffs and evidence files; I didn't verify it.");
  io.say(io.bold('Checks'));
  io.say('  I sent no Straddle request and ran no test. The checks your agent reports running are its own.');
  io.say();
  const printed = receipt.sessions.findLast((s) => s.checklist.length);
  if (printed) {
    io.say(io.bold('Verify before merging (as your agent last printed it)'));
    for (const item of printed.checklist) io.say(`  ${item}`);
    io.say();
  } else if (bundle && receipt.sessions.length) {
    const skill = receipt.sessions.at(-1)!.skills.at(-1)!;
    io.say(io.bold(`Verify before merging (from the ${skill} ${bundle.skills[skill]?.version ?? ''} skill; your agent didn't print it)`));
    for (const item of checklistFromBundle(bundle, skill)) io.say(`  ${item}`);
    io.say();
  }
  printInStraddle(io, receipt);
  const evidence = CONTRACT_FILES.filter((f) => existsSync(join(receipt.repo, f)));
  if (evidence.length) {
    io.say(io.bold('Evidence'));
    for (const f of evidence) io.say(`  ${f}`);
    io.say();
  }
  const next = nextStep(items);
  const goLive = next === 'straddle-go-live' ? readRepoFile(receipt.repo, 'straddle-go-live-report.md', receipt.exclude) : null;
  if (goLive?.kind === 'read') {
    io.say(io.bold('Go Live gaps (straddle-go-live-report.md)'));
    const gaps = section(goLive.text, 'Blocking gaps').filter((l) => l.trim().startsWith('|'));
    for (const line of gaps.length ? gaps : [`Status: ${header(goLive.text, 'Status') ?? 'not recorded'}`]) io.say(`  ${line.trim()}`);
    io.say();
  }
  if (receipt.state === 'completed') {
    io.say(receipt.program === 'integration'
      ? "That's the whole program: your integration is built, tested in Sandbox, and reviewed for Go Live. Review the changed files and the checklist before you merge."
      : 'Next: review the changed files and the checklist before you merge.');
  } else {
    const where = next ? ` at ${SKILLS[next].title}` : '';
    io.say(receipt.state === 'ready'
      ? `Next: run \`wizard resume\` and I'll reopen the session${where}.`
      : `Next: fix what stopped the run (${receipt.stateReason}), then run \`wizard resume\` and I'll reopen the session${where}. Sandbox write approvals are asked again.`);
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
  const items = currentProgress(receipt, steps);
  // A single-skill program always runs its skill; the integration program starts at its first unfinished step.
  const start = steps.length === 1 ? steps[0]!.skill : nextStep(items);
  if (!start) {
    finish(receipt, 'completed', 'every step is done and on file');
    return printReport(io, receipt, items, ready.bundle);
  }
  return runSession(io, receipt, steps, start, ready, opts);
}

function existingContractFiles(repo: string): string[] {
  return CONTRACT_FILES.filter((f) => existsSync(join(repo, f)));
}

function printSaved(io: Prompter, receipt: Receipt, items: readonly StepProgress[]): void {
  io.say(io.bold(`Saved run: ${receipt.program} program, ${receipt.state}: ${receipt.stateReason}`));
  row(io, 'Updated', receipt.updatedAt);
  row(io, 'Agent', receipt.client ? CLIENT_LABEL[receipt.client] : 'not chosen');
  row(io, 'Language', answerText(receipt.context.language, []));
  row(io, 'Framework', answerText(receipt.context.framework, []));
  row(io, 'Choices', choicesText(receipt));
  if (receipt.exclude.length) row(io, 'Never opened', receipt.exclude.join(', '));
  for (const line of stepRows(items, receipt.client !== null && EVENT_SURFACE[receipt.client] === 'observed')) io.say(`  ${line}`);
  io.say("  Sandbox write approvals from earlier sessions don't carry over. A recorded plan approval does, while the plan is unchanged.");
  io.say('  I recheck the skills, your agent and your files before we continue.');
  io.say();
}

function savedProgress(receipt: Receipt, providers: readonly string[]): StepProgress[] {
  return currentProgress(receipt, programSkills(receipt.program, providers).map((skill) => ({ skill, total: 0 })));
}

async function resumeRun(io: Prompter, receipt: Receipt, opts: JourneyOptions, confirm: boolean): Promise<number> {
  const providers = discover(receipt.repo, receipt.exclude).providers;
  const items = savedProgress(receipt, providers);
  const start = nextStep(items);
  if (confirm) {
    printSaved(io, receipt, items);
    if (!start) {
      io.say(`Everything in the saved ${receipt.program} run is done and on file. There's nothing to resume.`);
      return 0;
    }
    const go = await io.choose('Next', [{ label: `Resume at ${SKILLS[start].title}`, value: true }, { label: 'Cancel', value: false }], 0);
    io.say();
    if (!go) { io.say('Cancelled. The saved run is unchanged.'); return 130; }
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
    if (loaded.kind === 'found') {
      const saved = loaded.receipt;
      saved.exclude = [...new Set([...saved.exclude, ...opts.exclude])];
      const providers = discover(repo, saved.exclude).providers;
      const items = savedProgress(saved, providers);
      printSaved(io, saved, items);
      const at = nextStep(items);
      label = at ? `Resume the ${saved.program} run at ${SKILLS[at].title}` : null;
    } else {
      const items = currentProgress({ ...newReceipt({ repo, program, pid: process.pid }), exclude: opts.exclude }, programSkills(program, discover(repo, opts.exclude).providers).map((skill) => ({ skill, total: 0 })));
      io.say(io.bold('This repo already has Straddle files from an earlier run'));
      for (const line of stepRows(items, false)) io.say(`  ${line}`);
      io.say();
      const at = nextStep(items);
      label = at ? `Resume at ${SKILLS[at].title}` : null;
    }
    const next = await io.choose('Start fresh or resume?', [
      ...(label ? [{ label, value: 'resume' as const }] : []),
      { label: 'Start fresh (I keep your current files beside the new ones)', value: 'fresh' as const },
      { label: 'Cancel', value: 'cancel' as const },
    ], 0);
    io.say();
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

// A new receipt after the context screen, choices and agent. `fresh` also sets the earlier run's files aside; a
// resume from files keeps them and starts at the first unfinished step.
async function newRun(program: ProgramName, opts: JourneyOptions, loaded: LoadedReceipt, fresh: boolean): Promise<number> {
  const { io, repo } = opts;
  // A new run over a saved one keeps its exclusions too; nothing here removes a protection the developer added.
  const exclude = loaded.kind === 'found' ? loaded.receipt.exclude : opts.exclude;
  const facts = discover(repo, exclude);
  const context: Receipt['context'] = {
    language: { value: facts.language.value, source: 'detected' },
    framework: { value: facts.framework.value, source: 'detected' },
    choices: null,
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

  const stamp = Date.now();
  if (loaded.kind !== 'none') {
    const state = loaded.kind === 'found' ? loaded.receipt.state : 'invalid';
    keepAside(io, join(repo, WIZARD_DIR), ['receipt.json', ...(fresh ? ['events.jsonl'] : [])], `${state}-${stamp}`);
  } else if (fresh) {
    keepAside(io, join(repo, WIZARD_DIR), ['events.jsonl'], `previous-${stamp}`);
  }
  if (fresh && program === 'integration') keepAside(io, repo, CONTRACT_FILES, `previous-${stamp}`);
  const receipt = newReceipt({ repo, program, pid: process.pid });
  receipt.context = context;
  receipt.exclude = exclude;
  saveReceipt(receipt);
  active.receipt = receipt;

  if (programFor(program).asksChoices) {
    const choices = await askChoices(io, context.language.value);
    if (!choices) { io.say('Cancelled.'); return finish(receipt, 'aborted', 'you cancelled while choosing'); }
    receipt.context.choices = choices;
    saveReceipt(receipt);
  }
  receipt.client = opts.client ?? await chooseClient(io, opts.env);
  if (!receipt.client) { io.say('Cancelled.'); return finish(receipt, 'aborted', 'you cancelled at agent choice'); }
  saveReceipt(receipt);
  return runProgram(io, receipt, opts, facts.providers);
}

// For `wizard status`: the saved program as the status line shows it, from the files and recorded events.
export function savedStatusLine(receipt: Receipt): string {
  return statusLine(savedProgress(receipt, discover(receipt.repo, receipt.exclude).providers));
}
