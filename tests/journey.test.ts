// Guided journey through the real CLI, with Claude Code replaced by a scripted process (tests/fixtures/fake-claude.mjs).
// This is simulated-adapter evidence. Native client proof is recorded separately.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalHash } from '../src/progress.ts';
import { ROOT, SKILLS_SOURCE, fakeClaude, nextRepo, readReceipt, releaseServer, runWizard, tempDir, writeFiles, type FakeClaude, type ReleaseServer } from './helpers.ts';

const CONFIGURED = { STRADDLE_API_KEY: 'sk_test_value_in_test_env', STRADDLE_ENVIRONMENT: 'sandbox' };
const PLAN = '# Straddle integration plan\n\n## Status\n\n- Plan state: Draft\n- Approval: none\n\n## File changes\n\n| File | Change |\n| --- | --- |\n| src/straddle.ts | add client |\n\n## Future Sandbox writes\n\n| Write | Tool |\n| --- | --- |\n| create customer | SDK |\n\n## Verification\n';
const APPROVED_PLAN = PLAN.replace('- Plan state: Draft', '- Plan state: Approved')
  .replace('- Approval: none', `- Approval: 2026-09-30, "approved", recorded by straddle-plan, sha256 ${approvalHash(PLAN)}`);
const PLAN_HASH = approvalHash(APPROVED_PLAN);
const CHARGE = '0b6f3c0e-8a51-4c6f-9d0e-5b1f2a3c4d5e';
const SETUP_FILE = '# Straddle setup\n\nStatus: complete\nEnvironment: sandbox\nIntegration type: marketplace\nAPI key present: yes\nSDK: TypeScript\nActing account: platform\n';
const report = (status: string) => `# Straddle integration report\n\nStatus: ${status}\nPlan: straddle-integration-plan.md\nPlan hash: ${PLAN_HASH}\n\n## Changed files\n`;
const EVIDENCE = `# Straddle test evidence\n\nStatus: complete\nPlan: straddle-integration-plan.md\nPlan hash: ${PLAN_HASH}\nLatest run: r1\nTest charge: ${CHARGE}\n\n## Run r1, 2026-09-30\n\n- Status: passed\n`;

const handoff = (skill: string, status: string, checklist: string[] = []) =>
  [...checklist.length ? ['## Verify before merging', '', ...checklist, ''] : [], `STRADDLE_HANDOFF {"skill":"${skill}","status":"${status}","report":"${skill} ${status}"}`].join('\n');

const DEFAULT_SESSIONS = {
  'straddle-setup': {
    steps: ['01-begin', '02-repository', '03-cli-and-context', '04-mcp', '05-report'],
    writes: [{ path: 'straddle-setup.md', content: SETUP_FILE }],
    text: handoff('straddle-setup', 'ready_with_warnings', ['- [ ] The environment is Sandbox.']),
    // Like the real Setup (05-report.md): a missing key blocks it.
    withoutKey: {
      steps: ['01-begin', '02-repository', '03-cli-and-context', '04-mcp', '05-report'],
      writes: [{ path: 'straddle-setup.md', content: SETUP_FILE.replace('Status: complete', 'Status: blocked (STRADDLE_API_KEY not set)') }],
      text: handoff('straddle-setup', 'blocked'),
    },
  },
  'straddle-plan': {
    steps: ['01-decisions', '02-sources', '03-write-plan', '04-review', '05-handoff', '06-show-me'],
    writes: [{ path: 'src/early.ts', content: 'too early' }, { path: 'straddle-integration-plan.md', content: APPROVED_PLAN }],
    text: `${handoff('straddle-plan', 'draft', ['- [ ] No secret appears in the plan.'])}\nSTRADDLE_PROGRESS {"skill":"straddle-plan","step":"06-show-me"}`,
  },
  'straddle-integrate': {
    steps: ['01-begin', '02-sources', '03-code', '04-preview', '05-execute', '06-review', '07-handoff'],
    writes: [{ path: 'src/straddle.ts', content: 'export {}' }, { path: 'straddle-integration-report.md', content: report('complete') }],
    text: handoff('straddle-integrate', 'complete', ['- [ ] Only the approved files changed, and existing provider code is intact.']),
  },
  'straddle-test': {
    steps: ['01-begin', '02-offline', '03-preview', '04-sandbox', '05-verify', '06-evidence'],
    writes: [{ path: 'straddle-test-evidence.md', content: EVIDENCE }],
    text: handoff('straddle-test', 'passed', ['- [ ] Evidence names only scenarios that ran.']),
  },
  'straddle-go-live': {
    steps: ['01-begin', '02-configuration', '03-code', '04-sandbox-evidence', '05-production-setup', '06-report'],
    writes: [{ path: 'straddle-go-live-report.md', content: `# Straddle Go Live review\n\nStatus: ready\nPlan: straddle-integration-plan.md\nPlan hash: ${PLAN_HASH}\nResult: ready\n` }],
    text: handoff('straddle-go-live', 'ready'),
  },
};
const PROGRAM_LINE = 'Straddle Wizard program: straddle-setup → straddle-plan → straddle-integrate → straddle-test → straddle-go-live. Start at straddle-setup.';
// wizard-program.md's rule for a session the Wizard reopens: earlier previews and yeses are back in its context.
const REOPENED = "This session was reopened by the Straddle Wizard. Approvals given before this message don't count: show every Sandbox write preview again and ask; a plan approval counts only as recorded in the plan file.";

// Continue, charges, marketplace, suggested SDK, webhook endpoint, Claude Code.
const CHOOSE_CONTEXT = ['1', '1', '3', '', '1', '1'];

