#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bundleLabel } from './bundle.ts';
import {
  CLIENT_LABEL, CLIENT_NAMES, EVENT_SURFACE, displayCommand, inspectClient, installPlan, mcpAddPlan, mcpRemovePlan, removePlan, runCommands, updatePlan,
  type ClientName, type ConfigPlan,
} from './clients.ts';
import { straddleConfiguration } from './configuration.ts';
import { findBundle, handleInterrupt, prepareBundle, printPlan, resume, savedHandoff, savedStatus, start, type JourneyOptions } from './journey.ts';
import { PROGRAMS, isRunnableSkill, type ProgramName } from './programs.ts';
import { openFile, writeLog } from './log.ts';
import { WIZARD_DIR, loadReceipt, type Mode } from './receipt.ts';
import { Prompter } from './ui.ts';
import { WIZARD_VERSION } from './version.ts';

const USAGE = `Straddle Wizard ${WIZARD_VERSION}

Sets up Straddle in your repo with your own coding agent, in one guided session.

  wizard                       Guided integration in one agent session: Setup, Plan, Migrate (when you use another payment provider), Integrate, Test, Go Live
  wizard resume                Pick up at the first unfinished step, from the files the skills wrote
  wizard setup | plan | integrate | test
  wizard get-started | migrate | go-live | audit
  wizard skill list | skill run <name>
  wizard install | update | remove [--client claude|codex|cursor] [--yes]
  wizard mcp add | mcp remove [--client claude|codex|cursor] [--yes]
  wizard status [--json]
  wizard log                   Open this repo's recorded sessions as a local page, grouped by step, secrets redacted

Options
  --dir <path>        Repo to work in (default: current directory)
  --client <name>     claude, codex or cursor
  --mode <mode>       auto (I start your agent here) or manual (I tell you what to paste into your own agent)
  --bundle <path>     Use this local Straddle skills directory instead of a plugin release, for testing (or STRADDLE_WIZARD_BUNDLE)
  --exclude <glob>    Extra sensitive path I never open (repeatable, or STRADDLE_WIZARD_EXCLUDE=a,b)
  --yes               Download the skills and run install/update/remove/mcp commands without asking
  --json              Machine-readable output for status and skill list`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
function readArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        client: { type: 'string' },
        mode: { type: 'string' },
        bundle: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        yes: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

const { values, positionals } = readArgs();
const env = process.env;
const repo = resolve(values.dir ?? process.cwd());
const bundlePath = values.bundle || env.STRADDLE_WIZARD_BUNDLE || undefined;
const exclude = [...(values.exclude ?? []), ...(env.STRADDLE_WIZARD_EXCLUDE?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])];
const say = (line = '') => process.stdout.write(`${line}\n`);

if (values.version) { say(WIZARD_VERSION); process.exit(0); }
if (values.help || positionals[0] === 'help') { say(USAGE); process.exit(0); }
if (!existsSync(repo) || !statSync(repo).isDirectory()) fail(`${repo} is not a directory.`);

function clientOption(): ClientName | undefined {
  if (values.client === undefined) return undefined;
  if ((CLIENT_NAMES as readonly string[]).includes(values.client)) return values.client as ClientName;
  fail(`Unknown client "${values.client}". Use claude, codex or cursor.`);
}

function modeOption(): Mode | undefined {
  if (values.mode === undefined || values.mode === 'auto' || values.mode === 'manual') return values.mode;
  fail(`Unknown mode "${values.mode}". Use auto or manual.`);
}

function pickClient(): ClientName {
  const chosen = clientOption();
  if (chosen) return chosen;
  const found = (['claude', 'codex'] as const).filter((name) => inspectClient(name, env).version !== null);
  if (found.length === 1) return found[0]!;
  fail(`Pass --client ${found.length ? found.join(' or ') : 'claude, codex or cursor'}.`);
}

// One reader for stdin, shared by every question in this process.
let prompter: Prompter | null = null;
const io = () => (prompter ??= new Prompter(process.stdin, process.stdout));

async function preparedBundle() {
  const check = await prepareBundle(io(), { override: bundlePath, env }, Boolean(values.yes));
  if (check === null) say("Cancelled. I didn't download anything.");
  else if (!check.ok) say(check.reason);
  return check?.ok ? check.bundle : null;
}

