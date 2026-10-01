import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  cursor: "manual: you run the skills in Cursor, and I read the files they write",
};

// Cursor has no supported command-line agent the Wizard drives, so it is always a manual handoff.
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

// `bundle`: the bundle the Wizard is using, which an installed plugin must match to count as verified.
export function inspectClient(name: ClientName, env: NodeJS.ProcessEnv, bundle: Bundle | null = null): ClientState {
  const probe = native(BINARY[name], ['--version'], env);
  const version = probe.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(probe.stdout)?.[1] ?? probe.stdout) : null;
  if (version === null || name === 'cursor') {
    return { name, label: CLIENT_LABEL[name], version, loggedIn: null, plugin: { state: name === 'cursor' ? 'unverified' : 'missing', version: null, verified: false }, marketplacePath: null, apiMcp: 'unverified' };
  }
  return name === 'claude' ? inspectClaude(env, version, bundle) : inspectCodex(env, version, bundle);
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
        "I don't configure or check Cursor's MCP servers. Add these in Cursor (Settings > MCP), or merge them into ~/.cursor/mcp.json:",
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
  client: 'claude' | 'codex';
  skill: string;
  repo: string;
  context: string;
  settingsPath: string;
  // The verified bundle directory.
  pluginDir: string;
  // The native session to reopen, or null for a new one.
  resume: string | null;
}

// The skill is invoked by name on the first line; the context follows on its own lines, so its `Straddle Wizard
// program:` line begins a line, as wizard-program.md says. Everything the skill does comes from the versioned bundle.
// The agent runs with the developer's own settings, permission mode, sandbox and approval policy; the Wizard never
// changes them. Claude Code merges `--settings` with them and adds its hooks to theirs.
export function launchCommand(req: LaunchRequest): Command {
  if (req.client === 'claude') {
    const prompt = [`/straddle:${req.skill}`, req.context].filter(Boolean).join('\n');
    return { bin: 'claude', args: ['--settings', req.settingsPath, '--plugin-dir', req.pluginDir, ...(req.resume ? ['--resume', req.resume] : []), prompt] };
  }
  const prompt = [`Use the ${req.skill} skill.`, req.context].filter(Boolean).join('\n');
  return { bin: 'codex', args: [...(req.resume ? ['resume'] : []), '-C', req.repo, ...(req.resume ? [req.resume] : []), prompt] };
}