const launches = (claude: FakeClaude) => claude.calls().filter((c) => c.includes('--settings')).map((c) => JSON.parse(c) as string[]);
// Status lines with step counts masked, since the bundle decides how many step files each skill has.
const statusLines = (claude: FakeClaude) => claude.statusLines().map((l) => l.replace(/▶ (\d+)\/\d+/g, '▶ $1/n'));

test('cancel on the first screen stops before anything is saved', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  const r = await runWizard([], { cwd: repo, claude, input: ['4'] });

  assert.equal(r.code, 130);
  assert.match(r.stdout, /Directory\s+.*wizard-repo-/);
  assert.match(r.stdout, /Language\s+TypeScript \(detected: package\.json, tsconfig\.json\)/);
  assert.match(r.stdout, /Program\s+Setup → Plan → Integrate → Test → Go Live\n/);
  assert.match(r.stdout, /Cancelled\. I haven't saved or changed anything\./);
  assert.equal(existsSync(join(repo, '.straddle-wizard')), false);
});

test('privacy screen shows the source boundary before any agent work', async () => {
  const repo = nextRepo();
  writeFiles(repo, { '.env': 'x' });

  const r = await runWizard([], { cwd: repo, claude: fakeClaude(), input: ['3', '4'] });

  assert.match(r.stdout, /Skipped without opening: \.env \(environment file\)/);
  assert.match(r.stdout, /I send nothing to Straddle and host no model/);
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

// Plugin releases served from a local fixture server, so the real download and verification run offline.
const RELEASES = (cache: string, server: ReleaseServer) => ({ STRADDLE_WIZARD_BUNDLE: '', XDG_CACHE_HOME: cache, STRADDLE_WIZARD_RELEASES: server.url });

test('first run without a bundle previews the release download, and cancelling it downloads nothing', async () => {
  const repo = nextRepo();
  const cache = tempDir('cache');
  const claude = fakeClaude();
  claude.setState({ installed: true });
  const server = await releaseServer([{ tag: 'v0.1.0' }]);

  const r = await runWizard([], { cwd: repo, claude, env: { ...CONFIGURED, ...RELEASES(cache, server) }, input: [...CHOOSE_CONTEXT, '2'] });
  await server.close();

  assert.equal(r.code, 130, r.stdout + r.stderr);
  assert.match(r.stdout, /The newest 0\.1\.x plugin release is v0\.1\.0/);
  assert.match(r.stdout, /GET http:\/\/127\.0\.0\.1:\d+\/v0\.1\.0\/straddle-plugin-0\.1\.0\.zip/);
  assert.deepEqual(server.requests, ['/releases']);
  assert.deepEqual(readdirSync(cache), []);
  assert.equal(readReceipt(repo).state, 'aborted');
});

test('first run downloads the newest release after confirmation, verifies it, and later runs reuse it without asking', async () => {
  const repo = nextRepo();
  const cache = tempDir('cache');
  const claude = fakeClaude();
  claude.setState({ installed: true });
  claude.sessions(DEFAULT_SESSIONS);
  const server = await releaseServer([{ tag: 'v0.1.0' }]);
  const env = { ...CONFIGURED, ...RELEASES(cache, server) };

  const first = await runWizard(['setup'], { cwd: repo, claude, env, input: [...CHOOSE_CONTEXT, '1', '1'] });
  const status = await runWizard(['status', '--json'], { cwd: repo, claude, env });
  const list = await runWizard(['skill', 'list'], { cwd: repo, claude, env });
  await server.close();

  assert.equal(first.code, 0, first.stdout + first.stderr);
  const release = join(cache, 'straddle-wizard', 'plugin');
  assert.equal(readReceipt(repo).bundle?.path, release);
  assert.match(first.stdout, /Skill bundle\s+plugin release v0\.1\.0 of straddle-build\/skills \(9 skills, verified against its published SHA256SUMS\)/);
  assert.equal(JSON.parse(status.stdout).bundle.path, release);
  assert.equal(list.code, 0, list.stdout);
  assert.doesNotMatch(list.stdout, /Download/);
  assert.deepEqual(server.requests.filter((path) => path.endsWith('.zip')), ['/v0.1.0/straddle-plugin-0.1.0.zip']);
});

test('--client picks the agent for a guided run instead of asking', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  // Continue, charges, marketplace, suggested SDK, webhook; no agent question; then stop at the Cursor handoff.
  const r = await runWizard(['plan', '--client', 'cursor'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '3', '', '1', '2'] });

  assert.doesNotMatch(r.stdout, /Which coding agent should do the work\?/);
  assert.equal(readReceipt(repo).client, 'cursor');
});

