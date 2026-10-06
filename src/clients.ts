import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { matchesBundle, type Bundle } from './bundle.ts';
import { field, parseJson, text } from './json.ts';

export type ClientName = 'claude' | 'codex' | 'cursor';
export const CLIENT_NAMES: readonly ClientName[] = ['claude', 'codex', 'cursor'];
export const CLIENT_LABEL: Record<ClientName, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

export const API_MCP_URL = 'https://mcp.scalar.com/mcp/d5d1b1c2-ae5b-432d-b795-4fcb31cfdedd';
export const DOCS_MCP_URL = 'https://straddle-build-straddle-openapi.apidocumentation.com/mcp';
export const CONNECT_MCP_GUIDE = 'https://straddle-build-straddle-openapi.apidocumentation.com/connect-mcp';
const PLUGIN_ID = 'straddle@straddle';
const NATIVE_TIMEOUT_MS = 60_000;

// How the Wizard learns what happens inside a session: Claude Code hooks, the Codex session log, or nothing for Cursor.
export const EVENT_SURFACE: Record<ClientName, 'observed' | 'unsupported'> = { claude: 'observed', codex: 'observed', cursor: 'unsupported' };
export const EVENT_SURFACE_NOTE: Record<ClientName, string> = {
  claude: 'live checklist in its status line, from Claude Code hooks',
  codex: 'live checklist on a local page, from its session log',
  cursor: 'no live checklist: I read the files the skills write when it stops',
};

const BINARY: Record<ClientName, string> = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent' };

export interface Command {
  bin: string;
  args: string[];
  // Output that means the change is already in place, so the command is a no-op, not a failure.
  already?: RegExp;
}

export interface CommandResult { command: Command; outcome: 'ok' | 'already' | 'failed'; output: string }

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(command: Command): string {
  return [command.bin, ...command.args].map(shellQuote).join(' ');
}

// `stdout` is what callers parse; `out` adds stderr, which clients use for warnings, and is only for showing or matching messages.
function native(bin: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; out: string } {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { status: null, stdout: '', out: r.error.message };
  return { status: r.status, stdout: r.stdout.trim(), out: `${r.stdout}${r.stderr}`.trim() };
}

export function runCommands(commands: readonly Command[], env: NodeJS.ProcessEnv): CommandResult[] {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const r = native(command.bin, command.args, env);
    const outcome = command.already?.test(r.out) ? 'already' : r.status === 0 ? 'ok' : 'failed';
    results.push({ command, outcome, output: r.out });
    if (outcome === 'failed') break;
  }
  return results;
}

// `verified`: every copy the client reports loading the plugin from has exactly the content of the Wizard's bundle.
export interface PluginState { state: 'installed' | 'missing' | 'unverified'; version: string | null; verified: boolean }

export interface ClientState {
  name: ClientName;
  label: string;
  version: string | null;
  loggedIn: boolean | null;
  plugin: PluginState;
  marketplacePath: string | null;
  apiMcp: string;
}

// Where Claude Code keeps the "straddle" marketplace: the directory it was added from, or its own copy of a Git source.
function claudeMarketplacePath(env: NodeJS.ProcessEnv): string | null {
  const markets = parseJson(native('claude', ['plugin', 'marketplace', 'list', '--json'], env).stdout);
  const market = Array.isArray(markets) ? markets.find((m) => field(m, 'name') === 'straddle') : undefined;
  return text(field(market, 'installLocation')) ?? text(field(market, 'path')) ?? null;
}

function pluginState(listed: boolean, entry: unknown, loadedFrom: ReadonlyArray<string | null>, bundle: Bundle | null): PluginState {
  if (!listed) return { state: 'unverified', version: null, verified: false };
  if (!entry) return { state: 'missing', version: null, verified: false };
  const paths = loadedFrom.filter((p) => p !== null);
  return { state: 'installed', version: text(field(entry, 'version')) ?? null, verified: bundle !== null && paths.length > 0 && paths.every((p) => matchesBundle(p, bundle)) };
}

