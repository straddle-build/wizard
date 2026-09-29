// Guided journey through the real CLI, with Claude Code replaced by a scripted process (tests/fixtures/fake-claude.mjs).
// This is simulated-adapter evidence. Native client proof is recorded separately.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SKILLS_SOURCE, fakeClaude, nextRepo, readReceipt, runWizard, tempDir, writeFiles } from './helpers.ts';

const CONFIGURED = { STRADDLE_API_KEY: 'sk_test_value_in_test_env', STRADDLE_ENVIRONMENT: 'sandbox' };
const PLAN = '# Straddle integration plan\n\n## Status\n\n- Plan state: Draft\n\n## File changes\n\n| File | Change |\n| --- | --- |\n| src/straddle.ts | add client |\n\n## Future Sandbox writes\n\n| Write | Tool |\n| --- | --- |\n| create customer | SDK |\n\n## Verification\n';

const handoff = (skill: string, status: string, checklist: string[]) =>
  [...checklist.length ? ['## Verify before merging', '', ...checklist, ''] : [], `STRADDLE_HANDOFF {"skill":"${skill}","status":"${status}","report":"${skill} ${status}"}`].join('\n');

const DEFAULT_SESSIONS = {
  'straddle-setup': { steps: ['01-begin', '02-repository', '03-cli-and-context', '04-mcp', '05-report'], text: handoff('straddle-setup', 'ready_with_warnings', ['- [ ] The environment is Sandbox.']) },
  'straddle-plan': {
    steps: ['01-decisions', '02-sources', '03-write-plan', '04-review', '05-handoff'],
    writes: [{ path: 'src/early.ts', content: 'too early' }, { path: 'straddle-integration-plan.md', content: PLAN }],
    text: handoff('straddle-plan', 'draft', ['- [ ] No secret appears in the plan.']),
  },
  'straddle-integrate': {
    steps: ['01-begin', '02-sources', '03-code', '04-preview', '05-execute', '06-review', '07-handoff'],
    writes: [{ path: 'src/straddle.ts', content: 'export {}' }],
    text: handoff('straddle-integrate', 'complete', ['- [ ] Only the approved files changed, and existing provider code is intact.']),
  },
  'straddle-test': {
    steps: ['01-begin', '02-offline', '03-preview', '04-sandbox', '05-verify', '06-evidence'],
    writes: [{ path: 'straddle-test-evidence.md', content: '# evidence' }],
    text: handoff('straddle-test', 'partial', ['- [ ] Evidence names only scenarios that ran.']),
  },
};

// Continue, charges, marketplace, suggested SDK, webhook endpoint, Claude Code.
const CHOOSE_CONTEXT = ['1', '1', '3', '', '1', '1'];

test('cancel on the first screen stops before anything is saved', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  const r = await runWizard([], { cwd: repo, claude, input: ['4'] });

  assert.equal(r.code, 130);
  assert.match(r.stdout, /Directory\s+.*wizard-repo-/);
  assert.match(r.stdout, /Language\s+TypeScript \(detected: package\.json, tsconfig\.json\)/);
  assert.match(r.stdout, /Cancelled\. Nothing was saved or changed\./);
  assert.equal(existsSync(join(repo, '.straddle-wizard')), false);
});

test('privacy screen shows the source boundary before any agent work', async () => {
  const repo = nextRepo();
  writeFiles(repo, { '.env': 'x' });

  const r = await runWizard([], { cwd: repo, claude: fakeClaude(), input: ['3', '4'] });

  assert.match(r.stdout, /Skipped without opening: \.env \(environment file\)/);
  assert.match(r.stdout, /The Wizard sends nothing to Straddle/);
});