test('default journey: one isolated agent session walks the whole program, with a live checklist that ticks only what is on file and reported', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(DEFAULT_SESSIONS);

  const r = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });
  const status = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, claude, env: CONFIGURED })).stdout);

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Straddle plugin\s+loaded into the Wizard's session from that bundle/);
  assert.doesNotMatch(r.stdout, /claude plugin install/);
  assert.match(r.stdout, /Your session in Claude Code: Setup → Plan → Integrate → Test → Go Live/);
  assert.match(r.stdout, /Starting isn't approval of anything\./);
  assert.match(r.stdout, /Blocked an edit before the plan existed: src\/early\.ts/);
  assert.match(r.stdout, /✓ Setup\s+straddle-setup\.md: Status: complete · reported ready_with_warnings · 5 of \d+ step files opened/);
  assert.match(r.stdout, /✓ Plan\s+straddle-integration-plan\.md: Plan state: Approved, and the plan is unchanged since · reported draft · 6 of \d+ step files opened/);
  assert.match(r.stdout, /✓ Test\s+straddle-test-evidence\.md: Status: complete, for the current approved plan · reported passed/);
  assert.match(r.stdout, /Changed files \(I compared them before and after each session\)\n\s+src\/straddle\.ts\n\s+straddle-go-live-report\.md\n\s+straddle-integration-plan\.md\n\s+straddle-integration-report\.md\n\s+straddle-setup\.md\n\s+straddle-test-evidence\.md\n/);
  assert.match(r.stdout, new RegExp(`Test charge\\s+https://dashboard\\.straddle\\.com/charges/${CHARGE}`));
  assert.match(r.stdout, /Turn on Sandbox in the dashboard if it opens in Production/);
  assert.match(r.stdout, /Verify before merging \(as your agent last printed it\)\n\s+- \[ \] Evidence names only scenarios that ran\./);
  assert.match(r.stdout, /That's the whole program/);
  assert.equal(existsSync(join(repo, 'src', 'early.ts')), false);

  // One launch, in isolated settings, naming the whole program.
  const [launch, ...others] = launches(claude);
  assert.equal(others.length, 0);
  // N1: the program line begins a line of its own, after the skill invocation.
  assert.ok(launch!.at(-1)!.startsWith(`/straddle:straddle-setup\n${PROGRAM_LINE}\n`), launch!.at(-1));
  assert.ok(!launch!.at(-1)!.includes(REOPENED), 'a new session has no earlier approvals to disown');
  assert.ok(!launch!.some((a) => /--resume|--continue|dangerously|bypass|--permission-mode/.test(a)), `native approvals stay interactive: ${launch}`);
  // The developer's allow rules, hooks, plugins and auto or accept-edits default never approve the session's tool calls.
  assert.equal(launch![launch!.indexOf('--setting-sources') + 1], '');
  assert.equal(launch![launch!.indexOf('--plugin-dir') + 1], SKILLS_SOURCE);
  const settings = JSON.parse(readFileSync(launch![launch!.indexOf('--settings') + 1]!, 'utf8'));
  assert.equal(settings.permissions?.defaultMode, 'default');
  assert.equal(settings.statusLine?.type, 'command');

  // The status line Claude Code showed at the start and after each step.
  assert.deepEqual(statusLines(claude), [
    'Straddle: Setup ▶ 0/n · Plan · Integrate · Test · Go Live',
    'Straddle: Setup ✓ · Plan ▶ 0/n · Integrate · Test · Go Live',
    'Straddle: Setup ✓ · Plan ✓ · Integrate ▶ 0/n · Test · Go Live',
    'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ▶ 0/n · Go Live',
    'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live ▶ 0/n',
    'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live ✓',
  ]);
  assert.equal(status.run.progress, 'Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live ✓');

  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.client, 'claude');
  assert.deepEqual([receipt.bundle?.kind, receipt.bundle?.pluginVersion, receipt.bundle?.path], ['local', '0.1.0', SKILLS_SOURCE]);
  assert.equal(receipt.sessions.length, 1);
  assert.match(receipt.sessions[0]!.sessionId ?? '', /^[0-9a-f-]{36}$/);
  const events = readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8');
  for (const secret of [JSON.stringify(receipt), events]) assert.ok(!secret.includes('sk_test_value_in_test_env'), 'no record holds the key');
});

test('interrupted mid-program: resume reopens the same session at the first unfinished step, from the files', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions({
    ...DEFAULT_SESSIONS,
    'straddle-integrate': { steps: ['01-begin', '02-sources', '03-code'], writes: [{ path: 'straddle-integration-report.md', content: report('partial (webhook route not written yet)') }], text: '', signal: 'SIGTERM' },
  });

  const first = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });
  const aborted = readReceipt(repo);
  claude.sessions(DEFAULT_SESSIONS);
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(first.code, 130, first.stdout);
  assert.match(first.stdout, /Claude Code ended by signal SIGTERM during Integrate\./);
  assert.match(first.stdout, /Nothing is rolled back/);
  assert.match(first.stdout, /Integrate\s+straddle-integration-report\.md: Status: partial \(webhook route not written yet\) · no handoff reported · 3 of/);
  assert.equal(aborted.state, 'aborted');
  assert.equal(statusLines(claude).find((l) => l.includes('Integrate ▶ 3/n')), 'Straddle: Setup ✓ · Plan ✓ · Integrate ▶ 3/n · Test · Go Live');

  assert.equal(resumed.code, 0, resumed.stdout);
  assert.match(resumed.stdout, /Resume at Integrate/);
  const [, second] = launches(claude);
  assert.equal(second![second!.indexOf('--resume') + 1], aborted.sessions[0]!.sessionId);
  const prompt = second!.at(-1)!;
  assert.ok(prompt.startsWith('/straddle:straddle-integrate\nStraddle Wizard program: straddle-integrate → straddle-test → straddle-go-live. Start at straddle-integrate.\n'), prompt);
  // F: the reopened conversation still holds the earlier previews and yeses, so the agent is told they don't count.
  assert.equal(prompt.split('\n')[3], REOPENED);
  assert.match(resumed.stdout, /I'm reopening your earlier session, so I tell your agent that approvals from before don't count/);
  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.sessions.length, 2);
  assert.equal(statusLines(claude).at(-1), 'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live ✓');
});