function inspectClaude(env: NodeJS.ProcessEnv, version: string, bundle: Bundle | null): ClientState {
  const auth = native('claude', ['auth', 'status', '--json'], env);
  const loggedIn = field(parseJson(auth.stdout), 'loggedIn');
  const listed = parseJson(native('claude', ['plugin', 'list', '--json'], env).stdout);
  const entry = Array.isArray(listed) ? listed.find((p) => field(p, 'id') === PLUGIN_ID) : undefined;
  const marketplacePath = claudeMarketplacePath(env);
  return {
    name: 'claude',
    label: CLIENT_LABEL.claude,
    version,
    loggedIn: typeof loggedIn === 'boolean' ? loggedIn : null,
    // Claude Code loads a directory marketplace's plugin in place, and reports its cached copy as installPath.
    plugin: pluginState(Array.isArray(listed), entry, [marketplacePath, text(field(entry, 'installPath')) ?? null], bundle),
    marketplacePath,
    apiMcp: entry
      ? 'declared by the Straddle plugin; Claude Code sends STRADDLE_API_KEY from the environment it starts in'
      : 'not declared (install the plugin, or `wizard mcp add --client claude`)',
  };
}

function inspectCodex(env: NodeJS.ProcessEnv, version: string, bundle: Bundle | null): ClientState {
  const login = native('codex', ['login', 'status'], env);
  const listed = parseJson(native('codex', ['plugin', 'list', '--json'], env).stdout);
  const installed = field(listed, 'installed');
  const entry = Array.isArray(installed) ? installed.find((p) => field(p, 'pluginId') === PLUGIN_ID) : undefined;
  const markets = field(parseJson(native('codex', ['plugin', 'marketplace', 'list', '--json'], env).stdout), 'marketplaces');
  const market = Array.isArray(markets) ? markets.find((m) => field(m, 'name') === 'straddle') : undefined;
  // Codex loads the copy `codex plugin add` makes in its plugin cache, not the marketplace directory.
  const pluginVersion = text(field(entry, 'version'));
  const cached = pluginVersion ? join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'plugins', 'cache', 'straddle', 'straddle', pluginVersion) : null;
  const servers = parseJson(native('codex', ['mcp', 'list', '--json'], env).stdout);
  const api = Array.isArray(servers) ? servers.find((s) => field(s, 'name') === 'straddle-api') : undefined;
  const bearer = text(field(field(api, 'transport'), 'bearer_token_env_var'));
  return {
    name: 'codex',
    label: CLIENT_LABEL.codex,
    version,
    loggedIn: login.status === 0,
    plugin: pluginState(Array.isArray(installed), entry, [cached], bundle),
    marketplacePath: text(field(market, 'root')) ?? null,
    apiMcp: bearer
      ? `straddle-api reads ${bearer} (codex mcp)`
      : api
        ? 'registered without a credential: run `wizard mcp add --client codex` so straddle-api reads STRADDLE_API_KEY'
        : 'not registered',
  };
}

// Cursor names a plugin's MCP servers `plugin-<plugin dir>-<server>`, so a Straddle server counts by its name's suffix.
export const isStraddleServer = (name: string, server: 'straddle-api' | 'straddle-docs') => name === server || name.endsWith(`-${server}`);

// cursor-agent has no plugin list, and `cursor-agent mcp list` doesn't show plugin servers, so the Wizard reads the
// files Cursor loads: local plugin copies in ~/.cursor/plugins/local and servers in ~/.cursor/mcp.json.
// ponytail: user-level files only; a project's .cursor/mcp.json isn't read until the Wizard passes the repo here.
function inspectCursor(env: NodeJS.ProcessEnv, version: string, bundle: Bundle | null): ClientState {
  const status = native('cursor-agent', ['status'], env);
  const home = join(env.HOME || homedir(), '.cursor');
  const read = (path: string) => (existsSync(path) ? parseJson(readFileSync(path, 'utf8')) : null);
  const manifest = (dir: string) => read(join(dir, '.cursor-plugin', 'plugin.json'));
  // Server names from a server map, or from the mcp.json a plugin manifest points to (Straddle's says "./mcp.json").
  const names = (servers: unknown, dir: string): string[] => {
    const map = typeof servers === 'string' ? field(read(join(dir, servers)), 'mcpServers') : servers;
    return Object.keys(map && typeof map === 'object' ? map : {});
  };
  const local = join(home, 'plugins', 'local');
  const copies = (existsSync(local) ? readdirSync(local) : []).map((d) => join(local, d)).filter((d) => field(manifest(d), 'name') === 'straddle');
  const configured = names(field(read(join(home, 'mcp.json')), 'mcpServers'), home).find((n) => isStraddleServer(n, 'straddle-api'));
  const declaring = copies.find((d) => names(field(manifest(d), 'mcpServers'), d).some((n) => isStraddleServer(n, 'straddle-api')));
  return {
    name: 'cursor',
    label: CLIENT_LABEL.cursor,
    version,
    loggedIn: /Logged in as /.test(status.stdout),
    // A copy in plugins/local is the only install the Wizard can see; team-marketplace installs stay unverified.
    plugin: copies.length
      ? { state: 'installed', version: text(field(manifest(copies[0]!), 'version')) ?? null, verified: bundle !== null && copies.every((d) => matchesBundle(d, bundle)) }
      : { state: 'unverified', version: null, verified: false },
    marketplacePath: null,
    apiMcp: configured
      ? `${configured} in ~/.cursor/mcp.json`
      : declaring
        ? `declared by the Straddle plugin in ${declaring}, which Cursor names plugin-${basename(declaring)}-straddle-api; cursor-agent sends STRADDLE_API_KEY from the environment it starts in`
        : 'not detected: no straddle-api in ~/.cursor/mcp.json or a local Straddle plugin (I can\'t see team-marketplace installs)',
  };
}