test('detected context is a suggestion the developer corrects, and the SDK suggestion follows the correction', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  // Change > Language > Python, Continue, charges, direct, accept suggested SDK, polling endpoint, then Cancel at client choice.
  const r = await runWizard([], { cwd: repo, claude, input: ['2', '1', '3', '1', '1', '1', '', '3', '3'] });

  assert.equal(r.code, 130);
  assert.match(r.stdout, /Language\s+Python \(you\)/);
  assert.match(r.stdout, /Which Straddle SDK\? \(suggested: Python\)/);
  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'aborted');
  assert.deepEqual(receipt.context.language, { value: 'Python', source: 'developer' });
  assert.deepEqual(receipt.context.choices, { products: 'charges', integrationType: 'direct', sdk: 'Python', notificationPath: 'polling endpoint' });
});

// Maps the public skills URL to the local pinned checkout with Git's own url.<base>.insteadOf, so the real fetch runs offline.
const OFFLINE_GITHUB = (cache: string) => ({
  STRADDLE_WIZARD_BUNDLE: '', XDG_CACHE_HOME: cache,
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${SKILLS_SOURCE}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/straddle-build/skills.git',
});

test('first run without a bundle previews the snapshot fetch, and cancelling it fetches nothing', async () => {
  const repo = nextRepo();
  const cache = tempDir('cache');
  const claude = fakeClaude();
  claude.setState({ installed: true });

  const r = await runWizard([], { cwd: repo, claude, env: { ...CONFIGURED, ...OFFLINE_GITHUB(cache) }, input: [...CHOOSE_CONTEXT, '2'] });

  assert.equal(r.code, 130, r.stdout + r.stderr);
  assert.match(r.stdout, /merged-source snapshot straddle-build\/skills@f713fc6 \(plugin 0\.1\.0; not a tagged release\)/);
  assert.match(r.stdout, /git -C \S+ fetch --depth 1 https:\/\/github\.com\/straddle-build\/skills\.git f713fc6201ad0fd800d23a3ec4c4102b7acee91c/);
  assert.deepEqual(readdirSync(cache), []);
  assert.equal(readReceipt(repo).state, 'aborted');
});

test('first run fetches the pinned snapshot after confirmation, verifies it, and later runs reuse it without asking', async () => {
  const repo = nextRepo();
  const cache = tempDir('cache');
  const claude = fakeClaude();
  claude.setState({ installed: true });
  claude.sessions(DEFAULT_SESSIONS);
  const env = { ...CONFIGURED, ...OFFLINE_GITHUB(cache) };

  const first = await runWizard(['setup'], { cwd: repo, claude, env, input: [...CHOOSE_CONTEXT, '1', '1'] });
  const status = await runWizard(['status', '--json'], { cwd: repo, claude, env });

  assert.equal(first.code, 0, first.stdout + first.stderr);
  const snapshot = join(cache, 'straddle-wizard', 'skills-f713fc6201ad0fd800d23a3ec4c4102b7acee91c');
  assert.equal(readReceipt(repo).bundle.path, snapshot);
  assert.match(first.stdout, /Skill bundle\s+merged-source snapshot straddle-build\/skills@f713fc6 .*verified/);
  assert.equal(JSON.parse(status.stdout).bundle.path, snapshot);
  assert.doesNotMatch(status.stdout, /fetch/);
});

test('--client picks the agent for a guided run instead of asking', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  // Continue, charges, marketplace, suggested SDK, webhook; no agent question; then "not run yet" at the Cursor handoff.
  const r = await runWizard(['plan', '--client', 'cursor'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '3', '', '1', '3'] });

  assert.doesNotMatch(r.stdout, /Which coding agent should do the work\?/);
  assert.equal(readReceipt(repo).client, 'cursor');
});

