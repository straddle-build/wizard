import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_BUNDLE, bundleLabel, fetchCommands, loadBundle, snapshotDir, type Bundle, type BundleCheck } from './bundle.ts';
import {
  CLIENT_LABEL, EVENT_SURFACE, EVENT_SURFACE_NOTE, claudeMarketplacePath, displayCommand, inspectClient, installPlan, launchCommand, runCommands, updatePlan,
  type ClientName, type ClientState, type Command, type CommandResult, type ConfigPlan,
} from './clients.ts';
import { straddleConfiguration } from './configuration.ts';
import { changedFiles, discover, readRepoFile, snapshot, type RepoFacts } from './discovery.ts';
import { parseMarkers, readObservedEvents, stepEntries, transcriptAssistantText, verifyChecklist, type ReportedMarker } from './events.ts';
import { INTEGRATION_PLAN, SKILLS, programFor, programLabel, type ProgramName, type SkillName } from './programs.ts';
import { WIZARD_DIR, loadReceipt, newReceipt, receiptPath, saveReceipt, type Answer, type Choices, type Receipt, type RunState, type StepRun } from './receipt.ts';
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
const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), `hook${extname(fileURLToPath(import.meta.url))}`);

// The receipt a Ctrl-C at a Wizard prompt must mark as aborted. While an agent client runs, it owns Ctrl-C.
const active: { receipt: Receipt | null; clientRunning: boolean } = { receipt: null, clientRunning: false };

