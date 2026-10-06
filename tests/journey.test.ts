// Guided journey through the real CLI, with Claude Code replaced by a scripted process (tests/fixtures/fake-claude.mjs).
// This is simulated-adapter evidence. Native client proof is recorded separately.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CLIENT_LABEL, launchCommand } from '../src/clients.ts';
import { start, type JourneyOptions } from '../src/journey.ts';
import { approvalHash } from '../src/progress.ts';
import { Prompter } from '../src/ui.ts';
import { BUNDLE_WITHOUT_REVIEW, CURSOR_CHAT, ROOT, SKILLS_SOURCE, fakeClaude, fakeClients, nextRepo, readReceipt, releaseServer, runWizard, tempDir, writeFiles, type FakeClaude, type ReleaseServer } from './helpers.ts';

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

// Continue, charges, marketplace, suggested SDK, webhook endpoint.
const CHOICES = ['1', '1', '3', '', '1'];
// The choices, Claude Code, Auto.
const CHOOSE_CONTEXT = [...CHOICES, '1', '1'];
// Another Cursor chat in the same repo, not the Wizard's.
const OTHER_CHAT = 'deadbeef-1111-2222-3333-444455556666';

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
  assert.match(first.stdout, /Skill bundle\s+plugin release v0\.1\.0 of straddle-build\/skills \(\d+ skills, verified against its published SHA256SUMS\)/);
  assert.equal(JSON.parse(status.stdout).bundle.path, release);
  assert.equal(list.code, 0, list.stdout);
  assert.doesNotMatch(list.stdout, /Download/);
  assert.deepEqual(server.requests.filter((path) => path.endsWith('.zip')), ['/v0.1.0/straddle-plugin-0.1.0.zip']);
});

test('--client picks the agent for a guided run instead of asking; then the Wizard asks Auto or Manual, defaults to Manual for an agent not installed here, and saves the answer', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();

  // The choices; no agent question; Enter at Auto or Manual; then stop at the handoff.
  const r = await runWizard(['plan', '--client', 'cursor'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOICES, '', '2'] });

  assert.doesNotMatch(r.stdout, /Which coding agent should do the work\?/);
  assert.match(r.stdout, /How do you want to run the setup\?\n\s+1\) Auto\s+I start Cursor here and it works through the steps\n\s+2\) Manual\s+I set everything up and tell you what to paste into your own agent\n\s+3\) Cancel\nChoose \[2\]/);
  const receipt = readReceipt(repo);
  assert.equal(receipt.client, 'cursor');
  assert.equal(receipt.mode, 'manual');
});

test('default journey: one agent session walks the whole program, with a live checklist that ticks only what is on file and reported', async () => {
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

  // One launch, with the developer's own settings, naming the whole program.
  const [launch, ...others] = launches(claude);
  assert.equal(others.length, 0);
  // N1: the program line begins a line of its own, after the skill invocation.
  assert.ok(launch!.at(-1)!.startsWith(`/straddle:straddle-setup\n${PROGRAM_LINE}\n`), launch!.at(-1));
  assert.ok(!launch!.at(-1)!.includes(REOPENED), 'a new session has no earlier approvals to disown');
  assert.ok(!launch!.some((a) => /--resume|--continue|dangerously|bypass|--permission-mode/.test(a)), `native approvals stay interactive: ${launch}`);
  // The Wizard never changes the developer's settings: its settings file adds only the status line and the progress
  // hooks, no permission, default mode or sandbox key, and the developer's own sources load.
  const settings = JSON.parse(readFileSync(launch![launch!.indexOf('--settings') + 1]!, 'utf8'));
  assert.deepEqual(Object.keys(settings), ['statusLine', 'hooks']);
  assert.equal(settings.statusLine?.type, 'command');
  assert.deepEqual(Object.keys(settings.hooks), ['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse', 'PostToolUse']);
  assert.ok(!launch!.includes('--setting-sources'), `the developer's settings load: ${launch}`);
  assert.equal(launch![launch!.indexOf('--plugin-dir') + 1], BUNDLE_WITHOUT_REVIEW);

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
  assert.deepEqual([receipt.bundle?.kind, receipt.bundle?.pluginVersion, receipt.bundle?.path], ['local', '0.1.0', BUNDLE_WITHOUT_REVIEW]);
  assert.equal(receipt.sessions.length, 1);
  assert.match(receipt.sessions[0]!.sessionId ?? '', /^[0-9a-f-]{36}$/);
  const events = readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8');
  for (const secret of [JSON.stringify(receipt), events]) assert.ok(!secret.includes('sk_test_value_in_test_env'), 'no record holds the key');

  // The report points at the session log, a pipe is never asked to open it, and `wizard log` replays this session.
  assert.match(r.stdout, /Session log\s+wizard log\n/);
  assert.doesNotMatch(r.stdout, /Open the session log\?/);
  const log = await runWizard(['log'], { cwd: repo, claude, env: CONFIGURED });
  assert.equal(log.code, 0, log.stderr);
  const page = readFileSync(join(repo, '.straddle-wizard', 'session-log.html'), 'utf8');
  const headings = [...page.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(headings.map((h) => h.split(' · ')[0]))], ['Session start', 'straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test', 'straddle-go-live']);
  assert.deepEqual(headings.slice(1, 6), ['straddle-setup · 01-begin', 'straddle-setup · 02-repository', 'straddle-setup · 03-cli-and-context', 'straddle-setup · 04-mcp', 'straddle-setup · 05-report']);
  assert.match(page, /<span class="who">Write<\/span><div class="body"><details><summary>[^<]*\/src\/straddle\.ts<\/summary>/);
  assert.ok(!page.includes('sk_test_value_in_test_env'), 'the page holds no key');
});

const LAUNCH = { skill: 'straddle-plan', repo: '/repo', context: 'ctx', settingsPath: '/run/session.settings.json', pluginDir: '/bundle' };
for (const [name, req, expected] of [
  ['Claude Code, new', { ...LAUNCH, client: 'claude', resume: null }, { bin: 'claude', args: ['--settings', '/run/session.settings.json', '--plugin-dir', '/bundle', '/straddle:straddle-plan\nctx'] }],
  ['Claude Code, resumed', { ...LAUNCH, client: 'claude', resume: 'abc' }, { bin: 'claude', args: ['--settings', '/run/session.settings.json', '--plugin-dir', '/bundle', '--resume', 'abc', '/straddle:straddle-plan\nctx'] }],
  ['Codex, new', { ...LAUNCH, client: 'codex', resume: null }, { bin: 'codex', args: ['-C', '/repo', 'Use the straddle-plan skill.\nctx'] }],
  ['Codex, resumed', { ...LAUNCH, client: 'codex', resume: 'abc' }, { bin: 'codex', args: ['resume', '-C', '/repo', 'abc', 'Use the straddle-plan skill.\nctx'] }],
] as const) {
  test(`${name}: launches with the developer's own settings, no permission, sandbox or approval flag`, () => {
    assert.deepEqual(launchCommand(req), expected);
  });
}

// The payment review (skills wizard-program.md, Payment review, at the frozen contract the test bundle carries):
// the run's start state is taken once before any session edit; the program's session ends at Test; a fresh read-only
// review session prints its report, which the Wizard checks and saves; Go Live then resumes the original session.
const REVIEW_BEGIN = 'STRADDLE_REPORT_BEGIN {"skill":"straddle-payment-review","file":"straddle-payment-review.md"}';
const REVIEW_END = 'STRADDLE_REPORT_END {"skill":"straddle-payment-review"}';
const REVIEW_REPORT = `# Straddle payment review\n\nStatus: clean\nPlan hash: ${PLAN_HASH}\nCode hash: {{CODE_HASH}}\nSnapshot: s, started t\nSession files reviewed: 2\n\n## Findings\n\nNone.`;
const REVIEWED = { ...DEFAULT_SESSIONS, 'straddle-payment-review': { steps: ['01-scope', '02-review', '03-report'], text: `${REVIEW_BEGIN}\n${REVIEW_REPORT}\n${REVIEW_END}\nSTRADDLE_HANDOFF {"skill":"straddle-payment-review","status":"clean","report":"straddle-payment-review.md: clean"}` } };
const WITH_REVIEW = { ...CONFIGURED, STRADDLE_WIZARD_BUNDLE: SKILLS_SOURCE };

