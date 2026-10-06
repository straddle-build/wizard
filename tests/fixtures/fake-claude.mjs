#!/usr/bin/env node
// Simulated Claude Code at the process boundary. Journey tests use it; it is not native evidence.
// State lives in FAKE_CLAUDE_STATE. Each program step is scripted per skill in FAKE_CLAUDE_STATE/sessions.json; one
// session runs the prompt's `Straddle Wizard program:` steps from its `Start at` skill, like the skills do.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

// Interactive session: `--settings <file>`, optionally `--resume <id>`, and a prompt that starts with /straddle:<skill>.
const settingsPath = args[args.indexOf('--settings') + 1];
const prompt = args[args.length - 1];
const first = /^\/straddle:(straddle-[a-z-]+)/.exec(prompt)?.[1];
const program = /Straddle Wizard program: (.*?)\. Start at/.exec(prompt)?.[1].split(' → ') ?? [first];
const sessions = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'));
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID();
const transcript = join(stateDir, `transcript-${sessionId}.jsonl`);
mkdirSync(stateDir, { recursive: true });
if (!existsSync(transcript)) writeFileSync(transcript, '');
// The `straddle` a skill's shell command would run in this session, and its version.
writeFileSync(join(stateDir, 'straddle.txt'), spawnSync('sh', ['-c', 'command -v straddle && straddle --version'], { encoding: 'utf8' }).stdout);

function hook(event, payload) {
  for (const group of settings.hooks[event] ?? []) {
    if (group.matcher && !new RegExp(`^(${group.matcher})$`).test(payload.tool_name ?? '')) continue;
    for (const h of group.hooks) {
      const r = spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), ...payload }), encoding: 'utf8' });
      if (r.stdout.includes('"deny"') || r.status === 2) return 'deny';
    }
  }
  return 'allow';
}

// What Claude Code shows in its status line: the settings' command, given the session JSON on stdin.
function statusLine() {
  if (!settings.statusLine) return;
  const r = spawnSync('/bin/sh', ['-c', settings.statusLine.command], { input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: process.cwd() }), encoding: 'utf8' });
  appendFileSync(join(stateDir, 'statusline.log'), r.stdout);
}

// Like Claude Code's transcript: every assistant entry is timestamped, and each tool call is a tool_use block.
const assistant = (content) => appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'assistant', content } }) + '\n');
const toolUse = (call) => assistant([{ type: 'tool_use', id: randomUUID(), name: call.tool_name, input: call.tool_input }]);
hook('SessionStart', { source: args.includes('--resume') ? 'resume' : 'startup' });
appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: prompt } }) + '\n');
statusLine();
let script = { exit: 0 };
for (const skill of program.slice(program.indexOf(first))) {
  // `withoutKey`: what the step does when STRADDLE_API_KEY isn't set, as real Setup stops at the missing key.
  script = !process.env.STRADDLE_API_KEY && sessions[skill]?.withoutKey ? sessions[skill].withoutKey : sessions[skill];
  if (!script) break;
  // Like Claude Code: PreToolUse before the permission decision, PostToolUse only after the tool completed.
  // `denied` lists tool targets the developer refuses at the client's own permission prompt.
  // `shellSteps` are step files the agent opens with a Bash command instead of the Read tool.
  const deniedByDeveloper = new Set(script.denied ?? []);
  const stepFile = (step) => `${process.env.FAKE_PLUGIN_ROOT ?? '/plugin'}/skills/${skill}/steps/${step}.md`;
  for (const step of script.steps ?? []) {
    const call = { tool_name: 'Read', tool_input: { file_path: stepFile(step) } };
    toolUse(call);
    if (hook('PreToolUse', call) === 'allow' && !deniedByDeveloper.has(step)) hook('PostToolUse', call);
  }
  for (const step of script.shellSteps ?? []) {
    const call = { tool_name: 'Bash', tool_input: { command: `cat ${stepFile(step)}` } };
    toolUse(call);
    if (hook('PreToolUse', call) === 'allow' && !deniedByDeveloper.has(step)) hook('PostToolUse', call);
  }
  for (const w of script.writes ?? []) {
    const call = { tool_name: 'Write', tool_input: { file_path: join(process.cwd(), w.path), content: w.content } };
    toolUse(call);
    let decision = hook('PreToolUse', call);
    if (decision === 'allow' && deniedByDeveloper.has(w.path)) decision = 'denied by developer';
    if (decision === 'allow') { writeFileSync(join(process.cwd(), w.path), w.content); hook('PostToolUse', call); }
    log(`write ${w.path} ${decision}`);
  }
  // `{{CODE_HASH}}` in a printed payment review: the code hash the bundle's real session-state script prints for the
  // run's baseline now, as the skill computes it.
  const codeHash = () => {
    const baseline = JSON.parse(readFileSync(join(process.cwd(), '.straddle-wizard', 'session-baseline.json'), 'utf8'));
    const r = spawnSync('bash', [join(args[args.indexOf('--plugin-dir') + 1], 'skills', 'straddle-payment-review', 'scripts', 'session-state'), 'compare', baseline.snapshot], { encoding: 'utf8' });
    return /^code-hash ([0-9a-f]{64})/.exec(r.stdout)?.[1] ?? 'none';
  };
  assistant([{ type: 'text', text: (script.text ?? '').replaceAll('{{CODE_HASH}}', codeHash) }]);
  // `hang`: the agent is still working when the developer presses Ctrl-C (and leaves a marked child running).
  if (script.hang) {
    // `; :` keeps the shell from exec-ing sleep, so the marked process is the agent's child with a child of its own.
    spawn('sh', ['-c', 'sleep 300; :', script.hang], { stdio: 'ignore' });
    process.stdout.write('fake agent working\n');
    await new Promise(() => {});
  }
  hook('Stop', {});
  statusLine();
  // `stop`: the developer exits after this step; `exit` or `signal`: the session ends abnormally here.
  if (script.stop || script.signal || script.exit) break;
}
hook('SessionEnd', { reason: 'prompt_input_exit' });
if (script?.signal) process.kill(process.pid, script.signal);
process.exit(script?.exit ?? 0);