export function handleInterrupt(io: Prompter): void {
  if (active.clientRunning) return;
  if (active.receipt) {
    finish(active.receipt, 'aborted', 'developer cancelled at a Wizard prompt');
    io.say('\nCancelled. Work already done stays in place; resume with `wizard resume`.');
  } else {
    io.say('\nCancelled. Nothing was saved or changed.');
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
  return programFor(receipt.program).asksChoices ? 'not answered yet; asked again before the agent starts' : 'not asked for this program';
}

const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Ruby', 'C#', 'Go', 'Other'] as const;
const SDK_FOR_LANGUAGE: Record<string, Choices['sdk']> = { TypeScript: 'TypeScript', JavaScript: 'TypeScript', Python: 'Python', Ruby: 'Ruby', 'C#': 'C#', Go: 'Go' };

// ---------- First screen ----------

function printWelcome(io: Prompter, facts: RepoFacts, context: Receipt['context'], program: ProgramName): void {
  io.say(io.bold(`Straddle Wizard ${WIZARD_VERSION}`));
  io.say();
  row(io, 'Directory', facts.root);
  row(io, 'Language', answerText(context.language, facts.language.evidence));
  row(io, 'Framework', answerText(context.framework, facts.framework.evidence));
  row(io, 'Straddle SDK', facts.straddleSdk ? `${facts.straddleSdk.package} ${facts.straddleSdk.version} (declared in ${facts.straddleSdk.manifest})`.trim() : 'none declared');
  row(io, 'Provider code', facts.providers.length ? facts.providers.join(', ') : 'none found in manifests');
  row(io, 'Program', `${program}: ${programLabel(program)}`);
  row(io, 'Purpose', programFor(program).purpose);
  if (facts.errors.length) {
    io.say();
    for (const err of facts.errors) io.say(`  Detection error: ${err}`);
  }
  io.say();
  io.say('  Your coding agent reads and edits this repository on your machine. The Wizard reads dependency manifests and');
  io.say('  file names, and hashes other files locally to report which ones changed. It never opens .env files, keys or');
  io.say(`  credential files (${facts.excluded.length} skipped), and sends nothing to Straddle.`);
  io.say();
}

function printPrivacy(io: Prompter, facts: RepoFacts): void {
  io.say(io.bold('Privacy and data'));
  io.say('  The Wizard reads package.json, pyproject.toml, requirements.txt, Pipfile, Gemfile, go.mod and *.csproj, and file names, in this repository only.');
  io.say('  It hashes other non-sensitive files locally so it can tell you which files changed. Nothing leaves this machine.');
  const skipped = facts.excluded.slice(0, 20).map((e) => `${e.path} (${e.reason})`);
  if (facts.excluded.length > 20) skipped.push(`and ${facts.excluded.length - 20} more`);
  io.say(`  Skipped without opening: ${skipped.length ? skipped.join(', ') : 'nothing sensitive found'}`);
  if (facts.truncated) io.say('  Discovery stopped at its file limit; the rest of the repository was not inspected.');
  io.say('  The Wizard sends nothing to Straddle and hosts no model. Your coding agent reads and edits the repository under its own');
  io.say('  settings and sends content to its own model provider. Straddle requests happen only in the agent, with your approval.');
  io.say(`  Run state is kept in ${WIZARD_DIR}/receipt.json (git-ignored). It never contains your API key.`);
  io.say();
}

async function correctContext(io: Prompter, context: Receipt['context']): Promise<void> {
  const which = await io.choose('Which detail is wrong?', [
    { label: 'Language', value: 'language' as const },
    { label: 'Framework', value: 'framework' as const },
    { label: 'Back', value: 'back' as const },
  ]);
  if (which === 'language') {
    const language = await io.choose('Language', LANGUAGES.map((l) => ({ label: l, value: l })));
    if (language) context.language = { value: language, source: 'developer' };
  } else if (which === 'framework') {
    const framework = await io.ask(`Framework (blank keeps ${context.framework.value}): `);
    if (framework) context.framework = { value: framework, source: 'developer' };
  }
  io.say();
}

async function askChoices(io: Prompter, language: string): Promise<Choices | null> {
  const notDecided = { label: 'Not decided yet (the agent will ask)', value: 'not decided' as const };
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

export interface BundleRequest { override: string | undefined; remembered?: string | null | undefined; env: NodeJS.ProcessEnv }

const SNAPSHOT = `merged-source snapshot ${PINNED_BUNDLE.repository}@${PINNED_BUNDLE.commit.slice(0, 7)} (plugin ${PINNED_BUNDLE.pluginVersion}; not a tagged release)`;

// The developer's --bundle first, then a verified copy already on this machine: the last one this run used,
// Claude Code's "straddle" marketplace, or the Wizard's own snapshot. Never fetches.
export function findBundle(req: BundleRequest): BundleCheck {
  if (req.override) return loadBundle(req.override);
  for (const path of [req.remembered, claudeMarketplacePath(req.env), snapshotDir(req.env)]) {
    if (!path) continue;
    const check = loadBundle(path);
    if (check.ok) return check;
  }
  return { ok: false, reason: `The Straddle skills are not on this machine yet. \`wizard\` or \`wizard install\` fetches the ${SNAPSHOT}.` };
}

// Like findBundle, then offers to fetch the pinned snapshot. Resolves null when the developer cancels.
export async function prepareBundle(io: Prompter, req: BundleRequest, yes: boolean): Promise<BundleCheck | null> {
  const found = findBundle(req);
  if (found.ok || req.override) return found;
  const dir = snapshotDir(req.env);
  const staging = `${dir}.partial`;
  const commands = fetchCommands(staging);
  io.say(io.bold('Straddle skills'));
  io.say(`  Not on this machine yet. The Wizard fetches the ${SNAPSHOT}`);
  io.say(`  from GitHub into ${dir}, checks its content, and changes nothing else:`);
  for (const command of commands) io.say(`    ${displayCommand(command)}`);
  if (!yes) {
    const go = await io.choose('Fetch the Straddle skills?', [{ label: 'Fetch', value: true }, { label: 'Cancel', value: false }], 0);
    io.say();
    if (!go) return null;
  }
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  const fetched = printCommandResults(io, runCommands(commands, req.env));
  io.say();
  const check: BundleCheck = fetched ? loadBundle(staging) : { ok: false, reason: `fetching the ${SNAPSHOT} failed` };
  if (!check.ok) { rmSync(staging, { recursive: true, force: true }); return check; }
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return loadBundle(dir);
}

export function printPlan(say: (line: string) => void, plan: ConfigPlan): void {
  if (plan.kind === 'nothing') { say(plan.note); return; }
  if (plan.kind === 'manual') { for (const step of plan.steps) say(`  ${step}`); return; }
  for (const command of plan.commands) say(`    ${displayCommand(command)}`);
  say(`  ${plan.note}`);
}

function printReadiness(io: Prompter, receipt: Receipt, bundle: Bundle, client: ClientState, env: NodeJS.ProcessEnv): void {
  const config = straddleConfiguration(env);
  io.say(io.bold(`Readiness for ${client.label}`));
  row(io, 'Skill bundle', `${bundleLabel(bundle)}, verified`);
  row(io, 'Agent', client.version ? `${client.label} ${client.version}` : `${client.label}: not found`);
  if (client.loggedIn !== null) row(io, 'Agent login', client.loggedIn ? 'logged in' : 'not logged in');
  const installed = client.plugin.state === 'installed'
    ? `installed ${client.plugin.version ?? ''}, ${client.plugin.verified ? 'matches the verified snapshot' : 'differs from the verified snapshot'}`
    : client.plugin.state === 'missing' ? 'not installed' : 'unverified (the Wizard cannot inspect this client)';
  if (receipt.pluginLoad === 'session') {
    row(io, 'Straddle plugin', `loaded into each Wizard session from the verified snapshot with --plugin-dir (your Claude Code: ${installed})`);
    row(io, 'API MCP', 'declared by that plugin; Claude Code sends STRADDLE_API_KEY from the environment it starts in');
    row(io, 'Session settings', 'isolated: your user and project allow and deny rules, hooks, plugins, default mode and settings-based login (apiKeyHelper, env) do not apply; Claude Code asks before edits, commands and MCP calls');
  } else {
    row(io, 'Straddle plugin', installed);
    row(io, 'API MCP', client.apiMcp);
    if (client.name === 'codex') row(io, 'Session settings', 'not isolated: each session sets --sandbox workspace-write and --ask-for-approval on-request; your other Codex configuration, hooks, MCP servers and plugins still apply');
  }
  row(io, 'Straddle key', config.key === 'present' ? 'STRADDLE_API_KEY is set (value not read)' : 'STRADDLE_API_KEY is not set');
  row(io, 'Environment', config.environment);
  io.say();
}

function printCredentialHelp(io: Prompter, receipt: Receipt, env: NodeJS.ProcessEnv): void {
  const config = straddleConfiguration(env);
  if (!config.errors.length) return;
  const remaining = programFor(receipt.program).skills.filter((s) => !advanced(receipt, s));
  const titles = (requests: boolean) => remaining.filter((s) => SKILLS[s].sendsStraddleRequests === requests).map((s) => SKILLS[s].title).join(', ');
  io.say(`Configuration error for Straddle requests: ${config.errors.join('; ')}.`);
  if (titles(false)) io.say(`  ${titles(false)} can run: the Wizard does not block steps that send no Straddle request.`);
  io.say(`  ${titles(true) || 'Integrate and Test'} will not start until you fix this in your own shell and run \`wizard resume\`.`);
  io.say('  The Wizard checks only these shell variables, not a saved Straddle CLI login:');
  io.say('    export STRADDLE_API_KEY=<your Sandbox key>    # type it in your shell, never into the Wizard');
  io.say('    export STRADDLE_ENVIRONMENT=sandbox');
  if (env.STRADDLE_BASE_URL) io.say('    unset STRADDLE_BASE_URL                       # or set it to https://sandbox.straddle.com');
  io.say();
}

async function ensureReady(io: Prompter, receipt: Receipt, opts: JourneyOptions): Promise<{ bundle: Bundle; client: ClientState } | number> {
  const check = await prepareBundle(io, { override: opts.bundlePath, remembered: receipt.bundle?.path, env: opts.env }, false);
  if (!check) return finish(receipt, 'aborted', 'developer cancelled the Straddle skills fetch');
  if (!check.ok) {
    io.say(`Skill bundle: ${check.reason}`);
    return finish(receipt, 'blocked', `skill bundle: ${check.reason}`);
  }
  const bundle = check.bundle;
  receipt.bundle = { kind: bundle.kind, repository: bundle.repository, commit: bundle.commit, pluginVersion: bundle.pluginVersion, path: bundle.path };
  const name = receipt.client!;
  // Claude Code sessions always load exactly the verified bundle; they ignore user settings, where an install is enabled.
  if (name === 'claude') receipt.pluginLoad = 'session';
  let repaired = false;
  for (;;) {
    const client = inspectClient(name, opts.env);
    printReadiness(io, receipt, bundle, client, opts.env);
    if (name === 'cursor') { receipt.pluginLoad = 'manual'; return { bundle, client }; }
    if (!client.version) {
      io.say(`${client.label} is not installed or not on PATH. Install it, or run \`wizard\` again and choose another agent.`);
      return finish(receipt, 'blocked', `${client.label} not found`);
    }
    if (client.loggedIn === false) {
      io.say(`${client.label} is not logged in. Run \`${name === 'claude' ? 'claude auth login' : 'codex login'}\` in your terminal, then choose Recheck. The Wizard never handles your agent's credentials.`);
      const next = await io.choose('Next', [{ label: 'Recheck', value: 'recheck' as const }, { label: 'Stop here (resume later with `wizard resume`)', value: 'stop' as const }]);
      if (next === 'recheck') continue;
      return finish(receipt, 'blocked', `${client.label} is not logged in`);
    }
    if (receipt.pluginLoad === 'session') return { bundle, client };
    // Codex loads its own installed copy, so that copy, not just its version, must be the verified snapshot.
    if (client.plugin.verified) {
      receipt.pluginLoad = 'installed';
      return { bundle, client };
    }
    if (repaired) {
      io.say(`The Straddle plugin ${client.label} would load still differs from the verified snapshot after the repair.`);
      return finish(receipt, 'blocked', `the Straddle plugin in ${client.label} differs from the verified snapshot`);
    }

    const outdated = client.plugin.state === 'installed';
    const plan = outdated ? updatePlan(client, bundle) : installPlan(client, bundle);
    io.say(outdated ? `The Straddle plugin ${client.label} would load (${client.plugin.version ?? 'unknown version'}) differs from the verified snapshot.` : `The Straddle plugin is not installed in ${client.label}.`);
    type Repair = 'apply' | 'manual' | 'cancel';
    const options: Array<{ label: string; value: Repair }> = [];
    if (plan.kind === 'commands') options.push({ label: outdated ? 'Update it with these commands' : 'Install it with these commands', value: 'apply' });
    options.push({ label: 'Show manual steps and stop', value: 'manual' }, { label: 'Cancel', value: 'cancel' });
    printPlan((line) => io.say(line), plan);
    const repair = await io.choose('How should the Wizard get the plugin?', options, 0);
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
    return finish(receipt, 'aborted', 'developer cancelled at readiness');
  }
}

// ---------- Steps ----------

function section(textContent: string, heading: string): string[] {
  const lines = textContent.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim());
}

function showPlan(io: Prompter, receipt: Receipt): void {
  const plan = readRepoFile(receipt.repo, INTEGRATION_PLAN, receipt.exclude);
  if (plan.kind === 'absent') return;
  if (plan.kind === 'skipped') {
    io.say(io.bold(`Plan: ${INTEGRATION_PLAN}`));
    io.say(`  Not shown: the Wizard does not open it because ${plan.reason}. Review it in your coding agent.`);
    io.say();
    return;
  }
  const state = /Plan state:\s*([^\n]+)/.exec(plan.text)?.[1]?.trim() ?? 'not recorded';
  io.say(io.bold(`Plan: ${INTEGRATION_PLAN} (Plan state: ${state})`));
  if (receipt.planSha256 && receipt.planSha256 !== plan.sha256) io.say('  The plan changed after the Plan step. Integrate reviews the current file.');
  for (const heading of ['File changes', 'Future Sandbox writes']) {
    io.say(`  ${heading}`);
    const lines = section(plan.text, heading);
    for (const line of lines.length ? lines : ['(section not found)']) io.say(`    ${line}`);
  }
  io.say('  Approve or change the plan in your coding agent. Integrate asks for approval of the current plan, and every');
  io.say('  Sandbox write gets its own preview and approval there. Nothing here counts as approval.');
  io.say();
}

function showAuditFindings(io: Prompter, receipt: Receipt): void {
  const report = readRepoFile(receipt.repo, 'straddle-audit-report.md', receipt.exclude);
  if (report.kind === 'absent') { io.say('  straddle-audit-report.md was not written.'); return; }
  if (report.kind === 'skipped') { io.say(`  straddle-audit-report.md is not shown: the Wizard does not open it because ${report.reason}.`); return; }
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

async function developerReported(io: Prompter, skill: SkillName, where: string): Promise<ReportedMarker[]> {
  const statuses = [...SKILLS[skill].advanceOn, 'blocked'];
  const picked = await io.choose(`${where} does not expose events the Wizard reads. What did ${skill} report at its handoff?`, [
    ...statuses.map((s) => ({ label: s, value: s })),
    { label: 'It stopped before the handoff, or has not run yet', value: null },
  ]);
  return picked ? [{ kind: 'handoff', skill, status: picked, report: `reported by the developer; ${where} progress was not observed by the Wizard` }] : [];
}

type StepOutcome = 'advance' | number;

async function runStep(io: Prompter, receipt: Receipt, skill: SkillName, index: number, total: number, ctx: { bundle: Bundle; client: ClientState; opts: JourneyOptions }): Promise<StepOutcome> {
  const route = SKILLS[skill];
  const { repo } = receipt;
  const label = CLIENT_LABEL[receipt.client!];

  if (route.requiresAnyOf.length && !route.requiresAnyOf.some((f) => existsSync(join(repo, f)))) {
    io.say(`${route.title} needs ${route.requiresAnyOf.join(' or ')}. Run \`wizard plan\` first; no code edit happens before the plan exists.`);
    return finish(receipt, 'blocked', `${route.title} needs ${route.requiresAnyOf.join(' or ')}`);
  }
  if (skill === 'straddle-integrate') showPlan(io, receipt);

  const config = straddleConfiguration(ctx.opts.env);
  if (route.sendsStraddleRequests && config.errors.length) {
    io.say(`Configuration error: ${config.errors.join('; ')}.`);
    io.say(`  ${route.title} can send Straddle requests. The skill refuses every one of them until this is fixed, so zero Straddle requests`);
    io.say('  are sent. Set the values in your own shell and run `wizard resume`.');
    return finish(receipt, 'blocked', `configuration error: ${config.errors.join('; ')}`);
  }

  const version = ctx.bundle.skills[skill]?.version ?? 'unknown';
  io.say(io.bold(`Step ${index} of ${total}: ${route.title} (${skill} ${version}) in ${label}`));
  if (receipt.client === 'cursor') return manualHandoff(io, receipt, skill, version);
  io.say(`  ${label} opens in this terminal and runs the skill. Answer its questions and approve or deny its actions there.`);
  io.say('  Choosing Start is not approval of any code change or Straddle request.');
  io.say(`  When the skill prints its handoff, exit ${label} (${receipt.client === 'claude' ? '/exit' : 'Ctrl-C twice'}) to come back here.`);
  const start = await io.choose('Next', [{ label: 'Start', value: true }, { label: 'Stop here (resume later with `wizard resume`)', value: false }], 0);
  io.say();
  if (!start) return finish(receipt, 'ready', `stopped before ${route.title}`);

  const runDir = join(repo, WIZARD_DIR, 'runs', receipt.runId);
  mkdirSync(runDir, { recursive: true });
  const n = receipt.steps.length + 1;
  const eventsFile = join(runDir, `${n}-${skill}.events.jsonl`);
  const settingsPath = join(runDir, `${n}-${skill}.settings.json`);
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const hookCommand = [process.execPath, HOOK_SCRIPT, '--events', eventsFile, '--repo', repo, '--gate', route.editGate.join(',')].map(quote).join(' ');
  const hook = [{ type: 'command', command: hookCommand }];
  // Flag settings override the developer's user settings, so an auto or accept-edits default mode never approves
  // a step's tool calls: each one is asked in the client. Managed policy still wins, as it should.
  writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: 'default' }, hooks: {
    SessionStart: [{ hooks: hook }],
    SessionEnd: [{ hooks: hook }],
    Stop: [{ hooks: hook }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: hook }],
    PostToolUse: [{ matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit', hooks: hook }],
  } }, null, 2));

  const step: StepRun = {
    skill, skillVersion: version, startedAt: new Date().toISOString(), endedAt: null, exit: null,
    eventSurface: EVENT_SURFACE[receipt.client!], observedSteps: [], observedEvents: [], reportedMarkers: [], changedFiles: [], evidenceLimits: [], checklist: [], advanced: false,
  };
  const before = snapshot(repo, receipt.exclude);
  receipt.steps.push(step);
  receipt.state = 'running';
  receipt.stateReason = `${route.title} running in ${label}`;
  saveReceipt(receipt);

  const command = launchCommand({ client: receipt.client as 'claude' | 'codex', skill, repo, context: contextForAgent(receipt), settingsPath, pluginDir: ctx.bundle.path });
  const exit = await runInteractive(command, repo, ctx.opts.env);

  step.endedAt = new Date().toISOString();
  step.exit = { code: exit.code, signal: exit.signal };
  step.observedEvents = readObservedEvents(eventsFile);
  step.observedSteps = stepEntries(step.observedEvents, skill);
  const transcripts = step.observedEvents.flatMap((e) => (e.kind === 'session-start' && e.transcript ? [e.transcript] : []));
  const output = [...new Set(transcripts)].map(transcriptAssistantText).join('\n');
  step.reportedMarkers = receipt.client === 'codex' && !exit.error ? await developerReported(io, skill, 'Codex') : parseMarkers(output).filter((m) => m.skill === skill);
  step.checklist = verifyChecklist(output);
  const after = snapshot(repo, receipt.exclude);
  step.changedFiles = changedFiles(before, after);
  step.evidenceLimits = [...new Set([...before.limits, ...after.limits])];
  if (skill === 'straddle-plan') {
    const plan = readRepoFile(repo, INTEGRATION_PLAN, receipt.exclude);
    receipt.planSha256 = plan.kind === 'read' ? plan.sha256 : null;
  }

  const handoff = step.reportedMarkers.findLast((m) => m.kind === 'handoff');
  const abort = step.reportedMarkers.findLast((m) => m.kind === 'abort');
  const signal = exit.signal;
  const ended = exit.error ? `${label} could not start: ${exit.error}` : signal ? `${label} ended by signal ${signal}` : `${label} exited with code ${exit.code}`;
  io.say(io.bold(`${route.title} ended (${ended})`));
  if (step.eventSurface === 'observed') {
    io.say(`  Observed (${label} hooks): ${step.observedSteps.length ? `entered ${step.observedSteps.join(', ')}` : 'no step file read observed'}`);
  } else {
    io.say(`  Observed: the ${label} process started and ended. Step progress is unverified for ${label}.`);
  }
  for (const e of step.observedEvents) if (e.kind === 'edit-denied') io.say(`  Blocked edit before the plan existed: ${e.path}`);
  const reporter = receipt.client === 'codex' ? 'the developer' : 'the agent';
  io.say(`  Reported by ${reporter} (not verified by the Wizard): ${handoff ? `handoff ${handoff.status}${handoff.report ? `: ${handoff.report}` : ''}` : 'no handoff'}`);
  if (abort) io.say(`  Reported abort: ${abort.reason ?? 'no reason given'}`);
  io.say(`  Files changed: ${step.changedFiles.length ? step.changedFiles.join(', ') : 'none'}`);
  for (const limit of step.evidenceLimits) io.say(`  Changed-file check incomplete: ${limit}`);
  io.say();
  if (skill === 'straddle-audit') showAuditFindings(io, receipt);

  // The Wizard's own evidence of a failed or stopped session wins over any handoff the model printed.
  if (exit.error) return finish(receipt, 'blocked', ended);
  if (abort) return interrupted(io, receipt, step, `the agent reported STRADDLE_ABORT: ${abort.reason ?? 'no reason'}`);
  if (signal) return interrupted(io, receipt, step, handoff ? `${ended} after a reported handoff; the Wizard does not advance past an interrupted session` : `${ended} before the skill's handoff`);
  if (exit.code !== 0) return finish(receipt, 'blocked', `${ended}; the Wizard does not advance past a failed session`);
  if (handoff?.status && (route.advanceOn as readonly string[]).includes(handoff.status)) {
    step.advanced = true;
    return 'advance';
  }
  if (handoff) return finish(receipt, 'blocked', `${route.title} reported ${handoff.status ?? 'no status'}`);
  return finish(receipt, 'blocked', `${ended} before the skill printed its handoff; the step may be incomplete`);
}