async function confirmAndRun(plan: ConfigPlan, heading: string): Promise<number> {
  say(heading);
  printPlan(say, plan);
  if (plan.kind === 'nothing') return 0;
  if (plan.kind === 'manual') { say("I didn't change anything; follow the steps above in the client."); return 1; }
  if (!values.yes) {
    const go = await io().choose('Run these commands?', [{ label: 'Run them', value: true }, { label: 'Cancel', value: false }], 0);
    if (!go) { say("Cancelled. I didn't change anything."); return 130; }
  }
  let ok = true;
  for (const r of runCommands(plan.commands, env)) {
    say(`${r.outcome.padEnd(8)}${displayCommand(r.command)}`);
    if (r.outcome === 'failed') { ok = false; say(r.output.split('\n').slice(-5).map((l) => `        ${l}`).join('\n')); }
  }
  return ok ? 0 : 1;
}

async function configure(kind: 'install' | 'update' | 'remove' | 'mcp add' | 'mcp remove'): Promise<number> {
  const client = pickClient();
  const state = inspectClient(client, env);
  if (client !== 'cursor' && state.version === null) { say(`${CLIENT_LABEL[client]} isn't installed or isn't on your PATH.`); return 1; }
  if (kind === 'remove') return confirmAndRun(removePlan(state), `Remove the Straddle plugin from ${state.label}:`);
  if (kind === 'mcp add') return confirmAndRun(mcpAddPlan(state), `Register the Straddle API MCP and Docs MCP in ${state.label}:`);
  if (kind === 'mcp remove') return confirmAndRun(mcpRemovePlan(state), `Remove the Straddle MCP servers from ${state.label}:`);
  const bundle = await preparedBundle();
  if (!bundle) return 1;
  const plan = kind === 'install' ? installPlan(state, bundle) : updatePlan(state, bundle);
  const code = await confirmAndRun(plan, `${kind === 'install' ? 'Install' : 'Update'} the Straddle plugin in ${state.label} from the ${bundleLabel(bundle)}:`);
  if (client === 'cursor' || code !== 0) return code;
  // Success means the copy the client loads is the Wizard's bundle, not only that the native commands exited 0.
  const after = inspectClient(client, env, bundle);
  say(`Straddle plugin in ${after.label}: ${after.plugin.state}${after.plugin.version ? ` ${after.plugin.version}` : ''}, ${after.plugin.verified ? "matches the Wizard's bundle" : "does not match the Wizard's bundle"}`);
  return after.plugin.verified ? 0 : 1;
}

function status(): number {
  const loaded = loadReceipt(repo);
  const check = findBundle({ override: bundlePath, env });
  const clients = CLIENT_NAMES.map((name) => inspectClient(name, env, check.ok ? check.bundle : null));
  const config = straddleConfiguration(env);
  const handoff = loaded.kind === 'found' ? savedHandoff(loaded.receipt, env) : null;
  const run = loaded.kind === 'found'
    ? { program: loaded.receipt.program, state: loaded.receipt.state, reason: loaded.receipt.stateReason, updatedAt: loaded.receipt.updatedAt, client: loaded.receipt.client, mode: loaded.receipt.mode, ...savedStatus(loaded.receipt), paste: handoff?.prompt ?? null }
    : loaded.kind === 'invalid' ? { error: `unreadable receipt: ${loaded.reason}` } : null;
  const report = {
    wizard: WIZARD_VERSION,
    repository: repo,
    bundle: check.ok
      ? { kind: check.bundle.kind, pluginVersion: check.bundle.pluginVersion, contentSha256: check.bundle.contentSha256, path: check.bundle.path, skills: Object.fromEntries(Object.entries(check.bundle.skills).map(([k, v]) => [k, v.version])) }
      : { error: check.reason },
    clients: clients.map((c) => ({ name: c.name, label: c.label, version: c.version, loggedIn: c.loggedIn, plugin: c.plugin, apiMcp: c.apiMcp, eventSurface: EVENT_SURFACE[c.name] })),
    credentials: { STRADDLE_API_KEY: config.key },
    environment: config.environment,
    configurationErrors: config.errors,
    run,
  };
  if (values.json) { say(JSON.stringify(report, null, 2)); return 0; }
  say(`Straddle Wizard ${WIZARD_VERSION}`);
  say(`  Repository     ${repo}`);
  say(`  Skill bundle   ${check.ok ? bundleLabel(check.bundle) : check.reason}`);
  for (const c of clients) {
    const plugin = c.plugin.state === 'installed' ? `plugin ${c.plugin.version}${c.plugin.verified ? '' : " (differs from the Wizard's bundle)"}` : `plugin ${c.plugin.state}`;
    say(`  ${c.label.padEnd(15)}${c.version ?? 'not found'}${c.version ? `, ${plugin}, API MCP ${c.apiMcp}, progress ${EVENT_SURFACE[c.name]}` : ''}`);
  }
  say(`  Straddle key   STRADDLE_API_KEY ${config.key === 'present' ? "is set (I didn't read the value)" : 'is not set'}`);
  say(`  Environment    ${config.environment}`);
  if (config.errors.length) say(`  Configuration error for Straddle requests: ${config.errors.join('; ')}`);
  say(`  Saved run      ${run === null ? 'none' : 'error' in run ? run.error : `${run.program} program, ${run.state}: ${run.reason}`}`);
  if (run && 'progress' in run) say(`  Progress       ${run.progress}`);
  if (handoff) {
    say(`  Paste next     ${handoff.steps[1]}`);
    for (const line of handoff.prompt.split('\n')) say(`                   ${line}`);
  }
  return 0;
}