test('default journey: isolated sessions from the verified bundle, plan before edits, observed progress separate from reported handoffs, final report', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(DEFAULT_SESSIONS);

  const r = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1', '1', '1', '1'] });

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Straddle plugin\s+loaded into each Wizard session from the verified snapshot/);
  assert.doesNotMatch(r.stdout, /claude plugin install/);
  assert.match(r.stdout, /Choosing Start is not approval/);
  assert.match(r.stdout, /Observed \(Claude Code hooks\): entered 01-decisions, 02-sources, 03-write-plan, 04-review, 05-handoff/);
  assert.match(r.stdout, /Reported by the agent \(not verified by the Wizard\): handoff draft/);
  assert.match(r.stdout, /Blocked edit before the plan existed: src\/early\.ts/);
  assert.match(r.stdout, /Plan: straddle-integration-plan\.md \(Plan state: Draft\)/);
  assert.match(r.stdout, /\| src\/straddle\.ts \| add client \|/);
  assert.match(r.stdout, /Changed files \(observed by the Wizard\)\n\s+src\/straddle\.ts\n\s+straddle-integration-plan\.md\n\s+straddle-test-evidence\.md/);
  assert.match(r.stdout, /Verify before merging \(printed by the agent for straddle-test\)\n\s+- \[ \] Evidence names only scenarios that ran\./);
  assert.equal(existsSync(join(repo, 'src', 'early.ts')), false);

  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.client, 'claude');
  assert.equal(receipt.bundle.commit, 'f713fc6201ad0fd800d23a3ec4c4102b7acee91c');
  assert.deepEqual(receipt.steps.map((s) => [s.skill, s.reportedMarkers.at(-1)?.status]), [
    ['straddle-setup', 'ready_with_warnings'], ['straddle-plan', 'draft'], ['straddle-integrate', 'complete'], ['straddle-test', 'partial'],
  ]);
  assert.ok(!JSON.stringify(receipt).includes('sk_test_value_in_test_env'), 'receipt never stores the key');

  const launches = claude.calls().filter((c) => c.includes('--settings')).map((c) => JSON.parse(c) as string[]);
  assert.deepEqual(launches.map((a) => a.at(-1)?.split(' ')[0]), ['/straddle:straddle-setup', '/straddle:straddle-plan', '/straddle:straddle-integrate', '/straddle:straddle-test']);
  for (const args of launches) {
    assert.ok(!args.some((a) => /--resume|--continue|dangerously|bypass|--permission-mode/.test(a)), `native approvals stay interactive: ${args}`);
    // The developer's allow rules, hooks, plugins and auto or accept-edits default never approve a Wizard step's tool calls.
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.equal(args[args.indexOf('--plugin-dir') + 1], SKILLS_SOURCE);
    const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1]!, 'utf8'));
    assert.equal(settings.permissions?.defaultMode, 'default');
  }
});

test('Integrate never starts before the durable plan exists', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1', '', '1', '1'] });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /Integrate needs straddle-integration-plan\.md\. Run `wizard plan` first/);
  assert.equal(claude.calls().filter((c) => c.includes('--settings')).length, 0);
  assert.equal(readReceipt(repo).state, 'blocked');
});

test('an edit the developer denies in the agent is not reported as a change, and the step stays blocked', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({ 'straddle-integrate': {
    steps: ['01-begin', '02-sources', '03-code'], denied: ['03-code', 'src/straddle.ts'],
    writes: [{ path: 'src/straddle.ts', content: 'export {}' }], text: handoff('straddle-integrate', 'blocked', []),
  } });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1'] });

  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /Observed \(Claude Code hooks\): entered 01-begin, 02-sources\n/);
  assert.match(r.stdout, /Files changed: none/);
  assert.equal(existsSync(join(repo, 'src', 'straddle.ts')), false);
  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'blocked');
  assert.match(receipt.stateReason, /Integrate reported blocked/);
  assert.deepEqual(receipt.steps[0]?.observedEvents.filter((e) => e.kind === 'edit'), []);
});

test('a missing key or environment is an explicit configuration error before any Straddle-request step', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });

  const r = await runWizard(['test'], { cwd: repo, claude, env: { STRADDLE_ENVIRONMENT: 'production' }, input: ['1', '1'] });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /Configuration error: STRADDLE_API_KEY is not set; STRADDLE_ENVIRONMENT is production, not sandbox\./);
  assert.match(r.stdout, /zero Straddle requests/);
  assert.equal(claude.calls().filter((c) => c.includes('--settings')).length, 0);
  assert.match(readReceipt(repo).stateReason, /configuration error/);
});