test('payment review: the program ends at Test, a fresh read-only review prints the report the Wizard saves, and Go Live resumes the original session', async () => {
  const repo = realpathSync(nextRepo());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const claude = fakeClaude();
  claude.sessions(REVIEWED);
  const r = await runWizard([], { cwd: repo, claude, env: WITH_REVIEW, input: [...CHOOSE_CONTEXT, '1', '1', '1'] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const receipt = readReceipt(repo);
  const ref = `refs/straddle-wizard/${receipt.runId}`;
  const baseline = JSON.parse(readFileSync(join(repo, '.straddle-wizard', 'session-baseline.json'), 'utf8'));
  assert.equal(spawnSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).stdout.trim(), baseline.snapshot);
  // The snapshot holds the repo as it was before Plan and Integrate wrote their files.
  assert.deepEqual(spawnSync('git', ['ls-tree', '-r', '--name-only', baseline.snapshot], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n'), ['package.json', 'src/app/page.tsx', 'tsconfig.json']);

  const [program, review, goLive, ...more] = launches(claude);
  assert.equal(more.length, 0);
  assert.match(program!.at(-1)!, /Straddle Wizard program: straddle-setup → straddle-plan → straddle-integrate → straddle-test\. Start at straddle-setup\./);
  assert.ok(!review!.includes('--resume'), 'the review reopened a session');
  const scope = `.straddle-wizard/runs/${receipt.runId}/review-scope`;
  assert.equal(review!.at(-1), `/straddle:straddle-payment-review\nStraddle Wizard review: print the report; don't write files.\nStraddle Wizard review scope: ${scope}`);
  assert.deepEqual(review!.slice(0, 6), ['--restricted', '--strict-mcp-config', '--tools', 'Read,Glob,Grep,Skill', '--add-dir', review![review!.indexOf('--plugin-dir') + 1]]);
  assert.equal(readFileSync(join(repo, scope, 'plan-hash.txt'), 'utf8'), `${PLAN_HASH}\n`);
  const settings = JSON.parse(readFileSync(review![review!.indexOf('--settings') + 1]!, 'utf8'));
  assert.deepEqual(['Bash', 'Write', 'Edit', 'WebFetch'].filter((t) => settings.permissions.deny.includes(t)), ['Bash', 'Write', 'Edit', 'WebFetch']);
  assert.equal(goLive![goLive!.indexOf('--resume') + 1], receipt.sessions[0]!.sessionId);
  assert.match(goLive!.at(-1)!, /Straddle Wizard program: straddle-go-live\. Start at straddle-go-live\./);

  const code = spawnSync('bash', [join(SKILLS_SOURCE, 'skills', 'straddle-payment-review', 'scripts', 'session-state'), 'compare', baseline.snapshot], { cwd: repo, encoding: 'utf8' }).stdout.split('\n')[0]!.slice('code-hash '.length);
  assert.equal(readFileSync(join(repo, 'straddle-payment-review.md'), 'utf8'), `${REVIEW_REPORT.replace('{{CODE_HASH}}', code)}\n`);
  assert.deepEqual(receipt.sessions.map((s) => [s.role ?? 'program', s.skills.at(-1) ?? null]), [['program', 'straddle-test'], ['review', null], ['program', 'straddle-go-live']]);
  assert.equal(receipt.state, 'completed');
});

test('payment review: one Ctrl-C ends the reviewer and its child, saves no report, keeps the original session and start state; resume reviews again and finishes', async () => {
  const repo = realpathSync(nextRepo());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const claude = fakeClaude();
  const marker = `zqreview${process.pid}`;
  claude.sessions({ ...REVIEWED, 'straddle-payment-review': { ...REVIEWED['straddle-payment-review'], hang: marker } });
  const env = { PATH: [claude.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: repo, NO_COLOR: '1', STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases', FAKE_CLAUDE_STATE: claude.state, ...WITH_REVIEW };
  const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts')], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  // The reviewer is working (it printed so, and its marked child runs) when the developer presses Ctrl-C once.
  const working = Promise.withResolvers<void>();
  child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('fake agent working')) working.resolve(); });
  child.stdin.end([...CHOOSE_CONTEXT, '1', '1'].join('\n') + '\n');
  const closed = Promise.withResolvers<number | null>();
  child.on('close', (code) => { working.resolve(); closed.resolve(code); });
  await working.promise;
  assert.equal(spawnSync('pgrep', ['-f', marker]).status, 0, `the review never started:\n${stdout}`);
  const baseline = readFileSync(join(repo, '.straddle-wizard', 'session-baseline.json'), 'utf8');
  child.kill('SIGINT');
  assert.equal(await closed.promise, 1, stdout);
  assert.match(stdout, /You cancelled the payment review\. I didn't start Go Live\. Run `wizard resume` to review again\./);
  assert.notEqual(spawnSync('pgrep', ['-f', marker]).status, 0, 'the reviewer\'s child is still running');
  assert.equal(existsSync(join(repo, 'straddle-payment-review.md')), false);
  assert.equal(readFileSync(join(repo, '.straddle-wizard', 'session-baseline.json'), 'utf8'), baseline);
  const cancelled = readReceipt(repo);
  assert.deepEqual([cancelled.state, cancelled.sessions.map((s) => s.role ?? 'program')], ['blocked', ['program', 'review']]);
  // Nothing of the review's restrictions reached the developer's own settings.
  assert.equal(existsSync(join(repo, '.claude')), false);

  claude.sessions(REVIEWED);
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: WITH_REVIEW, input: ['1', '1', '1'] });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  const all = launches(claude);
  // A new review session (not the cancelled one), then Go Live on the original program session.
  assert.equal(all.length, 4);
  assert.ok(!all[2]!.includes('--resume'));
  assert.equal(all[3]![all[3]!.indexOf('--resume') + 1], cancelled.sessions[0]!.sessionId);
  assert.equal(readFileSync(join(repo, '.straddle-wizard', 'session-baseline.json'), 'utf8'), baseline);
  assert.match(readFileSync(join(repo, 'straddle-payment-review.md'), 'utf8'), /^# Straddle payment review\n\nStatus: clean\n/);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('payment review: a printed report that fails its checks is never saved; it is advisory, so Go Live still runs and reports ready', async () => {
  const repo = realpathSync(nextRepo());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const claude = fakeClaude();
  // The report claims a code hash that isn't the code's.
  claude.sessions({ ...REVIEWED, 'straddle-payment-review': { ...REVIEWED['straddle-payment-review'], text: REVIEWED['straddle-payment-review'].text.replace('{{CODE_HASH}}', 'b'.repeat(64)) } });
  const r = await runWizard([], { cwd: repo, claude, env: WITH_REVIEW, input: [...CHOOSE_CONTEXT, '1', '1', '1'] });
  assert.match(r.stdout, /The payment review is incomplete: the report's Code hash isn't the code's\. It's advisory, so Go Live runs and lists it as a warning\./);
  assert.equal(existsSync(join(repo, 'straddle-payment-review.md')), false);
  assert.equal(launches(claude).length, 3);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('payment review: a report for another plan (stale Plan hash) is never saved; Go Live still runs', async () => {
  const repo = realpathSync(nextRepo());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const claude = fakeClaude();
  claude.sessions({ ...REVIEWED, 'straddle-payment-review': { ...REVIEWED['straddle-payment-review'], text: REVIEWED['straddle-payment-review'].text.replace(`Plan hash: ${PLAN_HASH}`, `Plan hash: ${'0'.repeat(64)}`) } });
  const r = await runWizard([], { cwd: repo, claude, env: WITH_REVIEW, input: [...CHOOSE_CONTEXT, '1', '1', '1'] });
  assert.match(r.stdout, /The payment review is incomplete: the report's Plan hash isn't the current plan's\. It's advisory, so Go Live runs/);
  assert.equal(existsSync(join(repo, 'straddle-payment-review.md')), false);
  assert.equal(launches(claude).length, 3);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('payment review, Manual with Claude Code: three handoffs, the program through Test, a printed read-only review command whose own transcript is read, then Go Live in the earlier session', async () => {
  const repo = realpathSync(nextRepo());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const claude = fakeClaude();
  claude.sessions(REVIEWED);
  const env = { ...WITH_REVIEW };
  // Handoff 1: the program through Test; the developer stops here and runs it in their own agent.
  // The choices, Manual, install the plugin, then stop at "I'm back".
  const first = await runWizard(['--client', 'claude'], { cwd: repo, claude, env, input: [...CHOICES, '2', '1', '2'] });
  assert.match(first.stdout, /Straddle Wizard program: straddle-setup → straddle-plan → straddle-integrate → straddle-test\. Start at straddle-setup\./);
  assert.doesNotMatch(first.stdout, /straddle-go-live/);
  for (const skill of ['straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test'] as const) for (const w of DEFAULT_SESSIONS[skill].writes) writeFiles(repo, { [w.path]: w.content });

  // Handoff 2: `wizard resume` prints the reviewer's own command; the developer runs it, then comes back.
  const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'resume'], { cwd: repo, env: { PATH: [claude.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: repo, NO_COLOR: '1', STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases', FAKE_CLAUDE_STATE: claude.state, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  const printed = Promise.withResolvers<void>();
  child.stdout.on('data', (d) => { stdout += d; if (stdout.includes("I'm back: read the review")) printed.resolve(); });
  const closed = Promise.withResolvers<number | null>();
  child.on('close', (code) => { printed.resolve(); closed.resolve(code); });
  child.stdin.write('1\n');
  await printed.promise;
  const settings = readdirSync(join(repo, '.straddle-wizard', 'runs', readReceipt(repo).runId)).find((f) => f.startsWith('review-'));
  const settingsPath = join(repo, '.straddle-wizard', 'runs', readReceipt(repo).runId, settings!);
  const prompt = "/straddle:straddle-payment-review\nStraddle Wizard review: print the report; don't write files.";
  const reviewFlags = ['--restricted', '--strict-mcp-config', '--tools', 'Read,Glob,Grep,Skill', '--add-dir', SKILLS_SOURCE];
  assert.ok(stdout.includes(`claude ${reviewFlags.join(' ')} --settings ${settingsPath} --plugin-dir ${SKILLS_SOURCE} '`), stdout);
  spawnSync(join(claude.bin, 'claude'), [...reviewFlags, '--settings', settingsPath, '--plugin-dir', SKILLS_SOURCE, prompt], { cwd: repo, env: { ...process.env, FAKE_CLAUDE_STATE: claude.state } });
  child.stdin.end('1\n2\n');
  assert.equal(await closed.promise, 0, stdout);

  // Handoff 3: Go Live, to paste into the earlier session.
  assert.match(stdout, /Payment review: clean\. I saved it to straddle-payment-review\.md\./);
  assert.match(stdout, /Paste it into your earlier Claude Code session, the one that ran Test, not the review session\./);
  assert.match(stdout, /Straddle Wizard program: straddle-go-live\. Start at straddle-go-live\./);
  assert.match(readFileSync(join(repo, 'straddle-payment-review.md'), 'utf8'), /^# Straddle payment review\n\nStatus: clean\n/);
  // The Wizard started no agent itself.
  assert.equal(launches(claude).length, 1);
});

test('a bundle without the payment review keeps the one-session program: no baseline, no ref, no review', async () => {
  const old = realpathSync(nextRepo());
  spawnSync('git', ['init', '-q'], { cwd: old });
  const oldClaude = fakeClaude();
  oldClaude.sessions(DEFAULT_SESSIONS);
  const o = await runWizard([], { cwd: old, claude: oldClaude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });
  assert.equal(o.code, 0, o.stdout + o.stderr);
  assert.doesNotMatch(o.stdout, /payment review/);
  assert.equal(launches(oldClaude).length, 1);
  assert.equal(existsSync(join(old, '.straddle-wizard', 'session-baseline.json')), false);
  assert.equal(spawnSync('git', ['for-each-ref', 'refs/straddle-wizard/'], { cwd: old, encoding: 'utf8' }).stdout, '');
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

// The session stops after Test, so Go Live is the only step left.
const STOP_AFTER_TEST = { ...DEFAULT_SESSIONS, 'straddle-test': { ...DEFAULT_SESSIONS['straddle-test'], stop: true } };
const statusScript = (repo: string) => spawnSync(process.execPath, [join(ROOT, 'src', 'statusline.ts'), '--repo', repo, '--steps', 'straddle-setup:5,straddle-plan:6,straddle-integrate:7,straddle-test:6,straddle-go-live:6'], { encoding: 'utf8' }).stdout;

test('Test done, Go Live left: the exit summary offers finishing here, and finishing shows the program finished everywhere and never reopens Go Live', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(STOP_AFTER_TEST);

  // Start, then Finish here. Later: Start fresh from resume, Continue, the four choices, Claude Code, Auto, then stop
  // before the session.
  const first = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1', '2'] });
  const status = await runWizard(['status'], { cwd: repo, claude, env: CONFIGURED });
  const json = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, claude, env: CONFIGURED })).stdout);
  const line = statusScript(repo);
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2', '1', '1', '3', '', '1', '1', '1', '2'] });

  assert.equal(first.code, 0, first.stdout);
  // Catches: the summary saying it will reopen Go Live no matter what you want.
  assert.match(first.stdout, /Test is done, and Go Live is the only step left\. If you're not going to Production now, you can finish here\.\nNext\n\s+1\) Resume at Go Live later \(run `wizard resume`\)\n\s+2\) Finish here \(skip Go Live\)\n/);
  assert.doesNotMatch(first.stdout, /reopen the session at Go Live/);
  assert.match(first.stdout, /Finished, without Go Live\./);
  // Catches: status, its JSON and the status line still showing Go Live pending.
  assert.match(status.stdout, /Saved run\s+integration program, completed: you finished after Test and skipped Go Live\n\s+Progress\s+Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live skipped\n/);
  assert.deepEqual([json.run.state, json.run.progress, json.run.skippedSteps, json.run.paste], ['completed', 'Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live skipped', ['straddle-go-live'], null]);
  assert.equal(line, 'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live skipped\n');
  // Catches: resume silently reopening Go Live after you finished, or Start fresh not starting over.
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.match(resumed.stdout, /You finished the saved integration run after Test and skipped Go Live, so there's nothing to resume\.[^\n]*\nNext\n\s+1\) Leave it finished\n\s+2\) Start fresh \(I keep your current files beside the new ones\)\n/);
  assert.equal(launches(claude).length, 1);
  assert.deepEqual(readdirSync(repo).filter((f) => f.includes('.previous-')).map((f) => f.replace(/\d+$/, 'N')).sort(), ['straddle-integration-plan.md.previous-N', 'straddle-integration-report.md.previous-N', 'straddle-setup.md.previous-N', 'straddle-test-evidence.md.previous-N']);
  assert.deepEqual([readReceipt(repo).state, readReceipt(repo).stateReason], ['ready', 'stopped before Setup']);
});

test('Finish here from the `wizard resume` menu keeps the program finished everywhere, even after events.jsonl was cut off mid-line', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(STOP_AFTER_TEST);

  // Start, then Resume at Go Live later. An interrupted writer leaves the file without its last newline.
  await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1', '1'] });
  const events = join(repo, '.straddle-wizard', 'events.jsonl');
  writeFileSync(events, `${readFileSync(events, 'utf8')}{"at":"2026-10-01T00:00:00Z","kind":"step-ent`);
  const finished = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });
  const status = await runWizard(['status'], { cwd: repo, claude, env: CONFIGURED });
  const json = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, claude, env: CONFIGURED })).stdout);
  const again = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1'] });

  assert.equal(finished.code, 0, finished.stdout);
  assert.match(finished.stdout, /Next\n\s+1\) Resume at Go Live\n\s+2\) Finish here \(skip Go Live\)\n\s+3\) Cancel\nChoose \[1\]: \n\nFinished, without Go Live\./);
  // Catches: the finish glued onto the cut-off line and dropped, so everything but the receipt still shows Go Live pending.
  assert.match(status.stdout, /Saved run\s+integration program, completed: you finished after Test and skipped Go Live\n\s+Progress\s+Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live skipped \(I skipped 1 unreadable line/);
  assert.deepEqual([json.run.state, json.run.skippedSteps], ['completed', ['straddle-go-live']]);
  assert.equal(statusScript(repo), 'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live skipped\n');
  assert.match(again.stdout, /You finished the saved integration run after Test and skipped Go Live, so there's nothing to resume\.[^\n]*\nNext\n\s+1\) Leave it finished\n/);
  assert.equal(launches(claude).length, 1);
  assert.equal(readReceipt(repo).state, 'completed');
});

