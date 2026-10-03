import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { offerLog } from '../src/log.ts';
import { Prompter } from '../src/ui.ts';
import { runWizard, tempDir, writeFiles } from './helpers.ts';

// Planted fakes. The key is assembled so no scanner reads this file as holding one.
const SECRETS = [['sk', 'test', 'plantedfakekey0001'].join('_'), 'eyJhbGciOiJIUzI1NiJ9.planted.token', '0f3a9c1d2e4b5a6c7d8e', '000123456789'];

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

test('normal session: each step in order, with its tool calls as rows under the step they ran in', async () => {
  const repo = recorded([
    assistant('2026-10-03T10:00:01.000Z', { type: 'tool_use', name: 'Read', input: { file_path: '/b/skills/straddle-setup/steps/01-begin.md' } }),
    assistant('2026-10-03T10:00:03.000Z', { type: 'tool_use', name: 'Write', input: { file_path: 'straddle-setup.md' } }),
    assistant('2026-10-03T10:00:07.000Z', { type: 'text', text: 'Plan drafted.' }),
  ].join('\n'));
  const html = await page(repo);
  const sections = [...html.matchAll(/<h2>(.*?)<\/h2><table>(.*?)<\/table>/g)].map((m) => [m[1], [...m[2]!.matchAll(/<td(?: class="tool")?>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((r) => `${r[1]}: ${r[2]}`)]);
  assert.deepEqual(sections, [
    ['Session start', ['wizard: Session started (abc12345-0000)']],
    ['straddle-setup · 01-begin', ['Read: <code>{&#34;file_path&#34;:&#34;/b/skills/straddle-setup/steps/01-begin.md&#34;}</code>', 'Write: <code>{&#34;file_path&#34;:&#34;straddle-setup.md&#34;}</code>', 'wizard: Edited straddle-setup.md']],
    ['straddle-plan · 01-begin', ['agent: <div class="md">Plan drafted.</div>']],
  ]);
});

test('secrets in the transcript (sk_ key, bearer token, paykey, account number) are redacted before the page is written', async () => {
  const [key, bearer, paykey, account] = SECRETS;
  const repo = recorded([
    assistant('2026-10-03T10:00:03.000Z', { type: 'tool_use', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${bearer}" -d '{"paykey":"${paykey}","account_number":"${account}"}'` } }),
    assistant('2026-10-03T10:00:05.000Z', { type: 'text', text: `STRADDLE_API_KEY=${key}` }),
  ].join('\n'));
  const html = await page(repo);
  for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} is on the page`);
  assert.ok(html.includes(String.raw`<code>{&#34;command&#34;:&#34;curl -H \&#34;Authorization: Bearer [redacted]\&#34; -d &#39;{\&#34;paykey\&#34;:\&#34;[redacted]\&#34;,\&#34;account_number\&#34;:\&#34;[redacted number]\&#34;}&#39;&#34;}</code>`), html);
  assert.ok(html.includes('<div class="md">STRADDLE_API_KEY=[redacted]</div>'), html);
});

test('a resumed session names its transcript twice and every row still shows once; report headings, bullets, bold and code render', async () => {
  const repo = recorded(assistant('2026-10-03T10:00:07.000Z', { type: 'text', text: '## Setup report\n- **Status:** complete\n- Key in `.env`' }));
  const events = readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8');
  const first = JSON.parse(events.split('\n')[0]!);
  writeFiles(repo, { '.straddle-wizard/events.jsonl': `${events}${JSON.stringify({ ...first, at: '2026-10-03T10:00:08.000Z' })}\n` });
  const html = await page(repo);
  assert.equal(html.split('Setup report').length, 2, html);
  assert.ok(html.includes('<div class="md h">Setup report</div><div class="md li">• <strong>Status:</strong> complete</div><div class="md li">• Key in <code class="i">.env</code></div>'), html);
});

test('Codex session: the rollout found by session id gives tool calls, Markdown tables as tables and highlighted code', async () => {
  const repo = realpathSync(tempDir('log-codex'));
  const codexHome = tempDir('log-codex-home');
  const id = '0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b';
  const events = [
    { at: '2026-10-03T10:00:00.000Z', kind: 'session-start', session: id },
    { at: '2026-10-03T10:00:02.000Z', kind: 'step-entered', skill: 'straddle-test', step: '01-begin' },
  ];
  const rollout = [
    { timestamp: '2026-10-03T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'c1' } },
    { timestamp: '2026-10-03T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '| Scenario | Result |\n| --- | --- |\n| charge | passed |\n```ts\nconst ok = "yes"; // done\n```' }] } },
  ];
  writeFiles(repo, { '.straddle-wizard/events.jsonl': events.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  writeFiles(codexHome, { [`sessions/2026/10/03/rollout-2026-10-03T10-00-00-${id}.jsonl`]: rollout.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  const r = await runWizard(['log'], { cwd: repo, env: { CODEX_HOME: codexHome } });
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(join(repo, '.straddle-wizard', 'session-log.html'), 'utf8');
  assert.ok(html.includes('<h2>straddle-test · 01-begin</h2><table><tr><td class="at">2026-10-03T10:00:03.000Z</td><td class="tool">shell</td><td><code>{&#34;command&#34;:[&#34;npm&#34;,&#34;test&#34;]}</code></td></tr>'), html);
  assert.ok(html.includes('<table class="md"><tr><th>Scenario</th><th>Result</th></tr><tr><td>charge</td><td>passed</td></tr></table>'), html);
  assert.ok(html.includes('<pre class="code"><span class="k">const</span> ok = <span class="s">&#34;yes&#34;</span>; <span class="c">// done</span></pre>'), html);
  assert.ok(!html.includes('transcript is missing'), html);
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