// `bundle`: the bundle the Wizard is using, which an installed plugin must match to count as verified.
export function inspectClient(name: ClientName, env: NodeJS.ProcessEnv, bundle: Bundle | null = null): ClientState {
  const probe = native(BINARY[name], ['--version'], env);
  const version = probe.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(probe.stdout)?.[1] ?? probe.stdout) : null;
  if (version === null) {
    return { name, label: CLIENT_LABEL[name], version, loggedIn: null, plugin: { state: name === 'cursor' ? 'unverified' : 'missing', version: null, verified: false }, marketplacePath: null, apiMcp: 'unverified' };
  }
  return name === 'claude' ? inspectClaude(env, version, bundle) : name === 'codex' ? inspectCodex(env, version, bundle) : inspectCursor(env, version, bundle);
}

export type ConfigPlan = { kind: 'commands'; commands: Command[]; note: string } | { kind: 'manual'; steps: string[] } | { kind: 'nothing'; note: string };

const cursorPluginSteps = (bundle: Bundle | null) => [
  "I can't drive Cursor from here, so do this in Cursor:",
  `Import ${bundle ? bundle.path : 'the straddle-build/skills repository'} as a team marketplace and install the "straddle" plugin.`,
  'Enter your Straddle API key when Cursor asks for STRADDLE_API_KEY. Never paste it into the Wizard.',
];

export function installPlan(state: ClientState, bundle: Bundle): ConfigPlan {
  if (state.name === 'cursor') return { kind: 'manual', steps: cursorPluginSteps(bundle) };
  // A "straddle" marketplace registered from another place is the developer's; the Wizard never replaces it.
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  if (state.marketplacePath && real(state.marketplacePath) !== real(bundle.path)) {
    return { kind: 'manual', steps: [`${state.label} already has a marketplace named "straddle" at ${state.marketplacePath}, not the verified ${bundle.path}. I won't replace it. If it's stale, remove it with \`${state.name} plugin marketplace remove straddle\`, then run \`wizard install\` again.`] };
  }
  const commands: Command[] = [];
  if (!state.marketplacePath) commands.push({ bin: state.name, args: ['plugin', 'marketplace', 'add', bundle.path] });
  if (state.name === 'claude') {
    commands.push({ bin: 'claude', args: ['plugin', 'install', PLUGIN_ID] });
    return { kind: 'commands', commands, note: 'User scope. Other plugins, marketplaces and MCP servers stay as they are.' };
  }
  commands.push(
    { bin: 'codex', args: ['plugin', 'add', PLUGIN_ID] },
    { bin: 'codex', args: ['mcp', 'add', 'straddle-api', '--url', API_MCP_URL, '--bearer-token-env-var', 'STRADDLE_API_KEY'] },
  );
  return {
    kind: 'commands',
    commands,
    note: 'The last command lets straddle-api read STRADDLE_API_KEY from the environment Codex starts in; the plugin alone cannot carry a credential. Other plugins and MCP servers stay as they are.',
  };
}

