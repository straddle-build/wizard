import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { offerLog } from '../src/log.ts';
import { Prompter } from '../src/ui.ts';
import { runWizard, tempDir, writeFiles } from './helpers.ts';

// A recorded session: events.jsonl, and the Claude Code transcript it names unless `transcript` is null.
function recorded(transcript: string | null): string {
  // The CLI names the repo by its real path (macOS temp dirs sit under /private).
  const repo = realpathSync(tempDir('log-repo'));
  const dir = tempDir('log-transcript');
  const path = join(dir, 'session.jsonl');
  const events = [
    { at: '2026-10-03T10:00:00.000Z', kind: 'session-start', session: 'abc12345-0000', transcript: path },
    { at: '2026-10-03T10:00:02.000Z', kind: 'step-entered', skill: 'straddle-setup', step: '01-begin' },
    { at: '2026-10-03T10:00:04.000Z', kind: 'edit', path: 'straddle-setup.md' },
    { at: '2026-10-03T10:00:06.000Z', kind: 'step-entered', skill: 'straddle-plan', step: '01-begin' },
  ];
  writeFiles(repo, { '.straddle-wizard/events.jsonl': events.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  if (transcript !== null) writeFiles(dir, { 'session.jsonl': transcript });
  return repo;
}

const assistant = (at: string, block: unknown) => JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [block] } });