test('resume never replays a finished step: with Setup blocked and later steps done, the session lists Setup and only the unfinished steps after it', async () => {
  const repo = nextRepo();
  writeFiles(repo, {
    'straddle-setup.md': SETUP_FILE.replace('Status: complete', 'Status: blocked (Docs MCP missing)'),
    'straddle-integration-plan.md': APPROVED_PLAN,
    'straddle-integration-report.md': report('complete'),
    'straddle-test-evidence.md': EVIDENCE,
  });
  const claude = fakeClaude();
  claude.sessions(DEFAULT_SESSIONS);

  const r = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Your session in Claude Code: Setup → Go Live\n/);
  assert.match(r.stdout, /Plan, Integrate and Test are done; I read that from their files\. I'll start at Setup\./);
  const [launch] = launches(claude);
  assert.ok(launch!.at(-1)!.startsWith('/straddle:straddle-setup\nStraddle Wizard program: straddle-setup → straddle-go-live. Start at straddle-setup.\n'), launch!.at(-1));
  // Plan never ran again, so its approval stands.
  assert.equal(readFileSync(join(repo, 'straddle-integration-plan.md'), 'utf8'), APPROVED_PLAN);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('resume trusts the files over the session: a finished report moves on to Test, and a plan edited after approval goes back to Plan', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions({ ...DEFAULT_SESSIONS, 'straddle-integrate': { ...DEFAULT_SESSIONS['straddle-integrate'], stop: true } });

  const first = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });
  const toTest = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });
  writeFiles(repo, { 'straddle-integration-plan.md': APPROVED_PLAN.replace('add client', 'add client and payouts') });
  const toPlan = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });

  assert.equal(first.code, 0, first.stdout);
  assert.equal(readReceipt(repo).stateReason, 'next: Test');
  assert.match(first.stdout, /Next: run `wizard resume` and I'll reopen the session at Test\./);
  assert.match(toTest.stdout, /Resume at Test/);
  assert.match(toPlan.stdout, /Plan\s+straddle-integration-plan\.md: the plan changed after you approved it/);
  assert.match(toPlan.stdout, /Integrate\s+straddle-integration-report\.md: Status: complete, but straddle-integration-plan\.md is not approved as it stands/);
  assert.match(toPlan.stdout, /Resume at Plan/);
});

test('with Straddle files already here, the Wizard asks to start fresh or resume: fresh sets them aside only once the run is confirmed, resume starts at the first unfinished step', async () => {
  const fresh = nextRepo();
  writeFiles(fresh, { 'straddle-setup.md': SETUP_FILE, 'straddle-integration-plan.md': APPROVED_PLAN });
  const claude = fakeClaude();

  // Start fresh, Continue, the four choices, then Cancel at the agent choice: nothing moves.
  const cancelled = await runWizard([], { cwd: fresh, claude, env: CONFIGURED, input: ['2', '1', '1', '3', '', '1', '3'] });

  assert.match(cancelled.stdout, /This repo already has Straddle files from an earlier run/);
  assert.match(cancelled.stdout, /Start fresh or resume\?\n\s+1\) Resume at Integrate\n\s+2\) Start fresh/);
  assert.match(cancelled.stdout, /Cancelled\. Your earlier Straddle files stay where they were\./);
  assert.equal(readFileSync(join(fresh, 'straddle-integration-plan.md'), 'utf8'), APPROVED_PLAN);
  assert.deepEqual(readdirSync(fresh).filter((f) => f.includes('.previous-')), []);

  // Start fresh again and choose Claude Code, then stop before the session: the earlier files now sit beside the new ones.
  await runWizard([], { cwd: fresh, claude, env: CONFIGURED, input: ['2', '1', '1', '3', '', '1', '1', '2'] });

  const kept = readdirSync(fresh).filter((f) => f.includes('.previous-')).sort();
  assert.deepEqual(kept.map((f) => f.replace(/\d+$/, 'N')), ['straddle-integration-plan.md.previous-N', 'straddle-setup.md.previous-N']);
  assert.equal(existsSync(join(fresh, 'straddle-setup.md')), false);

  // Without any receipt, `wizard resume` confirms the details and starts at the first unfinished step.
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-setup.md': SETUP_FILE, 'straddle-integration-plan.md': APPROVED_PLAN });
  claude.sessions(DEFAULT_SESSIONS);
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });

  assert.equal(resumed.code, 0, resumed.stdout);
  assert.match(resumed.stdout, /I'll pick up from the Straddle files in this repo/);
  assert.match(resumed.stdout, /Setup and Plan are done; I read that from their files\. I'll start at Integrate\./);
  assert.ok(launches(claude)[0]!.at(-1)!.startsWith('/straddle:straddle-integrate\nStraddle Wizard program: straddle-integrate → straddle-test → straddle-go-live.'));
  assert.equal(readFileSync(join(repo, 'straddle-setup.md'), 'utf8'), SETUP_FILE);
});

