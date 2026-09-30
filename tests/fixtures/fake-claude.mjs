#!/usr/bin/env node
// Simulated Claude Code at the process boundary. Journey tests use it; it is not native evidence.
// State lives in FAKE_CLAUDE_STATE. Sessions are scripted per skill in FAKE_CLAUDE_STATE/sessions.json.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.FAKE_CLAUDE_STATE;
const statePath = join(stateDir, 'state.json');
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { loggedIn: true, marketplace: null, installed: false, mcp: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const log = (line) => appendFileSync(join(stateDir, 'calls.log'), line + '\n');
const args = process.argv.slice(2);
log(JSON.stringify(args));

const out = (text) => process.stdout.write(text + '\n');
const cmd = args.join(' ');

if (cmd === '--version') { out('2.1.283 (Claude Code)'); process.exit(0); }
if (cmd === 'auth status --json') { out(JSON.stringify({ loggedIn: state.loggedIn })); process.exit(state.loggedIn ? 0 : 1); }
if (cmd === 'plugin list --json') {
  out(JSON.stringify(state.installed ? [{ id: 'straddle@straddle', version: '0.1.0', enabled: true, installPath: state.marketplace, mcpServers: { 'straddle-api': {}, 'straddle-docs': {} } }] : []));
  process.exit(0);
}
if (cmd === 'plugin marketplace list --json') {
  out(JSON.stringify(state.marketplace ? [{ name: 'straddle', source: 'directory', path: state.marketplace }] : []));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') { state.marketplace = args[3]; save(); out('✔ Successfully added marketplace: straddle'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'update') { out('✔ Successfully updated marketplace: straddle'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  if (!state.marketplace) { out('Marketplace straddle not found'); process.exit(1); }
  state.marketplace = null; save(); out('✔ Successfully removed marketplace: straddle'); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'install') {
  if (!state.marketplace) { out('Plugin not found in any marketplace'); process.exit(1); }
  state.installed = true; save(); out(JSON.stringify({ outcome: 'ok' })); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'update') { out(JSON.stringify({ outcome: 'ok', updateOutcome: 'up_to_date' })); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'uninstall') {
  if (!state.installed) { out(JSON.stringify({ outcome: 'failed', failureCode: 'not_installed' })); process.exit(1); }
  state.installed = false; save(); out(JSON.stringify({ outcome: 'ok' })); process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const name = args[args.indexOf('user') + 1];
  if (state.mcp[name]) { out(`MCP server ${name} already exists in user config`); process.exit(1); }
  state.mcp[name] = args; save(); out(`Added HTTP MCP server ${name}`); process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'remove') {
  const name = args[args.length - 1];
  if (!state.mcp[name]) { out(`No MCP server named "${name}" in user scope`); process.exit(1); }
  delete state.mcp[name]; save(); out(`Removed MCP server ${name}`); process.exit(0);
}

// Interactive session: `--settings <file>` plus a prompt that starts with /straddle:<skill>.
const settingsPath = args[args.indexOf('--settings') + 1];
const prompt = args[args.length - 1];
const skill = /^\/straddle:(straddle-[a-z-]+)/.exec(prompt)?.[1];
const sessions = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'));
const script = sessions[skill] ?? { steps: [], text: '', exit: 0 };
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const transcript = join(stateDir, `transcript-${skill}.jsonl`);
mkdirSync(stateDir, { recursive: true });
writeFileSync(transcript, '');

function hook(event, payload) {
  for (const group of settings.hooks[event] ?? []) {
    if (group.matcher && !new RegExp(`^(${group.matcher})$`).test(payload.tool_name ?? '')) continue;
    for (const h of group.hooks) {
      const r = spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ hook_event_name: event, session_id: 's1', transcript_path: transcript, cwd: process.cwd(), ...payload }), encoding: 'utf8' });
      if (r.stdout.includes('"deny"') || r.status === 2) return 'deny';
    }
  }
  return 'allow';
}

hook('SessionStart', { source: 'startup' });
// Like Claude Code: PreToolUse before the permission decision, PostToolUse only after the tool completed.
// `denied` lists tool targets the developer refuses at the client's own permission prompt.
// `shellSteps` are step files the agent opens with a Bash command instead of the Read tool.
const deniedByDeveloper = new Set(script.denied ?? []);
const stepFile = (step) => `${process.env.FAKE_PLUGIN_ROOT ?? '/plugin'}/skills/${skill}/steps/${step}.md`;
for (const step of script.steps) {
  const call = { tool_name: 'Read', tool_input: { file_path: stepFile(step) } };
  if (hook('PreToolUse', call) === 'allow' && !deniedByDeveloper.has(step)) hook('PostToolUse', call);
}
for (const step of script.shellSteps ?? []) {
  const call = { tool_name: 'Bash', tool_input: { command: `cat ${stepFile(step)}` } };
  if (hook('PreToolUse', call) === 'allow' && !deniedByDeveloper.has(step)) hook('PostToolUse', call);
}
for (const w of script.writes ?? []) {
  const call = { tool_name: 'Write', tool_input: { file_path: join(process.cwd(), w.path), content: w.content } };
  let decision = hook('PreToolUse', call);
  if (decision === 'allow' && deniedByDeveloper.has(w.path)) decision = 'denied by developer';
  if (decision === 'allow') { writeFileSync(join(process.cwd(), w.path), w.content); hook('PostToolUse', call); }
  log(`write ${w.path} ${decision}`);
}
appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: script.text }] } }) + '\n');
hook('Stop', {});
hook('SessionEnd', { reason: 'prompt_input_exit' });
if (script.signal) process.kill(process.pid, script.signal);
process.exit(script.exit ?? 0);