function interrupted(io: Prompter, receipt: Receipt, step: StepRun, reason: string): number {
  io.say(`${reason[0]!.toUpperCase()}${reason.slice(1)}.`);
  io.say(`  Nothing is rolled back. Work already done stays in place: ${step.changedFiles.length ? step.changedFiles.join(', ') : 'no file changes'}.`);
  io.say('  Resume with `wizard resume`: the step starts in a fresh session and its approvals are asked again.');
  io.say();
  return finish(receipt, 'aborted', reason);
}

async function manualHandoff(io: Prompter, receipt: Receipt, skill: SkillName, version: string): Promise<StepOutcome> {
  const step: StepRun = {
    skill, skillVersion: version, startedAt: new Date().toISOString(), endedAt: null, exit: null,
    eventSurface: 'unsupported', observedSteps: [], observedEvents: [], reportedMarkers: [], changedFiles: [],
    evidenceLimits: ['the Wizard does not observe Cursor and compared no files for this step'], checklist: [], advanced: false,
  };
  receipt.steps.push(step);
  io.say('  Cursor automation is not supported by the Wizard. Manual handoff:');
  io.say(`    1. Open ${receipt.repo} in Cursor with the Straddle plugin installed from its team marketplace.`);
  io.say(`    2. Ask the Cursor agent: "Use the ${skill} skill. ${contextForAgent(receipt)}"`.trimEnd());
  io.say('    3. Answer its questions and approvals in Cursor, then come back here.');
  io.say('  The Wizard does not observe Cursor, so it shows no progress for this step.');
  io.say();
  step.reportedMarkers = await developerReported(io, skill, 'Cursor');
  step.endedAt = new Date().toISOString();
  const handoff = step.reportedMarkers.at(-1);
  if (handoff?.status && (SKILLS[skill].advanceOn as readonly string[]).includes(handoff.status)) {
    step.advanced = true;
    return 'advance';
  }
  return finish(receipt, 'blocked', handoff ? `${SKILLS[skill].title} reported ${handoff.status} in Cursor` : `manual handoff to Cursor for ${SKILLS[skill].title}; run \`wizard resume\` when it has run`);
}