test('without a Sandbox configuration the session starts at Plan, since Setup stops at the missing key, and resume runs Setup and then the rest', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(DEFAULT_SESSIONS);

  const first = await runWizard([], { cwd: repo, claude, env: {}, input: [...CHOOSE_CONTEXT, '1'] });
  const setupRanFirst = existsSync(join(repo, 'straddle-setup.md'));
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(first.code, 1, first.stdout);
  assert.match(first.stdout, /Configuration error: STRADDLE_API_KEY is not set; no environment is declared \(STRADDLE_ENVIRONMENT=sandbox\)\./);
  assert.match(first.stdout, /Setup stops at this error, so I'll leave it until you've fixed it\./);
  assert.match(first.stdout, /Plan sends no Straddle request, so I'll start the session there and list only Plan\./);
  assert.match(first.stdout, /zero Straddle requests are sent/);
  assert.doesNotMatch(first.stdout, /end the session/);
  assert.equal(setupRanFirst, false, 'Setup waits for the key instead of running and stopping the session');
  const [one, two] = launches(claude);
  assert.ok(one!.at(-1)!.startsWith('/straddle:straddle-plan\nStraddle Wizard program: straddle-plan. Start at straddle-plan.\n'), one!.at(-1));
  assert.equal(resumed.code, 0, resumed.stdout);
  // Plan finished in the first session, so it isn't listed again.
  assert.ok(two!.at(-1)!.startsWith('/straddle:straddle-setup\nStraddle Wizard program: straddle-setup → straddle-integrate → straddle-test → straddle-go-live. Start at straddle-setup.\n'), two!.at(-1));
  assert.equal(readReceipt(repo).state, 'completed');

  // `wizard setup` on its own still runs Setup, which reports the missing key.
  const alone = nextRepo();
  const setupOnly = await runWizard(['setup', '--client', 'claude'], { cwd: alone, claude, env: {}, input: [...CHOOSE_CONTEXT.slice(0, -1), '1'] });
  assert.match(setupOnly.stdout, /Setup\s+straddle-setup\.md: Status: blocked \(STRADDLE_API_KEY not set\) · reported blocked/);
});

test('another payment provider in the repo adds Migrate to the program', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': JSON.stringify({ dependencies: { next: '15.0.0', stripe: '17.0.0' }, devDependencies: { typescript: '5.6.0' } }) });

  const r = await runWizard([], { cwd: repo, claude: fakeClaude(), env: CONFIGURED, input: [...CHOOSE_CONTEXT, '2'] });

  assert.match(r.stdout, /Program\s+Setup → Plan → Migrate → Integrate → Test → Go Live \(Migrate, because you already use stripe\)/);
  assert.match(r.stdout, /Your session in Claude Code: Setup → Plan → Migrate → Integrate → Test → Go Live/);
});

test('readiness does not promise Claude Code permission prompts that a managed policy can switch off', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();

  // Continue, then stop at Start: only the readiness screen matters.
  const r = await runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '2'] });

  assert.match(r.stdout, /Session settings\s+Isolated\. /);
  assert.doesNotMatch(r.stdout, /asks before edits/);
  assert.match(r.stdout, /managed policy still applies and can allow edits, commands or MCP calls without asking/);
});

test('Integrate never starts before the durable plan exists', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /Integrate needs straddle-integration-plan\.md\. Run `wizard plan` first/);
  assert.equal(launches(claude).length, 0);
  assert.equal(readReceipt(repo).state, 'blocked');
});

test('before Integrate and before Test the Wizard shows the plan state and where approval must happen, including that only a recorded approval of the current plan carries over', async () => {
  for (const [program, title] of [['integrate', 'Integrate'], ['test', 'Test']] as const) {
    const repo = nextRepo();
    writeFiles(repo, { 'straddle-integration-plan.md': PLAN });

    // Continue, then stop at Start.
    const r = await runWizard([program, '--client', 'claude'], { cwd: repo, claude: fakeClaude(), env: CONFIGURED, input: ['1', '2'] });

    assert.match(r.stdout, /Plan: straddle-integration-plan\.md \(Plan state: Draft\)/, program);
    assert.match(r.stdout, new RegExp(`${title} runs only an approved plan: an approval recorded in the file that matches the current plan`), program);
    assert.match(r.stdout, /Editing the plan after approval voids the record/, program);
  }

  const migrationRepo = nextRepo();
  writeFiles(migrationRepo, { 'straddle-migration-plan.md': PLAN });
  const mr = await runWizard(['test', '--client', 'claude'], { cwd: migrationRepo, claude: fakeClaude(), env: CONFIGURED, input: ['1', '2'] });
  assert.match(mr.stdout, /Plan: straddle-migration-plan\.md \(Plan state: Draft\)/);
  assert.match(mr.stdout, /Test runs only an approved plan: an approval recorded in the file that matches the current plan/);
});

test('a step file the agent opens with a shell command is observed as entered, like one opened with Read', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.sessions({ 'straddle-integrate': { steps: ['01-begin', '05-execute'], shellSteps: ['06-review', '07-handoff'], text: handoff('straddle-integrate', 'complete') } });

  const r = await runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Integrate\s+straddle-integration-report\.md: not written yet · reported complete · 4 of \d+ step files opened/);
});

test('an edit the developer denies in the agent is not reported as a change, and the step stays blocked', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({ 'straddle-integrate': {
    steps: ['01-begin', '02-sources', '03-code'], denied: ['03-code', 'src/straddle.ts'],
    writes: [{ path: 'src/straddle.ts', content: 'export {}' }], text: handoff('straddle-integrate', 'blocked'),
  } });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1'] });

  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /Integrate\s+straddle-integration-report\.md: not written yet · reported blocked · 2 of \d+ step files opened/);
  assert.match(r.stdout, /Changed files \(I compared them before and after each session\)\n\s+none/);
  assert.equal(existsSync(join(repo, 'src', 'straddle.ts')), false);
  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'blocked');
  assert.match(receipt.stateReason, /^Integrate stopped at blocked; straddle-integration-report\.md: not written yet$/);
  assert.ok(!readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8').includes('"kind":"edit"'));
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
  assert.equal(launches(claude).length, 0);
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
  assert.equal(launches(claude).length, 0);
  assert.match(readReceipt(repo).stateReason, /configuration error/);
  // Integrate is the only step here, so the help promises no step that could continue.
  assert.match(r.stdout, /Integrate won't start until you fix this in your own shell/);
  assert.doesNotMatch(r.stdout, /can run now/);
});

