import { spawnSync } from 'node:child_process';
import type { Bundle } from './bundle.ts';
import { field, parseJson, text } from './json.ts';

export type ClientName = 'claude' | 'codex' | 'cursor';
export const CLIENT_NAMES: readonly ClientName[] = ['claude', 'codex', 'cursor'];
export const CLIENT_LABEL: Record<ClientName, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

export const API_MCP_URL = 'https://mcp.scalar.com/mcp/d5d1b1c2-ae5b-432d-b795-4fcb31cfdedd';
export const DOCS_MCP_URL = 'https://straddle-build-straddle-openapi.apidocumentation.com/mcp';
export const CONNECT_MCP_GUIDE = 'https://straddle-build-straddle-openapi.apidocumentation.com/connect-mcp';
const PLUGIN_ID = 'straddle@straddle';
const NATIVE_TIMEOUT_MS = 60_000;

// How the Wizard learns what happened inside a session. Only Claude Code exposes events it can read (hooks).
export const EVENT_SURFACE: Record<ClientName, 'observed' | 'unverified' | 'unsupported'> = { claude: 'observed', codex: 'unverified', cursor: 'unsupported' };
export const EVENT_SURFACE_NOTE: Record<ClientName, string> = {
  claude: 'step progress observed through Claude Code hooks',
  codex: 'step progress unverified: Codex exposes no session event the Wizard reads',
  cursor: 'manual handoff: Cursor automation is not supported',
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

function native(bin: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; out: string } {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { status: null, out: r.error.message };
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
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

export interface PluginState { state: 'installed' | 'missing' | 'unverified'; version: string | null }

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
export function claudeMarketplacePath(env: NodeJS.ProcessEnv): string | null {
  const markets = parseJson(native('claude', ['plugin', 'marketplace', 'list', '--json'], env).out);
  const market = Array.isArray(markets) ? markets.find((m) => field(m, 'name') === 'straddle') : undefined;
  return text(field(market, 'installLocation')) ?? text(field(market, 'path')) ?? null;
}

function inspectClaude(env: NodeJS.ProcessEnv, version: string): ClientState {
  const auth = native('claude', ['auth', 'status', '--json'], env);
  const loggedIn = field(parseJson(auth.out), 'loggedIn');
  const listed = parseJson(native('claude', ['plugin', 'list', '--json'], env).out);
  const entry = Array.isArray(listed) ? listed.find((p) => field(p, 'id') === PLUGIN_ID) : undefined;
  return {
    name: 'claude',
    label: CLIENT_LABEL.claude,
    version,
    loggedIn: typeof loggedIn === 'boolean' ? loggedIn : null,
    plugin: !Array.isArray(listed) ? { state: 'unverified', version: null } : entry ? { state: 'installed', version: text(field(entry, 'version')) ?? null } : { state: 'missing', version: null },
    marketplacePath: claudeMarketplacePath(env),
    apiMcp: entry
      ? 'declared by the Straddle plugin; Claude Code sends STRADDLE_API_KEY from the environment it starts in'
      : 'not declared (install the plugin, or `wizard mcp add --client claude`)',
  };
}

function inspectCodex(env: NodeJS.ProcessEnv, version: string): ClientState {
  const login = native('codex', ['login', 'status'], env);
  const listed = parseJson(native('codex', ['plugin', 'list', '--json'], env).out);
  const installed = field(listed, 'installed');
  const entry = Array.isArray(installed) ? installed.find((p) => field(p, 'pluginId') === PLUGIN_ID) : undefined;
  const servers = parseJson(native('codex', ['mcp', 'list', '--json'], env).out);
  const api = Array.isArray(servers) ? servers.find((s) => field(s, 'name') === 'straddle-api') : undefined;
  const bearer = text(field(field(api, 'transport'), 'bearer_token_env_var'));
  return {
    name: 'codex',
    label: CLIENT_LABEL.codex,
    version,
    loggedIn: login.status === 0,
    plugin: !Array.isArray(installed) ? { state: 'unverified', version: null } : entry ? { state: 'installed', version: text(field(entry, 'version')) ?? null } : { state: 'missing', version: null },
    marketplacePath: null,
    apiMcp: bearer
      ? `straddle-api reads ${bearer} (codex mcp)`
      : api
        ? 'registered without a credential: run `wizard mcp add --client codex` so straddle-api reads STRADDLE_API_KEY'
        : 'not registered',
  };
}

export function inspectClient(name: ClientName, env: NodeJS.ProcessEnv): ClientState {
  const probe = native(BINARY[name], ['--version'], env);
  const version = probe.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(probe.out)?.[1] ?? probe.out) : null;
  if (version === null || name === 'cursor') {
    return { name, label: CLIENT_LABEL[name], version, loggedIn: null, plugin: { state: name === 'cursor' ? 'unverified' : 'missing', version: null }, marketplacePath: null, apiMcp: 'unverified' };
  }
  return name === 'claude' ? inspectClaude(env, version) : inspectCodex(env, version);
}

export type ConfigPlan = { kind: 'commands'; commands: Command[]; note: string } | { kind: 'manual'; steps: string[] } | { kind: 'nothing'; note: string };

const cursorPluginSteps = (bundle: Bundle | null) => [
  'Cursor automation is not supported by the Wizard; do this in Cursor:',
  `Import ${bundle ? bundle.path : 'the straddle-build/skills repository'} as a team marketplace and install the "straddle" plugin.`,
  'Enter your Straddle API key when Cursor prompts for STRADDLE_API_KEY. Never paste it into the Wizard.',
];

export function installPlan(state: ClientState, bundle: Bundle): ConfigPlan {
  if (state.name === 'cursor') return { kind: 'manual', steps: cursorPluginSteps(bundle) };
  if (state.name === 'claude') {
    if (state.marketplacePath && state.marketplacePath !== bundle.path) {
      return { kind: 'manual', steps: [`Claude Code already has a marketplace named "straddle" at ${state.marketplacePath}. The Wizard does not replace it. Remove it with \`claude plugin marketplace remove straddle\` if it is stale, then run \`wizard install\` again.`] };
    }
    const commands: Command[] = [];
    if (!state.marketplacePath) commands.push({ bin: 'claude', args: ['plugin', 'marketplace', 'add', bundle.path] });
    commands.push({ bin: 'claude', args: ['plugin', 'install', PLUGIN_ID] });
    return { kind: 'commands', commands, note: 'User scope. Other plugins, marketplaces and MCP servers stay as they are.' };
  }
  return {
    kind: 'commands',
    commands: [
      { bin: 'codex', args: ['plugin', 'marketplace', 'add', bundle.path] },
      { bin: 'codex', args: ['plugin', 'add', PLUGIN_ID] },
      { bin: 'codex', args: ['mcp', 'add', 'straddle-api', '--url', API_MCP_URL, '--bearer-token-env-var', 'STRADDLE_API_KEY'] },
    ],
    note: 'The last command lets straddle-api read STRADDLE_API_KEY from the environment Codex starts in; the plugin alone cannot carry a credential. Other plugins and MCP servers stay as they are.',
  };
}

export function updatePlan(state: ClientState, bundle: Bundle): ConfigPlan {
  if (state.name === 'cursor') return { kind: 'manual', steps: ['Update the "straddle" plugin from its team marketplace in Cursor.'] };
  if (state.name === 'claude') {
    return { kind: 'commands', commands: [{ bin: 'claude', args: ['plugin', 'marketplace', 'update', 'straddle'] }, { bin: 'claude', args: ['plugin', 'update', PLUGIN_ID] }], note: 'Restart Claude Code sessions to load the update.' };
  }
  // Codex refreshes only Git marketplaces; adding again copies the pinned local bundle into its cache.
  return { kind: 'commands', commands: [{ bin: 'codex', args: ['plugin', 'add', PLUGIN_ID] }], note: `Codex has no update for local marketplaces; adding the plugin again copies ${bundle.path} into its cache.` };
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
        'Cursor MCP configuration is manual and not verified by the Wizard. Add these servers in Cursor (Settings > MCP) or merge them into ~/.cursor/mcp.json:',
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
  pluginDir: string | null;
}

// The skill is invoked by name; everything the skill does comes from the versioned bundle.
export function launchCommand(req: LaunchRequest): Command {
  if (req.client === 'claude') {
    const prompt = [`/straddle:${req.skill}`, req.context].filter(Boolean).join(' ');
    return { bin: 'claude', args: ['--settings', req.settingsPath, ...(req.pluginDir ? ['--plugin-dir', req.pluginDir] : []), prompt] };
  }
  return { bin: 'codex', args: ['-C', req.repo, [`Use the ${req.skill} skill.`, req.context].filter(Boolean).join(' ')] };
}