async function page(repo: string): Promise<string> {
  const r = await runWizard(['log'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `Session log: ${join(repo, '.straddle-wizard', 'session-log.html')}\n`);
  return readFileSync(join(repo, '.straddle-wizard', 'session-log.html'), 'utf8');
}

test('no session recorded: wizard log says so and exits 1 instead of opening an empty page', async () => {
  const repo = realpathSync(tempDir('log-empty'));
  const r = await runWizard(['log'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `No Wizard session is recorded in ${repo}: .straddle-wizard/events.jsonl is missing or empty. Run \`wizard\` first.\n`);
});

// Each step's heading and its rows as `who: body`, read from the page the way a reader scans it.
const sections = (html: string) => [...html.matchAll(/<section><h2>(.*?)<\/h2>([\s\S]*?)<\/section>/g)].map((m) => [m[1], [...m[2]!.matchAll(/<span class="who">(.*?)<\/span><(?:pre|div) class="body[^"]*">([\s\S]*?)<\/(?:pre|div)><\/div>/g)].map((r) => `${r[1]}: ${r[2]}`)]);

test('normal session: each step in order, with its tool calls as rows under the step they ran in', async () => {
  const repo = recorded([
    assistant('2026-10-03T10:00:01.000Z', { type: 'tool_use', name: 'Read', input: { file_path: '/b/skills/straddle-setup/steps/01-begin.md' } }),
    assistant('2026-10-03T10:00:03.000Z', { type: 'tool_use', name: 'Write', input: { file_path: 'straddle-setup.md', content: '# Setup\nStatus: complete\n' } }),
    assistant('2026-10-03T10:00:07.000Z', { type: 'text', text: 'Plan drafted.' }),
  ].join('\n'));
  assert.deepEqual(sections(await page(repo)), [
    ['Session start', ['wizard: Session started (abc12345-0000)']],
    ['straddle-setup · 01-begin', ['Read: file_path: /b/skills/straddle-setup/steps/01-begin.md', 'Write: file_path: straddle-setup.md\ncontent: # Setup\nStatus: complete\n', 'wizard: Edited straddle-setup.md']],
    ['straddle-plan · 01-begin', ['agent: Plan drafted.']],
  ]);
});

// Northwind's planted secrets (tests/recorded-session.test.ts), in every place a transcript carries text, plus an
// account number and a home directory.
const PLANTED = {
  key: ['sk', 'live', '51PlantedFakeKey0001'].join('_'),
  publishable: ['pk', 'live', '51HxQe2KbLxYz9AbCdEf'].join('_'),
  webhook: ['whsec', 'plantedfakewebhooksecret01'].join('_'),
  bearer: 'dGhpc2lzYWZha2ViZWFyZXJ0b2tlbg',
  envKey: 'FAKEKEYVALUE123fake',
  paykey: 'pk7.fake.paykey.token.0042',
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlIn0', 'c2lnbmF0dXJlZmFrZQ'].join('.'),
  hex: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  signature: 't=1700000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd',
  account: '000123456789',
  home: '/Users/dana',
};

test('planted secrets (keys, bearer, KEY=value, paykey, JWT, hex, signature, account number, home directory) never reach the page', async () => {
  const s = PLANTED;
  const repo = recorded([
    assistant('2026-10-03T10:00:03.000Z', { type: 'tool_use', name: 'Bash', input: { command: `STRADDLE_API_KEY=${s.envKey} curl -H "Authorization: Bearer ${s.bearer}" -d '{"paykey": "${s.paykey}", "token": "${s.jwt}", "account_number": "${s.account}"}'\nStraddle-Signature: ${s.signature}` } }),
    assistant('2026-10-03T10:00:04.000Z', { type: 'tool_use', name: 'Write', input: { file_path: `${s.home}/shop/.env.local`, content: `STRADDLE_WEBHOOK_SECRET=${s.webhook}\nHASH=${s.hex}` } }),
    assistant('2026-10-03T10:00:05.000Z', { type: 'text', text: `Use ${s.key} and ${s.publishable}; routing_number: 021000021.\n\n| Account | Opened |\n| --- | --- |\n| ${s.account} | 2026-10-03T10:00:05Z |` }),
  ].join('\n'));
  const html = await page(repo);
  // A bare account number in a table cell goes; the timestamp beside it stays.
  assert.match(html, /│ \[redacted\] *│ 2026-10-03T10:00:05Z │/);
  for (const [name, secret] of Object.entries(PLANTED)) assert.ok(!html.includes(secret), `planted ${name} is on the page`);
  assert.ok(!html.includes('021000021'), 'routing number is on the page');
  // The surrounding command stays readable; only the values go. `Authorization: Bearer` loses both words, as in Northwind.
  const rows = sections(html)[1]![1] as string[];
  assert.ok(rows.includes("Bash: command: STRADDLE_API_KEY=[redacted] curl -H &#34;Authorization: [redacted] [redacted]&#34; -d &#39;{&#34;paykey&#34;: &#34;[redacted]&#34;, &#34;token&#34;: &#34;[redacted]&#34;, &#34;account_number&#34;: &#34;[redacted]&#34;}&#39;\nStraddle-Signature: [redacted],[redacted]"), rows.join('\n---\n'));
  assert.ok(rows.includes('Write: file_path: ~/shop/.env.local\ncontent: STRADDLE_WEBHOOK_SECRET=[redacted]\n[redacted]'), rows.join('\n---\n'));
  assert.match(html, /Use \[redacted\] and \[redacted\]; routing_number: \[redacted\]\./);
});

test('a resumed session names its transcript twice and every row still shows once; a report renders as on the terminal, tables box-drawn', async () => {
  const repo = recorded(assistant('2026-10-03T10:00:07.000Z', { type: 'text', text: '## Setup report\n- **Status:** complete\n\n| Check | Result |\n| --- | --- |\n| CLI | ok |' }));
  const events = readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8');
  const first = JSON.parse(events.split('\n')[0]!);
  writeFiles(repo, { '.straddle-wizard/events.jsonl': `${events}${JSON.stringify({ ...first, at: '2026-10-03T10:00:08.000Z' })}\n` });
  const html = await page(repo);
  assert.equal(html.split('Setup report').length, 2, html);
  const report = sections(html).flatMap(([, rows]) => rows as string[]).find((r) => r.startsWith('agent: '))!.replace(/<[^>]+>/g, '');
  assert.equal(report, 'agent: Setup report\n• Status: complete\n\n┌───────┬────────┐\n│ Check │ Result │\n├───────┼────────┤\n│ CLI   │ ok     │\n└───────┴────────┘');
});

test('Codex session: the rollout found by session id gives its tool calls and replies under the step', async () => {
  const repo = realpathSync(tempDir('log-codex'));
  const codexHome = tempDir('log-codex-home');
  const id = '0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b';
  const events = [
    { at: '2026-10-03T10:00:00.000Z', kind: 'session-start', session: id },
    { at: '2026-10-03T10:00:02.000Z', kind: 'step-entered', skill: 'straddle-test', step: '01-begin' },
  ];
  const rollout = [
    { timestamp: '2026-10-03T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'c1' } },
    { timestamp: '2026-10-03T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] } },
  ];
  writeFiles(repo, { '.straddle-wizard/events.jsonl': events.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  writeFiles(codexHome, { [`sessions/2026/10/03/rollout-2026-10-03T10-00-00-${id}.jsonl`]: rollout.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  const r = await runWizard(['log'], { cwd: repo, env: { CODEX_HOME: codexHome } });
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(join(repo, '.straddle-wizard', 'session-log.html'), 'utf8');
  assert.deepEqual(sections(html), [
    ['Session start', [`wizard: Session started (${id})`]],
    ['straddle-test · 01-begin', ['shell: command: npm test', 'agent: Tests pass.']],
  ]);
});

test('the page replaces a symlink or a world-readable file at its path, never writing through it or keeping its mode', async () => {
  const repo = recorded('');
  const page_ = join(repo, '.straddle-wizard', 'session-log.html');
  const outside = join(tempDir('log-outside'), 'target.txt');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, page_);
  await page(repo);
  assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  assert.equal(lstatSync(page_).isSymbolicLink(), false);
  assert.equal(lstatSync(page_).mode & 0o777, 0o600);
  rmSync(page_);
  writeFileSync(page_, 'old', { mode: 0o644 });
  await page(repo);
  assert.equal(lstatSync(page_).mode & 0o777, 0o600);
});

test('transcript moved: the page still shows the recorded steps and says the transcript is missing', async () => {
  const repo = recorded(null);
  const html = await page(repo);
  assert.match(html, /The client transcript is missing \(moved or deleted\): .*session\.jsonl\. Showing the Wizard's events only\./);
  assert.deepEqual([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]), ['Session start', 'straddle-setup · 01-begin', 'straddle-plan · 01-begin']);
  assert.match(html, /Edited straddle-setup\.md/);
});

// The end-of-session question, answered with `input` (null: input ends, as Ctrl-D does).
async function answer(repo: string, input: string | null): Promise<{ opened: string[]; output: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', (d) => { output += d; });
  if (input === null) stdin.end(); else stdin.write(`${input}\n`);
  const opened: string[] = [];
  await offerLog(new Prompter(stdin, stdout), repo, (path) => opened.push(path));
  return { opened, output };
}

// Piped answers are echoed with a newline after the question, as in every other Wizard prompt.
test('end-of-session question: Enter or y opens the log, n and end of input do not, and a session that recorded nothing is never asked', async () => {
  const repo = recorded('');
  const html = join(repo, '.straddle-wizard', 'session-log.html');
  assert.deepEqual(await answer(repo, ''), { opened: [html], output: `Open the session log? [Y/n] \nOpened ${html}\n` });
  assert.deepEqual((await answer(repo, 'y')).opened, [html]);
  assert.deepEqual(await answer(repo, 'n'), { opened: [], output: 'Open the session log? [Y/n] \n' });
  assert.deepEqual(await answer(repo, null), { opened: [], output: 'Open the session log? [Y/n] ' });
  assert.deepEqual(await answer(tempDir('log-none'), 'y'), { opened: [], output: '' });
});