test('an explicit non-Sandbox base URL is a configuration error even when STRADDLE_ENVIRONMENT says sandbox', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  const env = { ...CONFIGURED, STRADDLE_BASE_URL: 'https://production.straddle.com' };

  const status = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, claude, env })).stdout);
  const r = await runWizard(['test'], { cwd: repo, claude, env, input: ['1', '1'] });

  assert.equal(status.environment, 'conflicting: STRADDLE_ENVIRONMENT is sandbox, STRADDLE_BASE_URL is https://production.straddle.com');
  assert.deepEqual(status.configurationErrors, [
    'STRADDLE_BASE_URL is https://production.straddle.com, not the Sandbox host',
    'STRADDLE_ENVIRONMENT (sandbox) and STRADDLE_BASE_URL (https://production.straddle.com) disagree',
  ]);
  assert.equal(r.code, 1);
  assert.equal(launches(claude).length, 0);
});

test('a plan that is a symlink, or an excluded plan, is never opened or printed', async () => {
  const outside = tempDir('outside');
  writeFiles(outside, { '.env': `## File changes\n\nSYNTHETIC_SECRET_SENTINEL\n` });
  const linked = nextRepo();
  symlinkSync(join(outside, '.env'), join(linked, 'straddle-integration-plan.md'));
  const excluded = nextRepo();
  writeFiles(excluded, { 'straddle-integration-plan.md': PLAN.replace('add client', 'SYNTHETIC_PRIVATE_PLAN_ROW') });
  const claude = fakeClaude();

  const a = await runWizard(['integrate', '--client', 'claude'], { cwd: linked, claude, input: ['1'] });
  const b = await runWizard(['integrate', '--client', 'claude', '--exclude', 'straddle-integration-plan.md'], { cwd: excluded, claude, input: ['1'] });

  assert.doesNotMatch(a.stdout, /SYNTHETIC_SECRET_SENTINEL/);
  assert.match(a.stdout, /Not shown: I don't open it because it's a symlink/);
  assert.doesNotMatch(b.stdout, /SYNTHETIC_PRIVATE_PLAN_ROW/);
  assert.match(b.stdout, /Not shown: I don't open it because it's a configured sensitive path/);
});

test('client login loss blocks the handoff with a repair, and resume rechecks it without reusing any approval', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true, loggedIn: false });
  claude.sessions(DEFAULT_SESSIONS);

  const first = await runWizard(['setup'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '2'] });

  assert.equal(first.code, 1);
  assert.match(first.stdout, /Claude Code isn't logged in\. Run `claude auth login` in your terminal/);
  assert.equal(readReceipt(repo).state, 'blocked');

  claude.setState({ loggedIn: true });
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(resumed.code, 0, resumed.stdout);
  assert.match(resumed.stdout, /Saved run: setup program, blocked/);
  assert.match(resumed.stdout, /Choices\s+charges, marketplace, TypeScript, webhook endpoint/);
  assert.match(resumed.stdout, /Sandbox write approvals from earlier sessions don't carry over\. A recorded plan approval does, while the plan is unchanged\./);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('a failed or aborted session never counts as done: the Wizard stops there, and resume reruns the step', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  const draftThenAbort = `${handoff('straddle-plan', 'draft')}\nSTRADDLE_ABORT {"skill":"straddle-plan","reason":"developer stopped"}`;
  claude.sessions({ 'straddle-plan': { steps: ['01-decisions'], writes: [{ path: 'straddle-integration-plan.md', content: PLAN }], text: draftThenAbort } });

  const aborted = await runWizard(['plan', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT.slice(0, -1), '1'] });
  claude.sessions({ 'straddle-plan': { steps: ['01-decisions'], text: handoff('straddle-plan', 'draft'), exit: 42 } });
  const failed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });
  const afterFailure = readReceipt(repo);
  claude.sessions({ 'straddle-plan': { steps: ['06-show-me'], writes: [{ path: 'straddle-integration-plan.md', content: APPROVED_PLAN }], text: 'STRADDLE_PROGRESS {"skill":"straddle-plan","step":"06-show-me"}' } });
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });

  assert.equal(aborted.code, 130, aborted.stdout);
  assert.match(aborted.stdout, /Your agent reported STRADDLE_ABORT for Plan: developer stopped/);
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, /exited with code 42 during Plan; I don't advance past a failed session/);
  assert.equal(afterFailure.state, 'blocked');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(launches(claude).length, 3);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('the later of a reported abort and handoff decides the tick: a recovered step ticks, a later abort does not', async () => {
  const abort = 'STRADDLE_ABORT {"skill":"straddle-integrate","step":"01-begin","reason":"plan not approved"}';
  const complete = handoff('straddle-integrate', 'complete');
  const run = async (text: string) => {
    const repo = nextRepo();
    writeFiles(repo, { 'straddle-integration-plan.md': APPROVED_PLAN });
    const claude = fakeClaude();
    claude.sessions({ 'straddle-integrate': { steps: ['01-begin', '07-handoff'], writes: [{ path: 'straddle-integration-report.md', content: report('complete') }], text } });
    return runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });
  };

  const recovered = await run(`${abort}\nThe developer approved the plan in this session.\n${complete}`);
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.match(recovered.stdout, /✓ Integrate\s+straddle-integration-report\.md: Status: complete, for the current approved plan · reported complete · 2 of/);

  const abortedAfterHandoff = await run(`${complete}\n${abort}`);
  assert.match(abortedAfterHandoff.stdout, /▶ Integrate\s+straddle-integration-report\.md: Status: complete, for the current approved plan · reported STRADDLE_ABORT \(plan not approved\)/);
  assert.doesNotMatch(abortedAfterHandoff.stdout, /reported complete/);
});