test('Test done, Go Live left: choosing resume keeps Go Live next, and `wizard resume` reopens the session there', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(STOP_AFTER_TEST);

  const first = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1', '1'] });
  const afterFirst = readReceipt(repo);
  claude.sessions(DEFAULT_SESSIONS);
  // Resume at Go Live, then Start.
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1'] });
  const afterGoLive = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED });

  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /2\) Finish here \(skip Go Live\)\nChoose \[1\]: \n\nNext: run `wizard resume` and I'll reopen the session at Go Live\.\n/);
  assert.equal(afterFirst.stateReason, 'next: Go Live');
  // Catches: resume losing its Go Live option, or offering no way to finish.
  assert.match(resumed.stdout, /Next\n\s+1\) Resume at Go Live\n\s+2\) Finish here \(skip Go Live\)\n\s+3\) Cancel\n/);
  const [, second] = launches(claude);
  assert.ok(second!.at(-1)!.startsWith('/straddle:straddle-go-live\nStraddle Wizard program: straddle-go-live. Start at straddle-go-live.\n'), second!.at(-1));
  assert.equal(readReceipt(repo).state, 'completed');
  assert.equal(statusLines(claude).at(-1), 'Straddle: Setup ✓ · Plan ✓ · Integrate ✓ · Test ✓ · Go Live ✓');
  // Catches: a run that finished with Go Live getting the skipped run's finish menu.
  assert.equal(afterGoLive.code, 0, afterGoLive.stdout);
  assert.match(afterGoLive.stdout, /Everything in the saved integration run is done and on file\. There's nothing to resume\.\n$/);
});

test('Test done, Go Live left: plain `wizard` offers to finish here like `wizard resume` does, and finishing never reopens Go Live', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(STOP_AFTER_TEST);

  // Start, then Resume at Go Live later. Then plain `wizard`: Finish here.
  await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1', '1'] });
  const again = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });

  // Catches: plain `wizard` only reopening Go Live, so finishing needs `wizard resume`.
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /Start fresh or resume\?\n\s+1\) Resume the integration run at Go Live\n\s+2\) Finish here \(skip Go Live\)\n\s+3\) Start fresh \(I keep your current files beside the new ones\)\n\s+4\) Cancel\nChoose \[1\]: \n\nFinished, without Go Live\./);
  assert.equal(launches(claude).length, 1);
  assert.deepEqual([readReceipt(repo).state, readReceipt(repo).stateReason], ['completed', 'you finished after Test and skipped Go Live']);
});

test('a plan edited after finishing without Go Live voids the finish: resume goes back to Plan and offers no finish', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(STOP_AFTER_TEST);

  await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1', '2'] });
  writeFiles(repo, { 'straddle-integration-plan.md': APPROVED_PLAN.replace('add client', 'add client and payouts') });
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });
  const json = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, claude, env: CONFIGURED })).stdout);

  // Catches: a finish made for the earlier plan still closing the program.
  assert.match(resumed.stdout, /Next\n\s+1\) Resume at Plan\n\s+2\) Cancel\n/);
  assert.doesNotMatch(resumed.stdout, /nothing to resume|Go Live\s+skipped/);
  assert.match(json.run.progress, /^Setup ✓ · Plan ▶ \d+ · Integrate ▶ \d+ · Test ▶ \d+ · Go Live$/);
  assert.deepEqual(json.run.skippedSteps, []);
});