test('Integrate stops with a configuration error when credentials are missing', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: {}, input: ['1', '1'] });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /Configuration error: STRADDLE_API_KEY is not set/);
  assert.match(r.stdout, /zero Straddle requests/);
  assert.equal(claude.calls().filter((c) => c.includes('--settings')).length, 0);
  assert.match(readReceipt(repo).stateReason, /configuration error/);
});

test('client login loss blocks the handoff with a repair, and resume rechecks it without reusing any approval', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true, loggedIn: false });
  claude.sessions(DEFAULT_SESSIONS);

  const first = await runWizard(['setup'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '2'] });

  assert.equal(first.code, 1);
  assert.match(first.stdout, /Claude Code is not logged in\. Run `claude auth login` in your terminal/);
  assert.equal(readReceipt(repo).state, 'blocked');

  claude.setState({ loggedIn: true });
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(resumed.code, 0, resumed.stdout);
  assert.match(resumed.stdout, /Saved run: setup program, blocked/);
  assert.match(resumed.stdout, /Choices\s+charges, marketplace, TypeScript, webhook endpoint/);
  assert.match(resumed.stdout, /Approvals from earlier sessions do not carry over/);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('an interrupted agent session is recorded as aborted with preserved work, and resume re-enters that step fresh', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({ ...DEFAULT_SESSIONS, 'straddle-plan': { steps: ['01-decisions'], text: '', signal: 'SIGTERM' } });

  const first = await runWizard(['plan'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });

  assert.equal(first.code, 130);
  assert.match(first.stdout, /Claude Code ended by signal SIGTERM before the skill's handoff/);
  assert.match(first.stdout, /Nothing is rolled back/);
  const aborted = readReceipt(repo);
  assert.equal(aborted.state, 'aborted');
  assert.deepEqual(aborted.steps[0]?.observedSteps, ['01-decisions']);

  claude.sessions(DEFAULT_SESSIONS);
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(resumed.code, 0, resumed.stdout);
  const launches = claude.calls().filter((c) => c.includes('/straddle:straddle-plan'));
  assert.equal(launches.length, 2);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('a corrupted receipt is reported on resume and left untouched', async () => {
  const repo = nextRepo();
  writeFiles(repo, { '.straddle-wizard/receipt.json': '{broken' });

  const r = await runWizard(['resume'], { cwd: repo, claude: fakeClaude() });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /The saved Wizard receipt is unreadable/);
  assert.equal(readFileSync(join(repo, '.straddle-wizard', 'receipt.json'), 'utf8'), '{broken');
});

test('wizard audit runs straddle-audit and prints the findings table from its report', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  const report = '# Straddle audit\n\nStatus: findings\n\n## Findings\n| # | File:line | Category | Finding | Confidence | Evidence (SDK / contract) | Recovery |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | src/pay.ts:12 | idempotency | create without key | high | sdk | add key |\n\n## Checked and dismissed\n';
  claude.sessions({ 'straddle-audit': { steps: ['01-begin', '05-report'], writes: [{ path: 'straddle-audit-report.md', content: report }], text: handoff('straddle-audit', 'findings', []) } });

  const r = await runWizard(['audit'], { cwd: repo, claude, input: ['1', '1', '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Findings \(straddle-audit-report\.md\)\n.*\n.*\n\s+\| 1 \| src\/pay\.ts:12 \| idempotency \| create without key \| high \|/);
});

test('wizard skill run <name> launches that versioned skill in the chosen agent', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({ 'straddle-go-live': { steps: ['01-begin'], text: handoff('straddle-go-live', 'not_ready', []) } });

  const r = await runWizard(['skill', 'run', 'straddle-go-live'], { cwd: repo, claude, input: ['1', '1', '1'] });

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Step 1 of 1: Go Live \(straddle-go-live /);
  assert.deepEqual(claude.calls().filter((c) => c.includes('--settings')).map((c) => (JSON.parse(c) as string[]).at(-1)), ['/straddle:straddle-go-live']);
  assert.equal(readReceipt(repo).program, 'skill:straddle-go-live');
});

test('unknown command exits with usage error', async () => {
  const r = await runWizard(['diagnose'], { cwd: nextRepo() });

  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "diagnose"\./);
});

test('install, status, update and remove use native plugin commands and report deterministic results', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  const install = await runWizard(['install', '--client', 'claude', '--yes'], { cwd: repo, claude });
  const status = await runWizard(['status', '--json'], { cwd: repo, claude });
  const update = await runWizard(['update', '--client', 'claude', '--yes'], { cwd: repo, claude });
  const remove = await runWizard(['remove', '--client', 'claude', '--yes'], { cwd: repo, claude });
  const after = await runWizard(['status', '--json'], { cwd: repo, claude });

  assert.equal(install.code, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /ok\s+claude plugin install straddle@straddle/);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.bundle.commit, 'f713fc6201ad0fd800d23a3ec4c4102b7acee91c');
  assert.deepEqual(parsed.clients.find((c: { name: string }) => c.name === 'claude').plugin, { state: 'installed', version: '0.1.0' });
  assert.deepEqual(parsed.clients.find((c: { name: string }) => c.name === 'cursor').plugin, { state: 'unverified', version: null });
  assert.equal(parsed.credentials.STRADDLE_API_KEY, 'missing');
  assert.equal(update.code, 0);
  assert.match(update.stdout, /ok\s+claude plugin update straddle@straddle/);
  assert.equal(remove.code, 0);
  assert.equal(JSON.parse(after.stdout).clients.find((c: { name: string }) => c.name === 'claude').plugin.state, 'missing');
});