// ---------- Report ----------

function latestRun(receipt: Receipt, skill: SkillName): StepRun | undefined {
  return receipt.steps.findLast((s) => s.skill === skill);
}

// Read from the decision runStep saved, so a resumed run never skips a step whose session failed or was aborted.
function advanced(receipt: Receipt, skill: SkillName): boolean {
  return latestRun(receipt, skill)?.advanced === true;
}

function checklistFromBundle(bundle: Bundle, skill: SkillName): string[] {
  const dir = join(bundle.path, 'skills', skill, 'steps');
  for (const file of readdirSync(dir).sort().reverse()) {
    const items = verifyChecklist(readFileSync(join(dir, file), 'utf8'));
    if (items.length) return items;
  }
  return [];
}

function printReport(io: Prompter, receipt: Receipt, bundle: Bundle | null): number {
  const program = programFor(receipt.program);
  io.say(io.bold(`Straddle Wizard report: ${receipt.program} program ${receipt.state}`));
  row(io, 'Reason', receipt.stateReason);
  row(io, 'Repository', receipt.repo);
  if (receipt.client) row(io, 'Agent', `${CLIENT_LABEL[receipt.client]}, plugin ${receipt.pluginLoad === 'session' ? 'loaded per session with --plugin-dir (package-loaded, not installed)' : receipt.pluginLoad ?? 'not ready'}`);
  if (bundle) row(io, 'Skill bundle', bundleLabel(bundle));
  row(io, 'Receipt', `${WIZARD_DIR}/receipt.json`);
  io.say();
  io.say(io.bold('Steps'));
  for (const skill of program.skills) {
    const run = latestRun(receipt, skill);
    const handoff = run?.reportedMarkers.findLast((m) => m.kind === 'handoff');
    const observed = !run ? 'not started' : run.eventSurface === 'observed' ? `observed ${run.observedSteps.length} step entries` : `progress ${run.eventSurface}`;
    io.say(`  ${SKILLS[skill].title.padEnd(12)}${observed}; reported: ${handoff?.status ?? 'no handoff'}`);
  }
  io.say();
  const changed = [...new Set(receipt.steps.flatMap((s) => s.changedFiles))].sort();
  io.say(io.bold('Changed files (observed by the Wizard)'));
  for (const file of changed.length ? changed : ['none']) io.say(`  ${file}`);
  for (const limit of new Set(receipt.steps.flatMap((s) => s.evidenceLimits))) io.say(`  Not a complete list: ${limit}`);
  io.say();
  io.say(io.bold('Server-side resources'));
  io.say('  The Wizard created or enabled none. Resources the agent reports creating are in its handoff reports and evidence files;');
  io.say('  the Wizard did not verify them.');
  io.say(io.bold('Checks'));
  io.say('  The Wizard sent no Straddle request and ran no test. Checks the agent reports running are reported, not verified.');
  io.say();
  const last = receipt.steps.findLast((s) => s.checklist.length);
  if (last) {
    io.say(io.bold(`Verify before merging (printed by the agent for ${last.skill})`));
    for (const item of last.checklist) io.say(`  ${item}`);
  } else if (bundle && receipt.steps.length) {
    const skill = receipt.steps.at(-1)!.skill;
    io.say(io.bold(`Verify before merging (from the ${skill} ${bundle.skills[skill]?.version ?? ''} skill; the agent did not print it)`));
    for (const item of checklistFromBundle(bundle, skill)) io.say(`  ${item}`);
  }
  io.say();
  const next = receipt.state === 'completed'
    ? 'Review the changed files and the checklist above before merging.'
    : receipt.state === 'aborted' || receipt.state === 'blocked' ? 'Fix what stopped the run, then `wizard resume`. Approvals are asked again in a fresh session.'
      : 'Continue with `wizard resume`.';
  io.say(`Next: ${next}`);
  return EXIT_CODE[receipt.state];
}