test('Test not complete: neither the exit summary, resume nor plain `wizard` offers to finish without Go Live', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions({
    ...DEFAULT_SESSIONS,
    'straddle-test': { ...DEFAULT_SESSIONS['straddle-test'], writes: [{ path: 'straddle-test-evidence.md', content: EVIDENCE.replace('Status: complete', 'Status: partial (1 failed)') }], text: handoff('straddle-test', 'failed'), stop: true },
  });

  const first = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });
  const plain = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: ['3'] });

  // Catches: finishing offered while Test is unfinished.
  assert.match(first.stdout, /Next: fix what stopped the run \(Test stopped at failed;[^\n]*\), then run `wizard resume` and I'll reopen the session at Test\./);
  assert.match(resumed.stdout, /Next\n\s+1\) Resume at Test\n\s+2\) Cancel\n/);
  assert.match(plain.stdout, /Start fresh or resume\?\n\s+1\) Resume the integration run at Test\n\s+2\) Start fresh[^\n]*\n\s+3\) Cancel\n/);
  for (const out of [first.stdout, resumed.stdout, plain.stdout]) assert.doesNotMatch(out, /Finish here/);
});

test('Go Live already reported not ready for this plan: no finish is offered, so the not-ready result stays in view', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions({
    ...DEFAULT_SESSIONS,
    'straddle-go-live': { ...DEFAULT_SESSIONS['straddle-go-live'], writes: [{ path: 'straddle-go-live-report.md', content: `# Straddle Go Live review\n\nStatus: not ready (no Production webhook secret)\nPlan: straddle-integration-plan.md\nPlan hash: ${PLAN_HASH}\n` }], text: handoff('straddle-go-live', 'not_ready') },
  });

  const first = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['2'] });
  const plain = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: ['3'] });

  // Catches: finishing offered after Go Live ran, which would turn its not-ready row into "skipped".
  assert.match(first.stdout, /Next: fix what stopped the run \(Go Live stopped at not_ready;[^\n]*\), then run `wizard resume` and I'll reopen the session at Go Live\./);
  assert.match(resumed.stdout, /Go Live\s+straddle-go-live-report\.md: Status: not ready \(no Production webhook secret\)[^\n]*\n[\s\S]*Next\n\s+1\) Resume at Go Live\n\s+2\) Cancel\n/);
  assert.match(plain.stdout, /Start fresh or resume\?\n\s+1\) Resume the integration run at Go Live\n\s+2\) Start fresh[^\n]*\n\s+3\) Cancel\n/);
  for (const out of [first.stdout, resumed.stdout, plain.stdout]) assert.doesNotMatch(out, /Finish here/);
});

test('with Straddle files already here, the Wizard asks to start fresh or resume: fresh sets them aside only once the run is confirmed, resume starts at the first unfinished step', async () => {
  const fresh = nextRepo();
  writeFiles(fresh, { 'straddle-setup.md': SETUP_FILE, 'straddle-integration-plan.md': APPROVED_PLAN });
  const claude = fakeClaude();

  // Start fresh, Continue, the four choices, then Cancel at the agent choice: nothing moves.
  const cancelled = await runWizard([], { cwd: fresh, claude, env: CONFIGURED, input: ['2', '1', '1', '3', '', '1', '4'] });

  assert.match(cancelled.stdout, /This repo already has Straddle files from an earlier run/);
  assert.match(cancelled.stdout, /Start fresh or resume\?\n\s+1\) Resume at Integrate\n\s+2\) Start fresh/);
  assert.match(cancelled.stdout, /Cancelled\. Your earlier Straddle files stay where they were\./);
  assert.equal(readFileSync(join(fresh, 'straddle-integration-plan.md'), 'utf8'), APPROVED_PLAN);
  assert.deepEqual(readdirSync(fresh).filter((f) => f.includes('.previous-')), []);

  // Start fresh again and choose Claude Code, then stop before the session: the earlier files now sit beside the new ones.
  await runWizard([], { cwd: fresh, claude, env: CONFIGURED, input: ['2', '1', '1', '3', '', '1', '1', '1', '2'] });

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
  assert.equal(statusLines(claude)[0], 'Straddle: Setup · Plan ▶ 0/n · Integrate · Test · Go Live', 'a session that skips Setup marks Plan, not Setup');
  assert.ok(one!.at(-1)!.startsWith('/straddle:straddle-plan\nStraddle Wizard program: straddle-plan. Start at straddle-plan.\n'), one!.at(-1));
  assert.equal(resumed.code, 0, resumed.stdout);
  // Plan finished in the first session, so it isn't listed again.
  assert.ok(two!.at(-1)!.startsWith('/straddle:straddle-setup\nStraddle Wizard program: straddle-setup → straddle-integrate → straddle-test → straddle-go-live. Start at straddle-setup.\n'), two!.at(-1));
  assert.equal(readReceipt(repo).state, 'completed');

  // `wizard setup` on its own still runs Setup, which reports the missing key.
  const alone = nextRepo();
  const setupOnly = await runWizard(['setup', '--client', 'claude'], { cwd: alone, claude, env: {}, input: [...CHOICES, '1', '1'] });
  assert.match(setupOnly.stdout, /Setup\s+straddle-setup\.md: Status: blocked \(STRADDLE_API_KEY not set\) · reported blocked/);
});

test('another payment provider in the repo adds Migrate to the program', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': JSON.stringify({ dependencies: { next: '15.0.0', stripe: '17.0.0' }, devDependencies: { typescript: '5.6.0' } }) });

  const r = await runWizard([], { cwd: repo, claude: fakeClaude(), env: CONFIGURED, input: [...CHOOSE_CONTEXT, '2'] });

  assert.match(r.stdout, /Program\s+Setup → Plan → Migrate → Integrate → Test → Go Live \(Migrate, because you already use stripe\)/);
  assert.match(r.stdout, /Your session in Claude Code: Setup → Plan → Migrate → Integrate → Test → Go Live/);
});

test('Plaid Link alone is a bank connection for Plan, shown on the context screen and handed to the agent, while Plaid Transfer adds Migrate', async () => {
  const linkOnly = nextRepo();
  writeFiles(linkOnly, {
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0', plaid: '29.0.0' }, devDependencies: { typescript: '5.6.0' } }),
    'src/plaid.ts': 'await plaid.linkTokenCreate(request);\nawait plaid.processorTokenCreate({ access_token, account_id, processor });\n',
  });
  const claude = fakeClaude();

  // Continue and the choices, then Auto and Start for Plan alone.
  const link = await runWizard(['plan', '--client', 'claude'], { cwd: linkOnly, claude, env: CONFIGURED, input: [...CHOICES, '1', '1'] });

  assert.match(link.stdout, /Provider code\s+none to migrate from\n\s+Bank connection\s+Plaid Link found: Plan will ask whether to keep Plaid tokens or move to Straddle Bridge\n/);
  assert.match(launches(claude)[0]!.at(-1)!, /framework Next\.js \(detected\)\. Bank connection already in the repo: Plaid Link with processor tokens \(detected; a Plan decision, not part of a migration\)\. Developer choices/);
  assert.deepEqual(readReceipt(linkOnly).context.bankLink, { source: 'plaid', processorTokens: true });

  const both = nextRepo();
  writeFiles(both, {
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0', plaid: '29.0.0' }, devDependencies: { typescript: '5.6.0' } }),
    'src/plaid.ts': 'await plaid.linkTokenCreate(request);\nawait plaid.transferCreate({ access_token, account_id, authorization_id });\n',
  });
  const r = await runWizard([], { cwd: both, claude: fakeClaude(), env: CONFIGURED, input: [...CHOOSE_CONTEXT, '2'] });

  assert.match(r.stdout, /Bank connection\s+Plaid Link found: Plan will ask whether to keep Plaid tokens or move to Straddle Bridge\n\s+Program\s+Setup → Plan → Migrate → Integrate → Test → Go Live \(Migrate, because you already use plaid\)/);
});

const PLAID_PACKAGE = JSON.stringify({ dependencies: { next: '15.0.0', plaid: '29.0.0' }, devDependencies: { typescript: '5.6.0' } });

test('a run keeps the Migrate step it started with after Migrate replaces the Plaid Transfer calls, in status and resume', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': PLAID_PACKAGE, 'src/plaid.ts': 'await plaid.linkTokenCreate(request);\nawait plaid.transferCreate({ access_token, account_id, authorization_id });\n' });
  const fake = fakeClients('✓ Logged in as dev@example.com');
  // No STRADDLE_API_KEY, so the session runs the steps that send no Straddle request. The choices, then stop at the handoff.
  await runWizard(['--client', 'codex', '--mode', 'manual'], { cwd: repo, env: fake.env, input: [...CHOICES, '2'] });
  // What Migrate does: the Transfer call becomes a Straddle charge, and Link stays.
  writeFiles(repo, { 'src/plaid.ts': 'await plaid.linkTokenCreate(request);\nawait straddle.charges.create(charge);\n' });

  const status = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, env: fake.env })).stdout);
  // Resume at Plan, then stop at the handoff.
  const resumed = await runWizard(['resume'], { cwd: repo, env: fake.env, input: ['1', '2'] });

  assert.match(status.run.progress, /Plan · Migrate · Integrate/);
  assert.match(status.run.paste, /Straddle Wizard program: straddle-plan → straddle-migrate\. Start at straddle-plan\./);
  assert.match(resumed.stdout, /Straddle Wizard program: straddle-plan → straddle-migrate\. Start at straddle-plan\./);
});