test('resume finishes cancelled upfront choices, applies new exclusions before inspecting, and hands corrected context to the agent', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'src/private-data.txt': 'before' });
  const claude = fakeClaude();
  claude.sessions({ 'straddle-plan': {
    steps: ['01-decisions'],
    writes: [{ path: 'straddle-integration-plan.md', content: PLAN }, { path: 'src/private-data.txt', content: 'after' }],
    text: handoff('straddle-plan', 'draft'),
  } });

  // Change > Framework > CUSTOM_FRAMEWORK, Continue, then Cancel at the first product question.
  const first = await runWizard(['plan', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['2', '2', 'CUSTOM_FRAMEWORK', '1', '5'] });
  // Resume, then the four choices, then Start.
  const resumed = await runWizard(['resume', '--client', 'claude', '--exclude', 'src/private-data.txt'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '3', '', '1', '1'] });

  assert.equal(first.code, 130, first.stdout);
  assert.match(resumed.stdout, /Choices\s+not answered yet; I'll ask before your agent starts/);
  assert.match(resumed.stdout, /Never opened\s+src\/private-data\.txt/);
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(launches(claude)[0]!.at(-1), [
    '/straddle:straddle-plan',
    'Straddle Wizard program: straddle-plan. Start at straddle-plan.',
    // N2: the skills run only the listed steps (wizard-program.md), so the prompt says "the next listed step".
    "Run the listed steps in order in this one session: after each step's STRADDLE_HANDOFF, continue with the next listed step without waiting for the Wizard; stop and ask whenever a step needs the developer (plan approval, each Sandbox write).",
    'Repository context confirmed in the Straddle Wizard: language TypeScript (detected); framework CUSTOM_FRAMEWORK (corrected by the developer). '
      + 'Developer choices from the Straddle Wizard: products charges; integration type marketplace; SDK TypeScript; notification path webhook endpoint.',
  ].join('\n'));
  const receipt = readReceipt(repo);
  assert.deepEqual(receipt.exclude, ['src/private-data.txt']);
  assert.deepEqual(receipt.sessions[0]?.changedFiles, ['straddle-integration-plan.md']);
});

test('a completed run is shown and kept beside the next run instead of being overwritten', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(DEFAULT_SESSIONS);
  await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT.slice(0, -1), '1'] });
  const completed = readReceipt(repo);

  // Start fresh (a completed run offers no resume), Continue, then stop before Audit starts.
  const r = await runWizard(['audit', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '2'] });

  assert.equal(completed.state, 'completed');
  assert.match(r.stdout, /Saved run: setup program, completed/);
  assert.match(r.stdout, /Start fresh or resume\?\n\s+1\) Start fresh/);
  const kept = readdirSync(join(repo, '.straddle-wizard')).filter((f) => f.startsWith('receipt.json.completed-'));
  assert.equal(kept.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.straddle-wizard', kept[0]!), 'utf8')).sessions, completed.sessions);
  assert.equal(readReceipt(repo).program, 'audit');
  // Only the integration program sets the skills' files aside.
  assert.equal(readFileSync(join(repo, 'straddle-setup.md'), 'utf8'), SETUP_FILE);
});

test('a malformed line in events.jsonl is skipped with a note, and the start screen and the status line still read the files', async () => {
  const repo = nextRepo();
  writeFiles(repo, {
    'straddle-setup.md': SETUP_FILE,
    'straddle-integration-plan.md': APPROVED_PLAN,
    '.straddle-wizard/events.jsonl': '{"at":"t1","kind":"marker"}\n{"at":"t2","kind":"step-entered","skill":"straddle-integrate","step":"01-begin"}\n',
  });

  // Cancel at "Start fresh or resume?".
  const r = await runWizard([], { cwd: repo, claude: fakeClaude(), env: CONFIGURED, input: ['3'] });
  const line = spawnSync(process.execPath, [join(ROOT, 'src', 'statusline.ts'), '--repo', repo, '--steps', 'straddle-setup:5,straddle-plan:6,straddle-integrate:7'], { encoding: 'utf8' });

  assert.equal(r.code, 130, r.stdout + r.stderr);
  assert.match(r.stdout, /1\) Resume at Integrate/);
  assert.match(r.stdout, /I skipped 1 unreadable line in \.straddle-wizard\/events\.jsonl/);
  assert.equal(line.status, 0, line.stderr);
  assert.equal(line.stdout, 'Straddle: Setup · Plan · Integrate ▶ 1/7\n');
});

test('a corrupted receipt is reported on resume and left untouched', async () => {
  const repo = nextRepo();
  writeFiles(repo, { '.straddle-wizard/receipt.json': '{broken' });

  const r = await runWizard(['resume'], { cwd: repo, claude: fakeClaude() });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /I can't read the saved Wizard receipt/);
  assert.equal(readFileSync(join(repo, '.straddle-wizard', 'receipt.json'), 'utf8'), '{broken');
});