// ---------- Entry points ----------

async function runProgram(io: Prompter, receipt: Receipt, opts: JourneyOptions): Promise<number> {
  active.receipt = receipt;
  const ready = await ensureReady(io, receipt, opts);
  if (typeof ready === 'number') return printReport(io, receipt, null);
  if (receipt.client !== 'cursor' && straddleConfiguration(opts.env).errors.length) printCredentialHelp(io, receipt, opts.env);
  saveReceipt(receipt);

  const skills = programFor(receipt.program).skills;
  for (const [i, skill] of skills.entries()) {
    if (advanced(receipt, skill)) continue;
    const outcome = await runStep(io, receipt, skill, i + 1, skills.length, { bundle: ready.bundle, client: ready.client, opts });
    if (outcome !== 'advance') return printReport(io, receipt, ready.bundle);
    saveReceipt(receipt);
  }
  finish(receipt, 'completed', `all ${skills.length} steps reached their handoff`);
  return printReport(io, receipt, ready.bundle);
}

function printSaved(io: Prompter, receipt: Receipt): void {
  io.say(io.bold(`Saved run: ${receipt.program} program, ${receipt.state}: ${receipt.stateReason}`));
  row(io, 'Updated', receipt.updatedAt);
  row(io, 'Agent', receipt.client ? CLIENT_LABEL[receipt.client] : 'not chosen');
  row(io, 'Language', answerText(receipt.context.language, []));
  row(io, 'Framework', answerText(receipt.context.framework, []));
  row(io, 'Choices', choicesText(receipt));
  if (receipt.exclude.length) row(io, 'Never opened', receipt.exclude.join(', '));
  for (const skill of programFor(receipt.program).skills) {
    row(io, SKILLS[skill].title, advanced(receipt, skill) ? `handoff ${latestRun(receipt, skill)?.reportedMarkers.findLast((m) => m.kind === 'handoff')?.status}` : latestRun(receipt, skill) ? 'incomplete' : 'not started');
  }
  io.say('  Approvals from earlier sessions do not carry over; the agent asks again in a fresh session.');
  io.say('  The Wizard rechecks the bundle, your agent and the plan before continuing.');
  io.say();
}