test('a run saved before the Wizard recorded Plaid facts keeps the Migrate step it started with and gets Plaid Link from the repo, the same in status as in resume', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': PLAID_PACKAGE, 'src/plaid.ts': 'await plaid.linkTokenCreate(request);\nawait plaid.itemPublicTokenExchange({ public_token });\n' });
  const fake = fakeClients('✓ Logged in as dev@example.com');
  await runWizard(['--client', 'codex', '--mode', 'manual'], { cwd: repo, env: fake.env, input: [...CHOICES, '2'] });
  const saved = readReceipt(repo) as unknown as { context: Record<string, unknown> };
  delete saved.context.providers;
  delete saved.context.bankLink;
  writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), JSON.stringify(saved));
  const sentence = 'Bank connection already in the repo: Plaid Link (detected; a Plan decision, not part of a migration).';

  const status = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, env: fake.env })).stdout);
  const resumed = await runWizard(['resume'], { cwd: repo, env: fake.env, input: ['1', '2'] });

  assert.ok(status.run.paste.includes(sentence), status.run.paste);
  assert.match(status.run.progress, /Plan · Migrate · Integrate/);
  assert.ok(resumed.stdout.replace(/\s+/g, ' ').includes(sentence), resumed.stdout);
  assert.deepEqual({ providers: readReceipt(repo).context.providers, bankLink: readReceipt(repo).context.bankLink }, { providers: ['plaid'], bankLink: { source: 'plaid', processorTokens: false } });
});

test('readiness says the session runs with the developer\'s own settings and promises no permission prompt', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();

  // Continue, then stop at Start: only the readiness screen matters.
  const r = await runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '2'] });

  assert.match(r.stdout, /Session settings\s+yours: I start Claude Code with your own settings, including your permission mode and any `env` values/);
  // A Claude Code settings `env` block overrides the shell in the session, so the shell values the Wizard checked are labelled as such.
  assert.match(r.stdout, /Straddle key\s+STRADDLE_API_KEY is set in your shell/);
  assert.match(r.stdout, /Environment\s+sandbox \(STRADDLE_ENVIRONMENT\) in your shell; any `env` value in your Claude Code settings overrides it in the session, and the skills check the environment again there/);
  assert.doesNotMatch(r.stdout, /Isolated|asks before edits|add only/);
});

test('Integrate never starts before the durable plan exists', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1'] });

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
    const r = await runWizard([program, '--client', 'claude'], { cwd: repo, claude: fakeClaude(), env: CONFIGURED, input: ['1', '1', '2'] });

    assert.match(r.stdout, /Plan: straddle-integration-plan\.md \(Plan state: Draft\)/, program);
    assert.match(r.stdout, new RegExp(`${title} runs only an approved plan: an approval recorded in the file that matches the current plan`), program);
    assert.match(r.stdout, /Editing the plan after approval voids the record/, program);
  }

  const migrationRepo = nextRepo();
  writeFiles(migrationRepo, { 'straddle-migration-plan.md': PLAN });
  const mr = await runWizard(['test', '--client', 'claude'], { cwd: migrationRepo, claude: fakeClaude(), env: CONFIGURED, input: ['1', '1', '2'] });
  assert.match(mr.stdout, /Plan: straddle-migration-plan\.md \(Plan state: Draft\)/);
  assert.match(mr.stdout, /Test runs only an approved plan: an approval recorded in the file that matches the current plan/);
});

test('a step file the agent opens with a shell command is observed as entered, like one opened with Read', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.sessions({ 'straddle-integrate': { steps: ['01-begin', '05-execute'], shellSteps: ['06-review', '07-handoff'], text: handoff('straddle-integrate', 'complete') } });

  const r = await runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Integrate\s+straddle-integration-report\.md: not written yet · reported complete · 4 of \d+ step files opened/);
});

test('an edit the developer denies in the agent is not reported as a change, and the step stays blocked', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': PLAN });
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({
    'straddle-integrate': {
      steps: ['01-begin', '02-sources', '03-code'], denied: ['03-code', 'src/straddle.ts'],
      writes: [{ path: 'src/straddle.ts', content: 'export {}' }], text: handoff('straddle-integrate', 'blocked'),
    }
  });

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1', '1'] });

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

  const r = await runWizard(['test'], { cwd: repo, claude, env: { STRADDLE_ENVIRONMENT: 'production' }, input: ['1', '1', '1'] });

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

  const r = await runWizard(['integrate'], { cwd: repo, claude, env: {}, input: ['1', '1', '1'] });

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
  const r = await runWizard(['test'], { cwd: repo, claude, env, input: ['1', '1', '1'] });

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

  const a = await runWizard(['integrate', '--client', 'claude'], { cwd: linked, claude, input: ['1', '1'] });
  const b = await runWizard(['integrate', '--client', 'claude', '--exclude', 'straddle-integration-plan.md'], { cwd: excluded, claude, input: ['1', '1'] });

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

  const aborted = await runWizard(['plan', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOICES, '1', '1'] });
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
    return runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1'] });
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
  claude.sessions({
    'straddle-plan': {
      steps: ['01-decisions'],
      writes: [{ path: 'straddle-integration-plan.md', content: PLAN }, { path: 'src/private-data.txt', content: 'after' }],
      text: handoff('straddle-plan', 'draft'),
    }
  });

  // Change > Framework > CUSTOM_FRAMEWORK, Continue, then Cancel at the first product question.
  const first = await runWizard(['plan', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['2', '2', 'CUSTOM_FRAMEWORK', '1', '5'] });
  // A receipt saved before the Wizard asked Auto or Manual has no mode at all.
  const saved = readReceipt(repo) as unknown as Record<string, unknown>;
  delete saved.mode;
  writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), JSON.stringify(saved));
  // Resume, then the four choices, then Auto, then Start.
  const resumed = await runWizard(['resume', '--client', 'claude', '--exclude', 'src/private-data.txt'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '3', '', '1', '1', '1'] });

  assert.equal(first.code, 130, first.stdout);
  assert.match(resumed.stdout, /Choices\s+not answered yet; I'll ask before your agent starts/);
  assert.match(resumed.stdout, /Mode\s+not chosen yet; I'll ask\n[\s\S]*How do you want to run the setup\?/);
  assert.equal(readReceipt(repo).mode, 'auto');
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
  await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: [...CHOICES, '1', '1'] });
  const completed = readReceipt(repo);

  // Start fresh (a completed run offers no resume), Continue, then stop before Audit starts.
  const r = await runWizard(['audit', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '1', '1', '2'] });

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

  const r = await runWizard(['audit'], { cwd: repo, claude, input: ['1', '1', '1', '1'] });

  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Findings \(straddle-audit-report\.md\)\n.*\n.*\n\s+\| 1 \| src\/pay\.ts:12 \| idempotency \| create without key \| high \|/);
  assert.match(r.stdout, /✓ Audit\s+writes no status file · reported findings · 2 of/);
});