// Claude Code keeps an installed same-version copy as it is, so its update reinstalls; `codex plugin add` copies again.
export function updatePlan(state: ClientState, bundle: Bundle): ConfigPlan {
  if (state.name === 'cursor') return { kind: 'manual', steps: ['Update the "straddle" plugin from its team marketplace in Cursor.'] };
  const install = installPlan(state, bundle);
  if (install.kind !== 'commands') return install;
  if (state.name === 'codex') return { ...install, note: `Adding the plugin again copies the verified ${bundle.path} into Codex's plugin cache. ${install.note}` };
  return {
    kind: 'commands',
    commands: [{ bin: 'claude', args: ['plugin', 'uninstall', PLUGIN_ID], already: /not_installed|not found in installed plugins/ }, ...install.commands],
    note: `Reinstalls from the verified ${bundle.path}. Restart Claude Code sessions to load it. ${install.note}`,
  };
}

export function removePlan(state: ClientState): ConfigPlan {
  if (state.name === 'cursor') return { kind: 'manual', steps: ['Uninstall the "straddle" plugin in Cursor and remove its team marketplace if you added it only for Straddle.'] };
  if (state.name === 'claude') {
    return {
      kind: 'commands',
      commands: [
        { bin: 'claude', args: ['plugin', 'uninstall', PLUGIN_ID], already: /not_installed|not found in installed plugins/ },
        { bin: 'claude', args: ['plugin', 'marketplace', 'remove', 'straddle'], already: /not found/i },
      ],
      note: 'Only the Straddle plugin and its "straddle" marketplace are removed. Client-level MCP servers added with `wizard mcp add` stay until `wizard mcp remove`.',
    };
  }
  return {
    kind: 'commands',
    commands: [
      { bin: 'codex', args: ['plugin', 'remove', PLUGIN_ID] },
      { bin: 'codex', args: ['plugin', 'marketplace', 'remove', 'straddle'], already: /not (found|configured)|No marketplace/i },
    ],
    note: 'Only the Straddle plugin and its "straddle" marketplace are removed. Run `wizard mcp remove --client codex` to remove the straddle-api credential route.',
  };
}

export function mcpAddPlan(state: ClientState): ConfigPlan {
  if (state.name === 'cursor') {
    return {
      kind: 'manual',
      steps: [
        "I don't configure Cursor's MCP servers. Add these in Cursor (Settings > MCP), or merge them into ~/.cursor/mcp.json:",
        JSON.stringify({ mcpServers: { 'straddle-api': { url: API_MCP_URL, headers: { Authorization: 'Bearer ${env:STRADDLE_API_KEY}' } }, 'straddle-docs': { url: DOCS_MCP_URL } } }, null, 2),
        `Guide: ${CONNECT_MCP_GUIDE}`,
      ],
    };
  }
  if (state.name === 'claude') {
    if (state.plugin.state === 'installed') return { kind: 'nothing', note: 'The Straddle plugin already declares straddle-api and straddle-docs in Claude Code. Nothing to add.' };
    return {
      kind: 'commands',
      commands: [
        { bin: 'claude', args: ['mcp', 'add', '--transport', 'http', '-s', 'user', 'straddle-api', API_MCP_URL, '-H', 'Authorization: Bearer ${STRADDLE_API_KEY}'], already: /already exists/ },
        { bin: 'claude', args: ['mcp', 'add', '--transport', 'http', '-s', 'user', 'straddle-docs', DOCS_MCP_URL], already: /already exists/ },
      ],
      note: 'User scope. The header holds the literal text ${STRADDLE_API_KEY}; Claude Code reads the value from the environment it starts in. Other MCP servers stay as they are.',
    };
  }
  const commands: Command[] = [{ bin: 'codex', args: ['mcp', 'add', 'straddle-api', '--url', API_MCP_URL, '--bearer-token-env-var', 'STRADDLE_API_KEY'] }];
  if (state.plugin.state !== 'installed') commands.push({ bin: 'codex', args: ['mcp', 'add', 'straddle-docs', '--url', DOCS_MCP_URL] });
  return { kind: 'commands', commands, note: 'straddle-api reads STRADDLE_API_KEY from the environment Codex starts in. Other MCP servers stay as they are.' };
}