function nextTitle(receipt: Receipt): string {
  const skill = programFor(receipt.program).skills.find((s) => !advanced(receipt, s));
  return skill ? SKILLS[skill].title : 'the end';
}

async function resumeRun(io: Prompter, receipt: Receipt, opts: JourneyOptions, confirm: boolean): Promise<number> {
  if (confirm) {
    printSaved(io, receipt);
    const go = await io.choose('Next', [{ label: `Resume from ${nextTitle(receipt)}`, value: true }, { label: 'Cancel', value: false }], 0);
    io.say();
    if (!go) { io.say('Cancelled. The saved run is unchanged.'); return 130; }
  }
  active.receipt = receipt;
  receipt.wizardPid = process.pid;
  // Setup the first run did not finish is finished now, before any readiness check or agent session.
  if (programFor(receipt.program).asksChoices && !receipt.context.choices) {
    receipt.context.choices = await askChoices(io, receipt.context.language.value);
    if (!receipt.context.choices) return finish(receipt, 'aborted', 'developer cancelled while choosing');
    saveReceipt(receipt);
  }
  if (opts.client && opts.client !== receipt.client) { receipt.client = opts.client; receipt.pluginLoad = null; }
  if (!receipt.client) {
    receipt.client = await chooseClient(io, opts.env);
    if (!receipt.client) return finish(receipt, 'aborted', 'developer cancelled at agent choice');
  }
  return runProgram(io, receipt, opts);
}