test('wizard skill run <name> launches that versioned skill in the chosen agent', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.setState({ marketplace: '/b', installed: true });
  claude.sessions({ 'straddle-go-live': { steps: ['01-begin'], text: handoff('straddle-go-live', 'not_ready') } });

  const r = await runWizard(['skill', 'run', 'straddle-go-live'], { cwd: repo, claude, input: ['1', '1', '1', '1'] });

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

test('Manual starts no agent process for any client: it prints the paste text, and status and resume say what to paste next from the files', async () => {
  for (const client of ['claude', 'codex', 'cursor'] as const) {
    const repo = nextRepo();
    const fake = fakeClients('✓ Logged in as dev@example.com');
    const env = { ...CONFIGURED, ...fake.env };
    const paste = new RegExp(`Paste this as your message to the ${CLIENT_LABEL[client]} agent:\\n\\s+${client === 'claude' ? '/straddle:straddle-setup' : 'Use the straddle-setup skill\\.'}\\n\\s+Straddle Wizard program: straddle-setup\\. Start at straddle-setup\\.\\n`);

    // The choices, Manual, then "I'm back" with nothing written.
    const r = await runWizard(['setup', '--client', client], { cwd: repo, env, input: [...CHOICES, '2', '1'] });
    const status = await runWizard(['status'], { cwd: repo, env });
    // Resume at Setup, then stop at the handoff.
    const resumed = await runWizard(['resume'], { cwd: repo, env, input: ['1', '2'] });

    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Manual: I start no agent\. Here's the handoff:/);
    assert.match(r.stdout, paste);
    assert.match(r.stdout, /Setup\s+straddle-setup\.md: not written yet · no handoff reported · progress not observable/);
    assert.match(r.stdout, /Next: run `wizard resume` and I'll read the files and tell you what to paste at Setup\./);
    assert.equal(readReceipt(repo).mode, 'manual', client);
    assert.match(status.stdout, new RegExp(`Paste next\\s+${paste.source}`), client);
    assert.match(resumed.stdout, /Mode\s+Manual \(I tell you what to paste\)/);
    assert.match(resumed.stdout, paste);
    // Every call a fake recorded is an inspection: no agent ran.
    for (const call of fake.calls()) assert.match(call, /^(claude|codex|cursor-agent) (--version|status|auth status --json|login status|plugin (marketplace )?list --json|mcp list --json)$/, `${client}: ${call}`);
  }
});

// A pipe gets the end-of-session report it got before the Wizard drew terminal screens, line for line: plain rows, and
// no report file (a terminal gets straddle-setup.md rendered after the evidence).
test('a piped Setup run that finishes prints the plain end-of-session report, without the report file', async () => {
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-setup.md': SETUP_FILE });
  const r = await runWizard(['setup', '--client', 'cursor', '--mode', 'manual'], { cwd: repo, env: { ...CONFIGURED, ...fake.env }, input: [...CHOICES, '1'] });
  const report = r.stdout.slice(r.stdout.indexOf('Straddle Wizard report:'));
  assert.match(report, /^Straddle Wizard report: setup program, completed\n/);
  assert.match(report, /\n  ✓ Setup  straddle-setup\.md: Status: complete · no handoff reported · progress not observable\n/);
  assert.match(report, /\nServer-side resources\n  The Wizard created or enabled none\. Your agent recorded no Sandbox IDs in straddle-integration-report\.md or straddle-test-evidence\.md\.\n/);
  assert.match(report, /\nEvidence\n  straddle-setup\.md\n/);
  // A pipe gets plain lines: no box drawing, no escape codes, and no rendered report file.
  assert.doesNotMatch(report, /[\u001b┌│└]|^# Straddle setup/m);
});

test('with no checklist printed, the report shows the "Verify before merging" checklist of the last skill this run finished, or ran when it has no state file, and none before', async () => {
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const env = { ...CONFIGURED, ...fake.env };
  const verify = (skill: string) => new RegExp(`Verify before merging \\(from the ${skill} 0\\.1\\.0 skill; I can't see what your agent printed\\)\\n`);
  const setupChecklist = /\n\s+- \[ \] No API key, token, or `\.env` content appears in this report or the conversation\.\n/;

  // The setup program, with Setup's file done: the choices, then "I'm back".
  const single = nextRepo();
  writeFiles(single, { 'straddle-setup.md': SETUP_FILE });
  const r = await runWizard(['setup', '--client', 'cursor', '--mode', 'manual'], { cwd: single, env, input: [...CHOICES, '1'] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, verify('straddle-setup'));
  assert.match(r.stdout, setupChecklist);

  // The integration program: "I'm back" with nothing done, then Setup done and `wizard resume` at Plan.
  const repo = nextRepo();
  const none = await runWizard(['--client', 'cursor', '--mode', 'manual'], { cwd: repo, env, input: [...CHOICES, '1'] });
  writeFiles(repo, { 'straddle-setup.md': SETUP_FILE });
  const setup = await runWizard(['resume'], { cwd: repo, env, input: ['1', '1'] });

  // Catches: Go Live's Production checklist under a run that hasn't reached Go Live.
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.doesNotMatch(none.stdout, /Verify before merging/);
  assert.equal(setup.code, 0, setup.stdout + setup.stderr);
  assert.match(setup.stdout, /Reason\s+next: Plan/);
  assert.match(setup.stdout, verify('straddle-setup'));
  assert.match(setup.stdout, setupChecklist);

  // Audit writes no state file to say it finished, so the session running it is enough: Continue, then "I'm back"
  // (Manual) or Start (Cursor Auto).
  // Catches: no checklist at all for a skill without a state file.
  for (const [mode, why] of [['manual', "I can't see what your agent printed"], ['auto', "your agent didn't print it"]] as const) {
    const audit = await runWizard(['audit', '--client', 'cursor', '--mode', mode], { cwd: nextRepo(), env, input: ['1', '1'] });
    assert.equal(audit.code, 0, `${mode}: ${audit.stdout}${audit.stderr}`);
    assert.match(audit.stdout, new RegExp(`Verify before merging \\(from the straddle-audit 0\\.1\\.0 skill; ${why}\\)\\n\\s+- \\[ \\] Each finding cites application \`file:line\``), mode);
  }
});

test('Cursor and Manual reports tick a step whose file says done, with no handoff to compare; Claude Code still needs its handoff', async () => {
  for (const [client, mode, tick] of [['cursor', 'auto', '✓'], ['cursor', 'manual', '✓'], ['codex', 'manual', '✓'], ['claude', 'auto', ' ']] as const) {
    const repo = nextRepo();
    writeFiles(repo, { 'straddle-setup.md': SETUP_FILE });
    const fake = fakeClients('✓ Logged in as dev@example.com');
    const claude = fakeClaude();
    // Claude Code's session prints no handoff, so its file alone doesn't tick Setup.
    claude.sessions({ 'straddle-setup': { text: 'Setup is done.' } });

    // The choices, then Start (Auto) or "I'm back" (Manual).
    const r = await runWizard(['setup', '--client', client, '--mode', mode], { cwd: repo, claude: client === 'claude' ? claude : undefined, env: { ...CONFIGURED, ...(client === 'claude' ? {} : fake.env) }, input: [...CHOICES, '1'] });

    assert.equal(r.code, 0, `${client} ${mode}: ${r.stdout}${r.stderr}`);
    assert.equal(/\n {2}(.) Setup +straddle-setup\.md: Status: complete · no handoff reported/.exec(r.stdout)?.[1], tick, `${client} ${mode}: ${r.stdout}`);
  }
});

test('Cursor Auto starts cursor-agent with no permission flag, writes no Claude settings, and resume reopens its own chat, never another Cursor chat in the repo', async () => {
  const repo = nextRepo();
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const env = { ...CONFIGURED, ...fake.env };
  // Another chat in this repo, already open, whose transcript is written after the Wizard's on both runs.
  const other = join(fake.env.HOME, '.cursor', 'projects', realpathSync(repo).replace(/[/.]/g, '-').replace(/^-+/, ''), 'agent-transcripts', OTHER_CHAT);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, `${OTHER_CHAT}.jsonl`), '{}\n');
  const later = Date.now() / 1000 + 3600;
  utimesSync(join(other, `${OTHER_CHAT}.jsonl`), later, later);

  // Through a symlink: Cursor names the transcript folder for the real path. The choices, Enter at Auto or Manual
  // (Auto for a logged-in cursor-agent), Start; then resume and Start.
  const link = join(tempDir('link'), 'repo');
  symlinkSync(repo, link);
  const first = await runWizard(['setup', '--client', 'cursor', '--dir', link], { cwd: repo, env, input: [...CHOICES, '', '1'] });
  const resumed = await runWizard(['resume', '--dir', link], { cwd: repo, env, input: ['1', '1'] });

  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  const receipt = readReceipt(repo);
  assert.equal(receipt.mode, 'auto');
  const launched = fake.calls().filter((c) => c.startsWith('cursor-agent --workspace'));
  assert.equal(launched.length, 2);
  assert.match(launched[0]!, /^cursor-agent --workspace \S+ --plugin-dir \S+ Use the straddle-setup skill\.$/);
  assert.match(launched[1]!, new RegExp(`^cursor-agent --workspace \\S+ --plugin-dir \\S+ --resume=${CURSOR_CHAT} Use the straddle-setup skill\\.$`));
  assert.doesNotMatch(fake.calls().join('\n'), /--force|--yolo|--sandbox|--approve-mcps|--trust|--auto-review/);
  assert.deepEqual(receipt.sessions.map((s) => s.sessionId), [CURSOR_CHAT, CURSOR_CHAT]);
  assert.deepEqual(readdirSync(join(repo, '.straddle-wizard', 'runs', receipt.runId)), []);
});

test('Manual without a Sandbox configuration: status pastes what the run and resume hand off, from Plan, and nothing when the next step is blocked', async () => {
  const repo = nextRepo();
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const paste = /Use the straddle-plan skill\.\n\s+Straddle Wizard program: straddle-plan\. Start at straddle-plan\.\n/;

  // No STRADDLE_API_KEY. The choices, then stop at the handoff.
  const r = await runWizard(['--client', 'codex', '--mode', 'manual'], { cwd: repo, env: fake.env, input: [...CHOICES, '2'] });
  const status = await runWizard(['status'], { cwd: repo, env: fake.env });
  // Resume at Setup, then stop at the handoff.
  const resumed = await runWizard(['resume'], { cwd: repo, env: fake.env, input: ['1', '2'] });

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, paste);
  assert.match(status.stdout, new RegExp(`Paste next\\s+Paste this as your message to the Codex agent:\\n\\s+${paste.source}`));
  assert.match(resumed.stdout, paste);

  // Setup and Plan on file: Integrate sends Straddle requests, so there is nothing to paste until the key is set.
  writeFiles(repo, { 'straddle-setup.md': SETUP_FILE, 'straddle-integration-plan.md': APPROVED_PLAN });
  const blocked = await runWizard(['status'], { cwd: repo, env: fake.env });
  const blockedResume = await runWizard(['resume'], { cwd: repo, env: fake.env, input: ['1'] });

  assert.doesNotMatch(blocked.stdout, /Paste next/);
  assert.equal(blockedResume.code, 1, blockedResume.stdout);
  assert.doesNotMatch(blockedResume.stdout, /Paste this/);
  assert.equal(readReceipt(repo).stateReason, 'configuration error: STRADDLE_API_KEY is not set; no environment is declared (STRADDLE_ENVIRONMENT=sandbox)');
});

test('the agent menu offers every supported agent, installed or not: `wizard --mode manual` hands off to one with nothing on PATH', async () => {
  const repo = nextRepo();

  // The choices, Claude Code, then stop at the handoff.
  const r = await runWizard(['--mode', 'manual'], { cwd: repo, env: { ...CONFIGURED, PATH: '/usr/bin:/bin' }, input: [...CHOICES, '1', '2'] });

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Which coding agent should do the work\?\n\s+1\) Claude Code \(not installed here\).*\n\s+2\) Codex \(not installed here\).*\n\s+3\) Cursor \(not installed here\).*\n\s+4\) Cancel/);
  assert.match(r.stdout, /Paste this as your message to the Claude Code agent:\n\s+\/straddle:straddle-setup\n/);
  const receipt = readReceipt(repo);
  assert.equal(receipt.client, 'claude');
  assert.equal(receipt.mode, 'manual');
});