async function skillList(): Promise<number> {
  const bundle = await preparedBundle();
  if (!bundle) return 1;
  const skills = Object.entries(bundle.skills).map(([name, info]) => ({ name, version: info.version, runnable: isRunnableSkill(name), description: info.description }));
  if (values.json) { say(JSON.stringify({ bundle: bundleLabel(bundle), path: bundle.path, skills }, null, 2)); return 0; }
  say(`Skills in the ${bundleLabel(bundle)}:`);
  for (const s of skills) {
    const summary = s.description.split('. ')[0] ?? '';
    say(`  ${s.name.padEnd(26)}${s.version.padEnd(8)}${s.runnable ? `wizard skill run ${s.name}` : 'shared rules the other skills read'}`);
    say(`  ${''.padEnd(34)}${summary}`);
  }
  return 0;
}

async function journey(run: (opts: JourneyOptions) => Promise<number>): Promise<number> {
  // Options first, so a bad --client or --mode fails before the splash.
  // The end-of-session log question needs someone at a terminal, and never interrupts --json.
  const opts = { repo, env, io: io(), bundlePath, client: clientOption(), mode: modeOption(), exclude, offerLog: !values.json && Boolean(process.stdin.isTTY && process.stdout.isTTY) };
  process.on('SIGINT', () => handleInterrupt(io()));
  await io().splash();
  return run(opts);
}

// Built from the run record in this repo; a pipe gets the page's path instead of a browser.
function log(): number {
  const path = writeLog(repo);
  if (!path) fail(`No Wizard session is recorded in ${repo}: ${WIZARD_DIR}/events.jsonl is missing or empty. Run \`wizard\` first.`, 1);
  if (process.stdout.isTTY) openFile(path);
  say(`Session log: ${path}`);
  return 0;
}

async function main(): Promise<number> {
  const [command, sub, name, ...rest] = positionals;
  const extra = command === 'skill' && sub === 'run' ? rest : [name, ...rest].filter((a) => a !== undefined);
  if (extra.length) fail(`Unexpected arguments: ${extra.join(' ')}\n\n${USAGE}`);
  if (command === undefined) return journey((opts) => start('integration', opts));
  if (Object.hasOwn(PROGRAMS, command) && sub === undefined) return journey((opts) => start(command as ProgramName, opts));
  if (command === 'resume' && sub === undefined) return journey(resume);
  if ((command === 'install' || command === 'update' || command === 'remove') && sub === undefined) return configure(command);
  if (command === 'status' && sub === undefined) return status();
  if (command === 'log' && sub === undefined) return log();
  if (command === 'mcp' && (sub === 'add' || sub === 'remove')) return configure(`mcp ${sub}`);
  if (command === 'skill' && sub === 'list') return skillList();
  if (command === 'skill' && sub === 'run') {
    if (!name) fail('Name the skill: wizard skill run <name>. See `wizard skill list`.');
    if (name === 'straddle-best-practices') fail('straddle-best-practices holds the shared rules every other skill reads; it does not run on its own.');
    if (!isRunnableSkill(name)) fail(`Unknown skill "${name}". See \`wizard skill list\`.`);
    return journey((opts) => start(`skill:${name}`, opts));
  }
  fail(`Unknown command "${[command, sub].filter(Boolean).join(' ')}".\n\n${USAGE}`);
}

process.exit(await main());