test('wizard audit runs straddle-audit and prints the findings table from its report', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  const auditReport = '# Straddle audit\n\nStatus: findings\n\n## Findings\n| # | File:line | Category | Finding | Confidence | Evidence (SDK / contract) | Recovery |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | src/pay.ts:12 | idempotency | create without key | high | sdk | add key |\n\n## Checked and dismissed\n';
  claude.sessions({ 'straddle-audit': { steps: ['01-begin', '05-report'], writes: [{ path: 'straddle-audit-report.md', content: auditReport }], text: handoff('straddle-audit', 'findings') } });

  const r = await runWizard(['audit'], { cwd: repo, claude, input: ['1', '1', '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Findings \(straddle-audit-report\.md\)\n.*\n.*\n\s+\| 1 \| src\/pay\.ts:12 \| idempotency \| create without key \| high \|/);
  assert.match(r.stdout, /✓ Audit\s+writes no status file · reported findings · 2 of/);
});

test('wizard skill run <name> launches that versioned skill in the chosen agent', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({ 'straddle-go-live': { steps: ['01-begin'], text: handoff('straddle-go-live', 'not_ready') } });

  const r = await runWizard(['skill', 'run', 'straddle-go-live'], { cwd: repo, claude, input: ['1', '1', '1'] });

  // C: a not-ready review isn't a finished Go Live, so the run stops there, naming what the report says.
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Reason\s+Go Live stopped at not_ready; straddle-go-live-report\.md: not written yet/);
  // D2: Go Live makes no Sandbox write, so resuming it asks none again.
  assert.doesNotMatch(r.stdout, /Sandbox write/);
  assert.match(r.stdout, /Your session in Claude Code: Go Live/);
  const [launch] = launches(claude);
  assert.ok(launch!.at(-1)!.startsWith('/straddle:straddle-go-live\nStraddle Wizard program: straddle-go-live. Start at straddle-go-live.\n'));
  assert.ok(launch!.at(-1)!.endsWith('Repository context confirmed in the Straddle Wizard: language TypeScript (detected); framework Next.js (detected).'));
  assert.equal(readReceipt(repo).program, 'skill:straddle-go-live');
});

test('D2: a partial Test stops the run with the gap its evidence names, and resuming asks every Sandbox write again', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  const partial = EVIDENCE.replace('Status: complete', 'Status: partial (Sandbox webhook not configured)');
  claude.sessions({ ...DEFAULT_SESSIONS, 'straddle-test': { ...DEFAULT_SESSIONS['straddle-test'], writes: [{ path: 'straddle-test-evidence.md', content: partial }], text: handoff('straddle-test', 'partial'), stop: true } });

  const r = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });

  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Reason\s+Test stopped at partial; straddle-test-evidence\.md: Status: partial \(Sandbox webhook not configured\)/);
  assert.match(r.stdout, /I'll reopen the session at Test\. Approvals from before don't count there, so every Sandbox write is asked again\./);
});

test('D1: files that say done while this session reported a failed Test never read as the whole program', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions({ ...DEFAULT_SESSIONS, 'straddle-test': { ...DEFAULT_SESSIONS['straddle-test'], text: handoff('straddle-test', 'failed') } });

  const r = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });

  assert.doesNotMatch(r.stdout, /That's the whole program/);
  assert.match(r.stdout, /straddle-test-evidence\.md says done, but your agent reported failed; check that straddle-test-evidence\.md was rewritten\./);
});

test('unknown command exits with usage error', async () => {
  const r = await runWizard(['diagnose'], { cwd: nextRepo() });

  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "diagnose"\./);
  // N9: the usage names every step the guided run can take, Migrate included.
  assert.match(r.stderr, /Setup, Plan, Migrate \(when you use another payment provider\), Integrate, Test, Go Live/);
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
  assert.deepEqual([parsed.bundle.kind, parsed.bundle.pluginVersion], ['local', '0.1.0']);
  assert.deepEqual(parsed.clients.find((c: { name: string }) => c.name === 'claude').plugin, { state: 'installed', version: '0.1.0', verified: true });
  assert.deepEqual(parsed.clients.find((c: { name: string }) => c.name === 'cursor').plugin, { state: 'unverified', version: null, verified: false });
  assert.equal(parsed.credentials.STRADDLE_API_KEY, 'missing');
  assert.equal(update.code, 0, update.stdout);
  assert.match(update.stdout, /ok\s+claude plugin uninstall straddle@straddle\nok\s+claude plugin install straddle@straddle\nStraddle plugin in Claude Code: installed 0\.1\.0, matches the Wizard's bundle/);
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

test('Cursor gets a labelled manual handoff, never fake progress, and the files decide what is next', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  // Continue, charges, marketplace, suggested SDK, webhook, Cursor, then "I'm back" without anything written.
  const r = await runWizard(['plan'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '3', '', '1', '2', '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /I can't drive Cursor, so here's the handoff:/);
  assert.match(r.stdout, /Use the straddle-plan skill\.\n\s+Straddle Wizard program: straddle-plan\. Start at straddle-plan\.\n/);
  assert.match(r.stdout, /Plan\s+straddle-integration-plan\.md: not written yet · no handoff reported · progress not observable/);
  const receipt = readReceipt(repo);
  assert.equal(receipt.state, 'ready');
  assert.equal(receipt.sessions[0]?.client, 'cursor');
});

test('receipt removal is configuration loss the next run reports as a fresh start', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  await runWizard([], { cwd: repo, claude, input: ['1', '1', '3', '', '1', '3'] });
  rmSync(join(repo, '.straddle-wizard'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'x');

  const r = await runWizard(['resume'], { cwd: repo, claude });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /There's no saved Wizard run in this repo\. Start one with `wizard`\./);
});