test('Cancel at Auto or Manual stops the run as aborted and moves nothing, on a fresh run and on resume', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-setup.md': SETUP_FILE });
  const claude = fakeClaude();

  // Start fresh, the choices, Claude Code, then Cancel at Auto or Manual.
  const fresh = await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: ['2', ...CHOICES, '1', '3'] });

  assert.equal(fresh.code, 130, fresh.stdout);
  assert.match(fresh.stdout, /Cancelled\. Your earlier Straddle files stay where they were\./);
  assert.equal(readReceipt(repo).state, 'aborted');
  assert.equal(readReceipt(repo).stateReason, 'you cancelled at the Auto or Manual choice');
  assert.equal(readFileSync(join(repo, 'straddle-setup.md'), 'utf8'), SETUP_FILE);
  assert.deepEqual(readdirSync(repo).filter((f) => f.includes('.previous-')), []);

  // A receipt saved before the Wizard asked has no mode: resume asks, and Cancel there aborts too.
  const saved = readReceipt(repo) as unknown as Record<string, unknown>;
  delete saved.mode;
  writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), JSON.stringify(saved));
  const resumed = await runWizard(['resume'], { cwd: repo, claude, env: CONFIGURED, input: ['1', '3'] });

  assert.equal(resumed.code, 130, resumed.stdout);
  assert.match(resumed.stdout, /How do you want to run the setup\?/);
  assert.equal(readReceipt(repo).state, 'aborted');
  assert.equal(readReceipt(repo).stateReason, 'you cancelled at the Auto or Manual choice');
  assert.equal(readReceipt(repo).sessions.length, 0);
  assert.deepEqual(readdirSync(repo).filter((f) => f.includes('.previous-')), []);
});

test('a receipt with an unknown mode is set aside as unreadable', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  // The choices, then Cancel at the agent choice: a saved receipt.
  await runWizard([], { cwd: repo, claude, env: CONFIGURED, input: [...CHOICES, '4'] });
  writeFileSync(join(repo, '.straddle-wizard', 'receipt.json'), JSON.stringify({ ...readReceipt(repo), mode: 'yolo' }));

  const status = JSON.parse((await runWizard(['status', '--json'], { cwd: repo, claude, env: CONFIGURED })).stdout);

  assert.deepEqual(status.run, { error: 'unreadable receipt: unknown mode' });
});

test('Cursor Auto while cursor-agent is logged out: the Wizard gives the login command, rechecks, and starts nothing', async () => {
  const repo = nextRepo();
  const fake = fakeClients('Not logged in');

  // The choices, then Recheck once and Stop.
  const r = await runWizard(['setup', '--client', 'cursor', '--mode', 'auto'], { cwd: repo, env: { ...CONFIGURED, ...fake.env }, input: [...CHOICES, '1', '2'] });

  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.stdout.match(/Cursor isn't logged in\. Run `cursor-agent login` in your terminal, then choose Recheck\./g)?.length, 2);
  assert.match(r.stdout, /1\) Recheck\n\s+2\) Stop here/);
  assert.equal(readReceipt(repo).stateReason, 'Cursor is not logged in');
  assert.deepEqual(fake.calls().filter((c) => c.startsWith('cursor-agent --workspace')), []);
});

test('receipt removal is configuration loss the next run reports as a fresh start', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  await runWizard([], { cwd: repo, claude, input: ['1', '1', '3', '', '1', '4'] });
  rmSync(join(repo, '.straddle-wizard'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'x');

  const r = await runWizard(['resume'], { cwd: repo, claude });

  assert.equal(r.code, 1);
  assert.match(r.stdout, /There's no saved Wizard run in this repo\. Start one with `wizard`\./);
});

// ME-919: a plan the developer revised and re-approved, written from the current Plan template.
const PLAN_TEMPLATE = readFileSync(join(SKILLS_SOURCE, 'skills', 'straddle-plan', 'references', 'plan-template.md'), 'utf8');
const revisedPlan = (sandboxHeading = '## Future Sandbox writes') => PLAN_TEMPLATE
  .replace('| | Products | charges / payouts / both | | |', '| 1 | Products | charges | developer | |')
  .replace('| | Bank connection | Bridge widget / Plaid / Quiltt / bank details | | |', '| 3 | Bank connection | Bridge widget | developer | |')
  .replace('| | Notification path | webhook endpoint / FIFO endpoint / polling endpoint | | |', '| 5 | Notification path | polling endpoint | developer | changed course from webhooks |')
  .replace('## Future Sandbox writes', sandboxHeading)
  .replace('| | | SDK method / CLI command / permitted MCP operation | | | |', '| 1 | create customer | SDK | platform | cust-1 | external ID |');
const approved = (plan: string) => plan.replace('- Plan state: Draft | Approved | Blocked', '- Plan state: Approved')
  .replace(/^- Approval: none \|.*$/m, `- Approval: 2026-10-05, "approved", recorded by straddle-plan, sha256 ${approvalHash(plan)}`);

test('after the plan changes course and is re-approved, status, resume and the paste text follow it, also once its approval goes stale', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': PLAID_PACKAGE, 'src/plaid.ts': 'await plaid.linkTokenCreate(request);\nawait plaid.itemPublicTokenExchange({ public_token });\n' });
  const env = { ...CONFIGURED, ...fakeClients('✓ Logged in as dev@example.com').env };
  // The saved run: the choices (webhook endpoint), Manual, then "I'm back".
  await runWizard(['setup', '--client', 'cursor'], { cwd: repo, env, input: [...CHOICES, '2', '1'] });
  const before = await runWizard(['status'], { cwd: repo, env });
  // The plan reran: polling and Bridge, re-approved with a new hash.
  writeFiles(repo, { 'straddle-integration-plan.md': approved(revisedPlan()) });
  const status = await runWizard(['status'], { cwd: repo, env });
  const resumed = await runWizard(['resume'], { cwd: repo, env, input: ['1', '2'] });
  // Edited after approval: the recorded approval no longer matches, and the plan still decides.
  writeFiles(repo, { 'straddle-integration-plan.md': approved(revisedPlan()).replace('## Verification', '## Verification\n\nEdited.') });
  const stale = await runWizard(['status'], { cwd: repo, env });

  assert.match(before.stdout, /notification path webhook endpoint/);
  assert.match(before.stdout, /Bank connection already in the repo: Plaid Link/);
  const context = "Developer choices from the Straddle Wizard: integration type marketplace; SDK TypeScript. Decided in straddle-integration-plan.md, which supersedes the Wizard's saved choices: products charges; notification path polling endpoint; bank connection Bridge widget.";
  for (const out of [status.stdout, resumed.stdout, stale.stdout]) {
    assert.ok(out.includes(context), out);
    assert.doesNotMatch(out, /webhook endpoint|Plaid Link/);
  }
  assert.match(resumed.stdout, /Choices\s+charges, marketplace, TypeScript, polling endpoint \(products and notification path from straddle-integration-plan\.md, which supersedes the choices saved here\)\n/);
});

test('a plan with no readable Decisions table leaves the saved choices in place', async () => {
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-integration-plan.md': `${PLAN}\n## Decisions\n\nnotification path: polling\n` });
  const env = { ...CONFIGURED, ...fakeClients('✓ Logged in as dev@example.com').env };

  await runWizard(['setup', '--client', 'cursor'], { cwd: repo, env, input: [...CHOICES, '2', '1'] });
  const resumed = await runWizard(['resume'], { cwd: repo, env, input: ['1', '2'] });

  assert.match(resumed.stdout, /Choices\s+charges, marketplace, TypeScript, webhook endpoint\n/);
  assert.ok(resumed.stdout.includes('Developer choices from the Straddle Wizard: products charges; integration type marketplace; SDK TypeScript; notification path webhook endpoint.'), resumed.stdout);
});

test('a Decisions answer the developer left Unresolved settles nothing, so the saved choice stays', async () => {
  const repo = nextRepo();
  const plan = revisedPlan().replace('| 5 | Notification path | polling endpoint | developer | changed course from webhooks |', '| 5 | Notification path | Unresolved | developer | can\'t answer now |');
  writeFiles(repo, { 'straddle-integration-plan.md': plan });
  const env = { ...CONFIGURED, ...fakeClients('✓ Logged in as dev@example.com').env };

  await runWizard(['setup', '--client', 'cursor'], { cwd: repo, env, input: [...CHOICES, '2', '1'] });
  const resumed = await runWizard(['resume'], { cwd: repo, env, input: ['1', '2'] });

  assert.match(resumed.stdout, /Choices\s+charges, marketplace, TypeScript, webhook endpoint \(products from straddle-integration-plan\.md, which supersedes the choices saved here\)\n/);
  assert.ok(resumed.stdout.includes("Developer choices from the Straddle Wizard: integration type marketplace; SDK TypeScript; notification path webhook endpoint. Decided in straddle-integration-plan.md, which supersedes the Wizard's saved choices: products charges; bank connection Bridge widget."), resumed.stdout);
  assert.doesNotMatch(resumed.stdout, /Unresolved/);
});

test('the plan summary finds Future Sandbox writes in a template plan, including a revised heading', async () => {
  for (const heading of ['## Future Sandbox writes', '## Future Sandbox writes (revised)']) {
    const repo = nextRepo();
    writeFiles(repo, { 'straddle-integration-plan.md': revisedPlan(heading) });

    const r = await runWizard(['integrate', '--client', 'claude'], { cwd: repo, claude: fakeClaude(), env: CONFIGURED, input: ['1', '1', '2'] });

    assert.match(r.stdout, /  Future Sandbox writes\n[\s\S]*?\n    \| 1 \| create customer \| SDK \| platform \| cust-1 \| external ID \|\n/, heading);
    assert.doesNotMatch(r.stdout, /section not found/, heading);
  }
});