export function mcpRemovePlan(state: ClientState): ConfigPlan {
  if (state.name === 'cursor') return { kind: 'manual', steps: ['Remove straddle-api and straddle-docs in Cursor (Settings > MCP) or from ~/.cursor/mcp.json.'] };
  if (state.name === 'claude') {
    return {
      kind: 'commands',
      commands: ['straddle-api', 'straddle-docs'].map((name) => ({ bin: 'claude', args: ['mcp', 'remove', '-s', 'user', name], already: /No MCP server named/ })),
      note: 'Removes only the client-level Straddle servers. Servers the Straddle plugin declares go with `wizard remove`.',
    };
  }
  return {
    kind: 'commands',
    commands: ['straddle-api', 'straddle-docs'].map((name) => ({ bin: 'codex', args: ['mcp', 'remove', name], already: /No MCP server named/ })),
    note: 'Removes only the client-level Straddle servers.',
  };
}

export interface LaunchRequest {
  client: ClientName;
  skill: string;
  repo: string;
  context: string;
  settingsPath: string;
  // The verified bundle directory.
  pluginDir: string;
  // The native session to reopen, or null for a new one.
  resume: string | null;
}

// The first message for the agent: the skill's start on the first line, then the context on its own lines, so its
// `Straddle Wizard program:` line begins a line, as wizard-program.md says. Everything the skill does comes from the
// versioned bundle. Auto passes it on the command line; Manual prints it to paste.
function startPrompt(client: ClientName, skill: string, context: string): string {
  return [client === 'claude' ? `/straddle:${skill}` : `Use the ${skill} skill.`, context].filter(Boolean).join('\n');
}

// The agent runs with the developer's own settings, permission mode, sandbox and approval policy; the Wizard never
// changes them. Claude Code merges `--settings` with them and adds its hooks to theirs. cursor-agent gets no --force,
// --sandbox, --approve-mcps or --trust, so its own approval mode and workspace trust apply.
export function launchCommand(req: LaunchRequest): Command {
  const prompt = startPrompt(req.client, req.skill, req.context);
  if (req.client === 'claude') {
    return { bin: 'claude', args: ['--settings', req.settingsPath, '--plugin-dir', req.pluginDir, ...(req.resume ? ['--resume', req.resume] : []), prompt] };
  }
  if (req.client === 'cursor') {
    return { bin: 'cursor-agent', args: ['--workspace', req.repo, '--plugin-dir', req.pluginDir, ...(req.resume ? [`--resume=${req.resume}`] : []), prompt] };
  }
  return { bin: 'codex', args: [...(req.resume ? ['resume'] : []), '-C', req.repo, ...(req.resume ? [req.resume] : []), prompt] };
}

// The payment review is the one exception to the rule above, and only for the fresh review process: a new session (no
// resume) with the review skill alone, read-only through that process's own flags or settings file. The developer's
// settings files and the original integration session are never touched (skills wizard-program.md, Payment review).
// Claude Code: `--restricted` ignores the developer's user, project and local settings files (so none of their hooks,
// allow rules or tools apply) and `--strict-mcp-config` every MCP server; `--tools` leaves only Read, Glob, Grep and
// Skill, so there is no shell to write or reach the network with (its sandbox still left a temp directory writable);
// `--add-dir` lets those read tools open the skill's own files in the bundle.
// The Wizard computes the scope and hashes beforehand (`writeReviewScope`). The model's own provider connection is the
// client's, not a tool, so it still works. Codex: the read-only sandbox (no writes, no network for commands), which a
// `--sandbox` flag applies over any profile in the developer's config, with no approval prompt, web search, apps and
// hooks off, and every MCP server the developer configured disabled for this process only (`codexMcpOff`).
// Cursor isn't supported: null, so the review stays incomplete.
export function reviewCommand(req: { client: ClientName; repo: string; settingsPath: string; pluginDir: string; line: string; codexConfig: readonly string[] }): Command | null {
  const prompt = startPrompt(req.client, 'straddle-payment-review', req.line);
  if (req.client === 'claude') return { bin: 'claude', args: ['--restricted', '--strict-mcp-config', '--tools', 'Read,Glob,Grep,Skill', '--add-dir', req.pluginDir, '--settings', req.settingsPath, '--plugin-dir', req.pluginDir, prompt] };
  if (req.client === 'codex') return { bin: 'codex', args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '-c', 'web_search="disabled"', '--disable', 'apps', '--disable', 'hooks', ...req.codexConfig, '-C', req.repo, prompt] };
  return null;
}