test('mcp add registers only Straddle servers through native commands and skips what the plugin already declares', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  const add = await runWizard(['mcp', 'add', '--client', 'claude', '--yes'], { cwd: repo, claude });
  const again = await runWizard(['mcp', 'add', '--client', 'claude', '--yes'], { cwd: repo, claude });
  const remove = await runWizard(['mcp', 'remove', '--client', 'claude', '--yes'], { cwd: repo, claude });
  claude.setState({ installed: true });
  const withPlugin = await runWizard(['mcp', 'add', '--client', 'claude', '--yes'], { cwd: repo, claude });

  assert.match(add.stdout, /ok\s+claude mcp add --transport http -s user straddle-api https:\/\/mcp\.scalar\.com\/mcp\/d5d1b1c2-ae5b-432d-b795-4fcb31cfdedd -H 'Authorization: Bearer \$\{STRADDLE_API_KEY\}'/);
  assert.match(add.stdout, /ok\s+claude mcp add --transport http -s user straddle-docs https:\/\/straddle-build-straddle-openapi\.apidocumentation\.com\/mcp/);
  assert.match(again.stdout, /already\s+claude mcp add .* straddle-api/);
  assert.match(remove.stdout, /ok\s+claude mcp remove -s user straddle-api/);
  assert.match(withPlugin.stdout, /The Straddle plugin already declares straddle-api and straddle-docs in Claude Code/);
  const state = JSON.parse(readFileSync(join(claude.state, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.mcp), []);
});

test('Cursor gets a labelled manual handoff, never fake progress', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  // Continue, charges, marketplace, suggested SDK, webhook, Cursor.
  const r = await runWizard(['plan'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '3', '', '1', '2'] });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /Cursor automation is not supported by the Wizard\. Manual handoff:/);
  assert.match(r.stdout, /Use the straddle-plan skill/);
  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.steps[0]?.eventSurface, 'unsupported');
  assert.deepEqual(receipt.steps[0]?.observedSteps, []);
});

test('receipt removal is configuration loss the next run reports as a fresh start', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  await runWizard([], { cwd: repo, claude, input: ['1', '1', '3', '', '1', '3'] });
  rmSync(join(repo, '.straddle-wizard'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'x');

  const r = await runWizard(['resume'], { cwd: repo, claude });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /No saved Wizard run in this repository\. Start one with `wizard`\./);
});