test('the report lists the Sandbox IDs the agent recorded apart from what the Wizard did, and never prints a value that is not an ID', async () => {
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const repo = nextRepo();
  writeFiles(repo, {
    'straddle-setup.md': SETUP_FILE,
    'straddle-integration-report.md': `${report('complete')}\n## Sandbox writes run\n| # | Operation | Tool | Acting account | External ID | Idempotency key | Result | ID | Created or reused | Approved at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | create customer | SDK | platform | cust-1 | k1 | 201 | 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b | created | 10:00 |\n| 2 | create paykey | SDK | platform | pk-1 | k2 | 201 | tok.secret.value | created | 10:01 |\n| 3 | create charge | SDK | platform | ch-1 | k3 | 201 | sk_test_leaked | created | 10:02 |\n| 4 | create webhook | SDK | platform | wh-1 | k4 | 201 | whsec_leaked123 | created | 10:03 |\n| 5 | sk_live_label_leak | SDK | platform | x-1 | k5 | 201 | 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c | created | 10:04 |\n\n## Tests\n`,
    'straddle-test-evidence.md': `${EVIDENCE}\n### Server-side resources\n| Resource | ID | External ID | Acting account | Status | Executing tool | Replayed | Created, reused, or observed |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| charge | ${CHARGE} | ch-2 | platform | paid | SDK | no | created |\n| customer | 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d | cu-2 | platform | verified | SDK | no | whsec_origin_leak |\n\n## Run r0, 2026-09-29\n\n### Server-side resources\n| Resource | ID | External ID | Acting account | Status | Executing tool | Replayed | Created, reused, or observed |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| charge | 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e | ch-0 | platform | paid | SDK | no | created |\n`,
  });

  const r = await runWizard(['setup', '--client', 'cursor', '--mode', 'manual'], { cwd: repo, env: { ...CONFIGURED, ...fake.env }, input: [...CHOICES, '1'] });

  assert.ok(r.stdout.includes([
    'Server-side resources',
    "  The Wizard created or enabled none. Your agent recorded these Sandbox IDs; I didn't verify them:",
    '    straddle-integration-report.md: create customer 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b (created)',
    `    straddle-test-evidence.md: charge ${CHARGE} (created)`,
    '    straddle-test-evidence.md: customer 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
    "  I left out 4 rows that don't look like a Sandbox resource record.",
    'Checks',
  ].join('\n')), r.stdout);
  assert.doesNotMatch(r.stdout, /tok\.secret\.value|sk_test_leaked|whsec_|sk_live_label_leak|4a5e/);
});

test("the report never calls a record a Sandbox ID when the latest run's target was offline synthetic, or when the record is from an older run", async () => {
  const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const resources = `### Server-side resources\n\n| Resource | ID | External ID | Acting account | Status | Executing tool | Replayed | Created, reused, or observed |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| charge | ${id} | ch-1 | platform | paid | SDK | no | created |\n`;
  const head = (latest: string) => `# Straddle test evidence\n\nStatus: complete\nPlan: straddle-integration-plan.md\nPlan hash: ${PLAN_HASH}\nLatest run: ${latest}\nTest charge: none\n\n`;
  const none = '  The Wizard created or enabled none. Your agent recorded no Sandbox IDs in straddle-integration-report.md or straddle-test-evidence.md.';
  const cases = [
    // Test step 06-evidence: an offline synthetic run lists its synthetic upstream records under Server-side resources.
    [`${head('r1')}## Run r1, 2026-10-05\n\n- Status: passed\n- Target: offline synthetic localhost http://127.0.0.1:4010: offline synthetic proof, not live Straddle Sandbox proof\n\n${resources}`,
    [none, "  straddle-test-evidence.md records an offline synthetic target, so I list none of its records as Sandbox IDs."]],
    // The latest run recorded no resources table; the older run's resource isn't the latest run's.
    [`${head('r2')}## Run r2, 2026-10-05\n\n- Status: blocked\n- Target: Straddle Sandbox\n\n## Run r1, 2026-10-04\n\n- Status: passed\n- Target: Straddle Sandbox\n\n${resources}`, [none]],
    // A live run still lists its IDs.
    [`${head('r1')}## Run r1, 2026-10-05\n\n- Status: passed\n- Target: Straddle Sandbox\n\n${resources}`,
    ["  The Wizard created or enabled none. Your agent recorded these Sandbox IDs; I didn't verify them:", `    straddle-test-evidence.md: charge ${id} (created)`]],
  ] as const;
  for (const [evidence, lines] of cases) {
    const repo = nextRepo();
    writeFiles(repo, { 'straddle-setup.md': SETUP_FILE, 'straddle-test-evidence.md': evidence });

    const r = await runWizard(['setup', '--client', 'cursor', '--mode', 'manual'], { cwd: repo, env: { ...CONFIGURED, ...fakeClients('✓ Logged in as dev@example.com').env }, input: [...CHOICES, '1'] });

    assert.ok(r.stdout.includes(['Server-side resources', ...lines, 'Checks'].join('\n')), r.stdout);
  }
});

// The journey in this process on a fake 100-column terminal, through the Prompter it takes as an option, with NO_COLOR
// so the boxes carry no escape codes.
async function inTerminal(run: (opts: JourneyOptions) => Promise<number>, opts: Omit<JourneyOptions, 'io'>, input: string[]): Promise<string> {
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    let text = '';
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, write: (chunk: string) => { text += chunk; return true; } });
    const answers = new PassThrough();
    answers.end(input.join('\n') + '\n');
    await run({ ...opts, io: new Prompter(answers, output) });
    return text;
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
}

test('in a terminal the end-of-session report renders the Audit report boxed; a pipe still prints none of it', async () => {
  const fake = fakeClients('✓ Logged in as dev@example.com');
  const env = { ...CONFIGURED, ...fake.env, STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases' };
  const auditReport = '# Straddle audit report\n\nStatus: findings\n\n## Findings\n\n| Finding | File | Confidence |\n| --- | --- | --- |\n| Webhook signature not verified | src/webhooks.ts:12 | high |\n';
  const repo = nextRepo();
  writeFiles(repo, { 'straddle-audit-report.md': auditReport });
  // Continue, then "I'm back".
  const screen = await inTerminal((opts) => start('audit', opts), { repo, env, bundlePath: SKILLS_SOURCE, client: 'cursor', mode: 'manual', exclude: [] }, ['1', '1']);
  const piped = nextRepo();
  writeFiles(piped, { 'straddle-audit-report.md': auditReport });
  const pipe = await runWizard(['audit', '--client', 'cursor', '--mode', 'manual'], { cwd: piped, env, input: ['1', '1'] });

  assert.ok(screen.includes([
    'Audit report (straddle-audit-report.md)',
    '  Straddle audit report',
    '',
    '  Status: findings',
    '',
    '  Findings',
    '',
    '  ┌────────────────────────────────┬────────────────────┬────────────┐',
    '  │ Finding                        │ File               │ Confidence │',
    '  ├────────────────────────────────┼────────────────────┼────────────┤',
    '  │ Webhook signature not verified │ src/webhooks.ts:12 │ high       │',
    '  └────────────────────────────────┴────────────────────┴────────────┘',
  ].join('\n')), screen);
  assert.equal(pipe.code, 0, pipe.stdout + pipe.stderr);
  assert.ok(!pipe.stdout.includes('Audit report ('), pipe.stdout);
});

test('Go Live not ready: a terminal shows its report once, without repeating the gaps; a pipe lists the gaps as before', async () => {
  const goLive = `# Straddle Go Live review\n\nStatus: not ready (no Production webhook secret)\nPlan: straddle-integration-plan.md\nPlan hash: ${PLAN_HASH}\n\n## Blocking gaps\n\n| Gap | Fix |\n| --- | --- |\n| No Production webhook secret | Set STRADDLE_WEBHOOK_SECRET in Production |\n`;
  const sessions = { ...DEFAULT_SESSIONS, 'straddle-go-live': { ...DEFAULT_SESSIONS['straddle-go-live'], writes: [{ path: 'straddle-go-live-report.md', content: goLive }], text: handoff('straddle-go-live', 'not_ready') } };
  const claude = fakeClaude();
  claude.sessions(sessions);
  const repo = nextRepo();
  const env = { ...CONFIGURED, PATH: [claude.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: repo, FAKE_CLAUDE_STATE: claude.state, STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases' };
  const screen = await inTerminal((opts) => start('integration', opts), { repo, env, bundlePath: BUNDLE_WITHOUT_REVIEW, client: undefined, mode: undefined, exclude: [] }, [...CHOOSE_CONTEXT, '1']);
  const piped = nextRepo();
  const pipeClaude = fakeClaude();
  pipeClaude.sessions(sessions);
  const pipe = await runWizard([], { cwd: piped, claude: pipeClaude, env: CONFIGURED, input: [...CHOOSE_CONTEXT, '1'] });

  assert.ok(screen.includes('Go Live report (straddle-go-live-report.md)'), screen);
  assert.equal(screen.split('No Production webhook secret').length - 1, 1, screen);
  assert.ok(!screen.includes('Go Live gaps'), screen);
  assert.match(pipe.stdout, /Go Live gaps \(straddle-go-live-report\.md\)\n  \| Gap \| Fix \|\n  \| --- \| --- \|\n  \| No Production webhook secret \| Set STRADDLE_WEBHOOK_SECRET in Production \|\n/);
  assert.ok(!pipe.stdout.includes('Go Live report ('), pipe.stdout);
});