// Codex merges a `-c mcp_servers=...` override into the configured servers, so an empty table disables nothing. This
// asks Codex itself which servers it would start here, sets each one `enabled = false` in one process-only override
// (an inline table, since a dotted `-c` path can't name a server whose name holds a dot), and asks again with it: any
// server still enabled, or a listing that fails, means no review. A server a plugin provides (the Straddle plugin's
// straddle-api and straddle-docs) has no config entry to merge into, and Codex rejects an override without a transport,
// so each entry restates the listed `url` or `command`. The developer's config files are only read.
export function codexMcpOff(repo: string, env: NodeJS.ProcessEnv): { ok: true; config: string[] } | { ok: false; reason: string } {
  const list = (config: string[]) => {
    const r = spawnSync('codex', [...config, 'mcp', 'list', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    const servers = r.status === 0 ? parseJson(r.stdout) : undefined;
    return Array.isArray(servers) ? servers.map((s) => {
      const transport = field(s, 'transport');
      const url = text(field(transport, 'url'));
      const command = text(field(transport, 'command'));
      return { name: text(field(s, 'name')), enabled: field(s, 'enabled'), transport: url !== undefined ? `url=${JSON.stringify(url)}` : command !== undefined ? `command=${JSON.stringify(command)}` : undefined };
    }) : null;
  };
  const servers = list([]);
  if (!servers || servers.some((s) => s.name === undefined || s.transport === undefined)) return { ok: false, reason: "Codex couldn't list its MCP servers, so I can't turn them off for the review" };
  if (!servers.length) return { ok: true, config: [] };
  const config = ['-c', `mcp_servers={${servers.map((s) => `${JSON.stringify(s.name)}={${s.transport},enabled=false}`).join(',')}}`];
  const after = list(config);
  const left = after ? after.filter((s) => s.enabled !== false).map((s) => s.name) : null;
  if (!left || left.length) return { ok: false, reason: `Codex would still start MCP server${left?.length === 1 ? '' : 's'} ${left?.join(', ') ?? '(unlisted)'} in the review` };
  return { ok: true, config };
}

// The review process's Claude Code settings file. `hooks` are the Wizard's progress hooks, as in a program session.
export function reviewSettings(hooks: Record<string, unknown>): Record<string, unknown> {
  return {
    permissions: {
      deny: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__*', 'Agent'],
      disableBypassPermissionsMode: 'disable',
    },
    hooks,
  };
}

// Manual mode: what the developer pastes into their own agent and the few steps around it. The Wizard starts no process.
export interface Handoff {
  // Exactly what Auto would send as the first message.
  prompt: string;
  steps: string[];
}

// The command that puts a directory first on PATH, in the shell the developer has: PowerShell on Windows (a
// single-quoted literal, so nothing in the path expands), a POSIX shell elsewhere.
function prependPath(dir: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `$env:Path = '${dir.replace(/'/g, "''")};' + $env:Path` : `export PATH=${shellQuote(dir)}:$PATH`;
}

// `cliDir`: the bundled Straddle CLI's directory, which the developer puts first on PATH themselves, since I start nothing.
export function manualHandoff(req: Pick<LaunchRequest, 'client' | 'skill' | 'repo' | 'context'> & { cliDir: string | null; platform: NodeJS.Platform }): Handoff {
  const label = CLIENT_LABEL[req.client];
  const shell = req.platform === 'win32' ? 'PowerShell' : 'a shell';
  const path = req.cliDir ? ` Start it from ${shell} where you ran \`${prependPath(req.cliDir, req.platform)}\`, so the skills' \`straddle\` commands use the Wizard's Straddle CLI.` : '';
  return {
    prompt: startPrompt(req.client, req.skill, req.context),
    steps: [
      `Open ${req.repo} in ${label} with the Straddle plugin installed${req.client === 'cursor' ? ' from its team marketplace' : ''}.${path}`,
      `Paste this as your message to the ${label} agent:`,
      `Answer its questions there, and approve or deny each change and each Sandbox request. Nothing here counts as approval.`,
      "When it stops, run `wizard resume`: I read the files the skills wrote and tell you what to paste next.",
    ],
  };
}