export async function resume(opts: JourneyOptions): Promise<number> {
  const { io } = opts;
  const loaded = loadReceipt(opts.repo);
  if (loaded.kind === 'none') { io.say('No saved Wizard run in this repository. Start one with `wizard`.'); return 1; }
  if (loaded.kind === 'invalid') {
    io.say(`The saved Wizard receipt is unreadable (${loaded.reason}). It is left as is at ${WIZARD_DIR}/receipt.json.`);
    io.say('Start a new run with `wizard`; the unreadable file is kept beside it.');
    return 1;
  }
  // Paths excluded now are added to the saved ones before anything is inspected; saved exclusions stay.
  loaded.receipt.exclude = [...new Set([...loaded.receipt.exclude, ...opts.exclude])];
  if (loaded.receipt.state === 'completed') {
    printSaved(io, loaded.receipt);
    io.say(`The saved ${loaded.receipt.program} run is complete. Nothing to resume.`);
    return 0;
  }
  return resumeRun(io, loaded.receipt, opts, true);
}

export async function start(program: ProgramName, opts: JourneyOptions): Promise<number> {
  const { io, repo } = opts;
  const loaded = loadReceipt(repo);
  if (loaded.kind === 'found') {
    const saved = loaded.receipt;
    saved.exclude = [...new Set([...saved.exclude, ...opts.exclude])];
    printSaved(io, saved);
    const done = saved.state === 'completed';
    const next = await io.choose(done ? 'A completed run is saved here.' : 'There is unfinished work here.', [
      ...(done ? [] : [{ label: `Resume the ${saved.program} program from ${nextTitle(saved)}`, value: 'resume' as const }]),
      { label: `Start a new ${program} run (the saved run's record is kept beside it)`, value: 'new' as const },
      { label: 'Cancel', value: 'cancel' as const },
    ], 0);
    io.say();
    if (next === 'resume') return resumeRun(io, saved, opts, false);
    if (next !== 'new') { io.say('Cancelled. The saved run is unchanged.'); return 130; }
  }

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
    else { io.say('Cancelled. Nothing was saved or changed.'); return 130; }
  }

  if (loaded.kind !== 'none') {
    const aside = `${receiptPath(repo)}.${loaded.kind === 'found' ? loaded.receipt.state : 'invalid'}-${Date.now()}`;
    renameSync(receiptPath(repo), aside);
    io.say(`The saved receipt was kept as ${aside}.`);
  }
  const receipt = newReceipt({ repo, program, pid: process.pid });
  receipt.context = context;
  receipt.exclude = exclude;
  saveReceipt(receipt);
  active.receipt = receipt;

  if (programFor(program).asksChoices) {
    const choices = await askChoices(io, context.language.value);
    if (!choices) { io.say('Cancelled.'); return finish(receipt, 'aborted', 'developer cancelled while choosing'); }
    receipt.context.choices = choices;
    saveReceipt(receipt);
  }
  receipt.client = opts.client ?? await chooseClient(io, opts.env);
  if (!receipt.client) { io.say('Cancelled.'); return finish(receipt, 'aborted', 'developer cancelled at agent choice'); }
  saveReceipt(receipt);
  return runProgram(io, receipt, opts);
}
