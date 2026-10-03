import { execFileSync } from 'node:child_process';
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

// Each step's heading and its rows as `who: text`, read the way a reader scans the page: a tool call's one-line summary
// (or its fields) and a reply's prose, without the highlighted blocks.
const sections = (html: string) => [...html.matchAll(/<section><h2>(.*?)<\/h2>([\s\S]*?)<\/section>/g)].map((m) => [m[1], [...m[2]!.matchAll(/<span class="who">(.*?)<\/span>([\s\S]*?)<\/div>(?=<div class="row|$)/g)].map((r) => `${r[1]}: ${r[2]!.replace(/<div class="expressive-code">[\s\S]*?<\/figure><\/div>/g, '').replace(/<[^>]+>/g, '')}`)]);
// What the page shows once every row is open: its text without markup, highlighted spans joined back up.
const shown = (html: string) => html.replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/ data-code="[^"]*"/g, '').replace(/<[^>]+>/g, '');
const result = (id: string, content: unknown) => JSON.stringify({ type: 'user', timestamp: '2026-10-03T10:00:03.500Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

test('normal session: each step in order, each tool call under the step it ran in, opening to its highlighted result; a reply\'s fenced code highlighted too', async () => {
  const repo = recorded([
    assistant('2026-10-03T10:00:01.000Z', { type: 'tool_use', name: 'Read', input: { file_path: '/b/skills/straddle-setup/steps/01-begin.md' } }),
    assistant('2026-10-03T10:00:03.000Z', { type: 'tool_use', name: 'Write', input: { file_path: 'straddle-setup.md', content: '# Setup\nStatus: complete\n' } }),
    assistant('2026-10-03T10:00:03.200Z', { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }),
    result('b1', [{ type: 'text', text: '12 passing' }]),
    assistant('2026-10-03T10:00:07.000Z', { type: 'text', text: 'Plan drafted.\n```ts\nconst total = 1000; // cents\n```\nNext: Integrate.' }),
  ].join('\n'));
  const html = await page(repo);
  assert.deepEqual(sections(html), [
    ['Session start', ['wizard: Session started (abc12345-0000)']],
    ['straddle-setup · 01-begin', ['Read: file_path: /b/skills/straddle-setup/steps/01-begin.md', 'Write: straddle-setup.md', 'Bash: $ npm test', 'wizard: Edited straddle-setup.md']],
    ['straddle-plan · 01-begin', ['agent: Plan drafted.Next: Integrate.']],
  ]);
  // Write, Bash and the reply's fence; Read has no recorded result here, so it opens to nothing rather than an invented one.
  assert.equal(html.match(/<div class="expressive-code"/g)?.length, 3);
  assert.ok(shown(html).includes('$ npm test12 passing'), 'the Bash result is paired with its call');
  assert.ok(shown(html).includes('# SetupStatus: complete'), 'the written file is shown');
  assert.ok(shown(html).includes('const total = 1000; // cents'), 'the fenced code is shown');
  // Highlighted, not plain or dimmed: the fence reads as TypeScript, in several Ayu Mirage token colors.
  const fence = /<pre data-language="ts"[\s\S]*?<\/pre>/.exec(html)?.[0] ?? '';
  assert.ok(new Set(fence.match(/--0:#[0-9A-F]{6,8}/gi)).size >= 3, fence);
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
  // Values with literal asterisks, plain, in JSON, in backticks and after emphasized labels.
  starPlain: 'hunt*er2secret',
  starJson: 'json*pass*value',
  starSuffix: 'tok12345*tail99',
  starTick: 'tick*key*value',
  starBold: 'bold*secret*value',
  starItalic: 'ital*key*value',
};

// Markdown and quoting around a secret-named value, each line with its value and how the page shows it: label
// delimiters inside and outside the colon, value delimiters, and punctuation or quoted spaces inside the value. No
// `zq` fragment may survive.
const DELIMITED: [string, string][] = [
  ['M1 __API key:__ zq1a*zq1b', 'M1 __API key:__ [redacted]'],
  ['M2 _API key:_ zq2a_zq2b', 'M2 _API key:_ [redacted]'],
  ['M3 __API key__: zq3a,zq3b', 'M3 __API key__: [redacted]'],
  ['M4 **Token**: zq4a;zq4b', 'M4 Token: [redacted]'],
  ['M5 `api_key`: zq5a}zq5b', 'M5 api_key: [redacted]'],
  ['M6 `api_key:` zq6a*zq6b', 'M6 api_key: [redacted]'],
  ['M7 password: **zq7a zq7b**', 'M7 password: [redacted]'],
  ['M8 password: _zq8a zq8b_', 'M8 password: [redacted]'],
  ['M9 password: `zq9a zq9b`', 'M9 password: [redacted]'],
  ['M10 password: ``zq0a zq0b``', 'M10 password: [redacted]'],
  ['M11 "password": "zqAa, zqAb; zqAc"', 'M11 &#34;password&#34;: &#34;[redacted]&#34;'],
  ["M12 'secret': 'zqBa zqBb'", 'M12 &#39;secret&#39;: &#39;[redacted]&#39;'],
  ['M13 PASSWORD=zqCa,zqCb;zqCc}zqCd\\zqCe', 'M13 PASSWORD=[redacted]'],
  ['M14 token = zqDa*zqDb.', 'M14 token = [redacted]'],
  ['M15 **API key:** `zqEa zqEb`', 'M15 API key: [redacted]'],
  ['M16 **Password:** _zqFa,zqFb_, then more', 'M16 Password: [redacted], then more'],
  ['M17 token: `zqf1234`.zqTAIL then prose', 'M17 token: [redacted] then prose'],
  ['M18 password: "zqg1234"zqTAIL then prose', 'M18 password: [redacted] then prose'],
  ['M19 token: **zqh1**.zqi"zqj zqk" then prose', 'M19 token: [redacted] then prose'],
];

// After an unquoted label (`KEY=`, `key: `) the value is the whole shell word: quoted, backticked and emphasized parts
// written together are one value, wherever their spaces are, and the next word after unquoted whitespace stays. After
// a quoted label (JSON) the value is the quoted string and the next field stays. A literal `[redacted]` in recorded
// source is left as written. Each command and its row on the page.
const WORDS: [string, string][] = [
  ['DB_PASSWORD=_zqa1_.zqTAIL npm run migrate', 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ['DB_PASSWORD=*zqb1*,zqTAIL npm run migrate', 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ['DB_PASSWORD="zqc1234".zqTAIL npm run migrate', 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ["DB_PASSWORD='zqd1234',zqTAIL npm run migrate", 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ['DB_PASSWORD=`zqe1234`zqTAIL npm run migrate', 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ['DB_PASSWORD="zqa1".zqb"zqc zqd1" npm run migrate', 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ["DB_PASSWORD='zqa2'zqb'zqc zqd2' npm run migrate", 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ['DB_PASSWORD=`zqa3`zqb`zqc zqd3` npm run migrate', 'Bash: $ DB_PASSWORD=[redacted] npm run migrate'],
  ['PASSWORD=zqab"zqc zqd5"zqe npm run migrate', 'Bash: $ PASSWORD=[redacted] npm run migrate'],
  ["PASSWORD=zqabcd'zqTAIL1 npm run migrate", 'Bash: $ PASSWORD=[redacted] npm run migrate'],
  ['PASSWORD=zqabcdef"zqTAIL2" npm run migrate', 'Bash: $ PASSWORD=[redacted] npm run migrate'],
  ['TOKEN=zqabcdef`zqTAIL3` npm run migrate', 'Bash: $ TOKEN=[redacted] npm run migrate'],
  ["PASSWORD=it'szqTAIL4secret npm run migrate", 'Bash: $ PASSWORD=[redacted] npm run migrate'],
  ['curl -d password=zqh12345,token="zqTOKENVALUE" next', 'Bash: $ curl -d password=[redacted] next'],
  ['curl -H "X-Api-Key: zqhdr12345" -H "X-Other: keepme09"', 'Bash: $ curl -H &#34;X-Api-Key: [redacted]&#34; -H &#34;X-Other: keepme09&#34;'],
  ['curl -d \'{"password":"zqesc\\"zqx","id":"keepme06"}\'', 'Bash: $ curl -d &#39;{&#34;password&#34;:&#34;[redacted]&#34;,&#34;id&#34;:&#34;keepme06&#34;}&#39;'],
  ["grep -n \"paykey: '[redacted]'\" src/redact.ts", 'Bash: $ grep -n &#34;paykey: &#39;[redacted]&#39;&#34; src/redact.ts'],
  // A quoted label doesn't mean JSON: `=`, backticks and emphasis after it, and underscores counted inside the value.
  ['echo \'{"password":"a_b_c_d_e_","id":"keepme20"}\'', 'Bash: $ echo &#39;{&#34;password&#34;:&#34;[redacted]&#34;,&#34;id&#34;:&#34;keepme20&#34;}&#39;'],
  ['echo \'"password" = "hunter2TAILA" keepme21\'', 'Bash: $ echo &#39;&#34;password&#34; = &#34;[redacted]&#34; keepme21&#39;'],
  ['echo \'"password": `abcdef ghTAILC` keepme22\'', 'Bash: $ echo &#39;&#34;password&#34;: [redacted] keepme22&#39;'],
  ['echo \'"secret": **abcdef ghTAILD** keepme23\'', 'Bash: $ echo &#39;&#34;secret&#34;: [redacted] keepme23&#39;'],
  ['echo \'{"paykey":"zqpk123456","paykey_details":{"id":"keepme24"}}\'', 'Bash: $ echo &#39;{&#34;paykey&#34;:&#34;[redacted]&#34;,&#34;paykey_details&#34;:{&#34;id&#34;:&#34;keepme24&#34;}}&#39;'],
  // An account or routing label holding a secret keyword is a secret label; one without keeps the digits rule.
  ['ACCOUNT_TOKEN=zqacct12345 npm run migrate', 'Bash: $ ACCOUNT_TOKEN=[redacted] npm run migrate'],
  ['echo \'{"account_password":"zqacct67890","id":"keepme28"}\'', 'Bash: $ echo &#39;{&#34;account_password&#34;:&#34;[redacted]&#34;,&#34;id&#34;:&#34;keepme28&#34;}&#39;'],
  ['SERVICE_ACCOUNT_TOKEN=zqsvc12345 npm run migrate', 'Bash: $ SERVICE_ACCOUNT_TOKEN=[redacted] npm run migrate'],
  ['routing_signature=zqrout12345 npm run migrate', 'Bash: $ routing_signature=[redacted] npm run migrate'],
  ['echo account_number=000123456789 account_name=keepme29', 'Bash: $ echo account_number=[redacted] account_name=keepme29'],
];

// Every label style crossed with both separators and every value form: each line must lose its value and keep the
// word after it. Values hold punctuation, spaces inside delimiters, escaped quotes and concatenated parts. The labels
// include account and routing names that hold a secret keyword.
const LABELS = ['password', '"password"', '`password`', '**password**', '__Secret__', '\\"token\\"', 'ACCOUNT_TOKEN', '"routing_signature"'];
const VALUES = ['"zqA_b_c_d_"', '"zqB \\"esc\\" tail"', '`zqC ghTAIL`', '**zqD ghTAIL**', '_zqE ghTAIL_', '"zqF".zqG\'zqH zqI\'', 'zqJ*,;}\\zqK', "'zqL it\\'s'"];
const CROSS = LABELS.flatMap((label) => [':', ' ='].flatMap((sep) => VALUES.map((value) => `${label}${sep} ${value}`)));

// A Markdown fence after a secret label and a line break is the reply's code, not the label's value: it renders as
// highlighted code with the table after it, a labelled secret inside it is still redacted, and plain code in it stays.
// A fenced or delimited value on the label's own line, and a value on the next line that isn't a fence, are values.
const FENCES = [
  'Verify the webhook signature:\n\n```typescript\nconst signingSecret = "zqINFENCE1";\n```',
  'Set your API key:\n\n```shell\nexport STRADDLE_API_KEY=zqINFENCE2\n```',
  'Rotate the token:\n```\nkeepme32 stays in the fence as code\n```',
  'api_key: ```zqINLINE4 two words``` keepme30',
  'password:\n  "zqNEXT5 value" keepme31',
  '\n| Check | Result |\n| --- | --- |\n| sig | ok |',
].join('\n');

// The line after a label crossed with plain and quoted labels, LF and CRLF, and what that line holds: a backtick
// value closed on the line is a value (its `zq` goes, the word after it stays); a real fence opener (backticks and an
// info string, or bare backticks) is code, and its code stays.
const FENCE_CROSS = ['api_key', '"api_key"', 'PASSWORD'].flatMap((label, l) => ['\n', '\r\n'].flatMap((nl, n) => [
  `${label}:${nl}\`\`\`zqFIN${l}${n} two\`\`\` keepFIN${l}${n}`,
  `${label}:${nl}\`\`\`shell${nl}keepFENCE${l}${n} code${nl}\`\`\``,
  `${label}:${nl}\`\`\`${nl}keepBARE${l}${n} code${nl}\`\`\``,
])).join('\n');

// Delimited values below, at and above 512 characters (where the previous rule stopped reading) and past the
// 2000-character clip, closed and unclosed. A closed value keeps the text after it; an unclosed one is redacted to
// the end of its line. Each value ends in `zqEND`, so a surviving tail shows.
const zqValue = (length: number) => `${'zq '.repeat(length).slice(0, length - 5)}zqEND`;
const LONG: [string, string][] = [511, 512, 513, 2100].flatMap((n): [string, string][] => [
  [`L${n}q password: "${zqValue(n)}" kept`, `L${n}q password: [redacted] kept`],
  [`L${n}b secret: \`${zqValue(n)}\` kept`, `L${n}b secret: [redacted] kept`],
  [`L${n}e token: **${zqValue(n)}** kept`, `L${n}e token: [redacted] kept`],
  [`L${n}u password: "${zqValue(n)}`, `L${n}u password: [redacted]`],
  [`L${n}s token: **${zqValue(n)}`, `L${n}s token: [redacted]`],
]);

test('planted secrets never reach the page, in commands, results, diffs, written files, questions, MCP calls, long fields and Markdown replies', async () => {
  const s = PLANTED;
  const repo = recorded([
    assistant('2026-10-03T10:00:03.000Z', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `STRADDLE_API_KEY=${s.envKey} curl -H "Authorization: Bearer ${s.bearer}" -d '{"account_number": "${s.account}"}'` } }),
    assistant('2026-10-03T10:00:03.050Z', { type: 'tool_use', name: 'Bash', input: { command: `DB_PASSWORD=${s.starPlain} npm run migrate` } }),
    result('t1', `{"paykey": "${s.paykey}", "token": "${s.jwt}"}\nStraddle-Signature: ${s.signature}`),
    assistant('2026-10-03T10:00:03.100Z', { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/lib/straddle.ts', old_string: "const key = ''", new_string: `const key = "${s.key}"` } }),
    assistant('2026-10-03T10:00:03.200Z', { type: 'tool_use', id: 't4', name: 'AskUserQuestion', input: { questions: [{ question: `Approve the charge with paykey ${s.jwt}?` }] } }),
    result('t4', `User has answered your questions: "Approve?"="Yes, use ${s.key}". You can now continue.`),
    assistant('2026-10-03T10:00:03.300Z', { type: 'tool_use', id: 't5', name: 'mcp__plugin_straddle_straddle-api__execute-request', input: { method: 'POST', path: '/v1/charges' } }),
    result('t5', `{"api_key":"${s.envKey}","password":"${s.starJson}","token":"${s.starSuffix}","id":"01a0f80f-e858-4c1e-9d3b-2f5a6b7c8d9e"}`),
    // A JSON value holding an escaped quote, a 2100-character JSON value in a result the page clips at 2000, and JSON
    // inside a shell string, whose value holds an escaped quote of its own.
    assistant('2026-10-03T10:00:03.310Z', { type: 'tool_use', id: 't7', name: 'Grep', input: { pattern: 'charges' } }),
    result('t7', `{"password":"zqesc1\\"zqesc2","id":"keepme01"}\n{"password":"${zqValue(2100)}","id":"keepme02"}`),
    assistant('2026-10-03T10:00:03.320Z', { type: 'tool_use', name: 'Bash', input: { command: String.raw`curl -d "{\"password\":\"zqopen\\\"zqmore\",\"id\":\"keepme03\"}"` } }),
    ...WORDS.map(([command], i) => assistant(`2026-10-03T10:00:03.33${i}Z`, { type: 'tool_use', name: 'Bash', input: { command } })),
    // A secret-named value after a long run of backslashes, and a run with no value after it (no secret, so it stays):
    // each is read once, not once per backslash, which took seconds at this length.
    assistant('2026-10-03T10:00:03.340Z', { type: 'tool_use', id: 't8', name: 'Bash', input: { command: 'cat creds' } }),
    result('t8', `password=${'\\'.repeat(100_000)}zqEND keep100\npassword=${'\\'.repeat(100_000)} keep101`),
    // A long run of name characters with no label, which a lookbehind rescanned at every underscore.
    assistant('2026-10-03T10:00:03.350Z', { type: 'tool_use', id: 't9', name: 'Grep', input: { pattern: 'benign' } }),
    result('t9', 'benign_'.repeat(40_000)),
    // A value on the line after its separator: pretty-printed JSON, a YAML-style key, and the same JSON with CRLF.
    assistant('2026-10-03T10:00:03.360Z', { type: 'tool_use', id: 't10', name: 'Grep', input: { pattern: 'credentials' } }),
    result('t10', '{\n  "password":\n    "zqMULTILINE1",\n  "id": "keepme25"\n}\napi_key:\n    zqNEXTLINE2 keepme26\n{\r\n  "token":\r\n    "zqCRLFVALUE3",\r\n  "id": "keepme27"\r\n}'),
    assistant('2026-10-03T10:00:04.500Z', { type: 'text', text: CROSS.map((line, i) => `X${i} ${line} keepX${i}`).join('\n') }),
    assistant('2026-10-03T10:00:04.600Z', { type: 'text', text: FENCES }),
    assistant('2026-10-03T10:00:04.700Z', { type: 'tool_use', name: 'Write', input: { file_path: 'docs/setup.md', content: FENCES } }),
    assistant('2026-10-03T10:00:04.800Z', { type: 'tool_use', name: 'Write', input: { file_path: 'docs/fences.md', content: FENCE_CROSS } }),
    assistant('2026-10-03T10:00:03.400Z', { type: 'tool_use', id: 't6', name: 'Bash', input: { command: `ls ${s.home}/straddle-demo/bin` } }),
    result('t6', `${s.home}/straddle-demo/bin/straddle\n/home/dana/.npm/_logs/debug-0.log`),
    // The value straddles the 2000-character clip: clipping first would leave five characters too few to redact.
    assistant('2026-10-03T10:00:03.600Z', { type: 'tool_use', name: 'Grep', input: { pattern: `${'a'.repeat(1978)}api_key=${s.envKey}` } }),
    assistant('2026-10-03T10:00:04.000Z', { type: 'tool_use', name: 'Write', input: { file_path: `${s.home}/shop/.env.local`, content: `STRADDLE_WEBHOOK_SECRET=${s.webhook}\nHASH=${s.hex}` } }),
    assistant('2026-10-03T10:00:05.000Z', { type: 'text', text: `Use ${s.key} and ${s.publishable}; routing_number: 021000021. Use account ${s.account}.\napi_key: \`${s.envKey}\`\n**API key:** \`${s.envKey}\`\nsecret: \`${s.starTick}\`\n**Secret:** ${s.starBold}\n*API key:* ${s.starItalic}\n${[...DELIMITED, ...LONG].map(([line]) => line).join('\n')}\n\n| Account | Opened |\n| --- | --- |\n| ${s.account} | 2026-10-03T10:00:05Z |` }),
  ].join('\n'));
  const started = performance.now();
  const html = await page(repo);
  assert.ok(performance.now() - started < 5000, `wizard log took ${Math.round(performance.now() - started)} ms`);
  for (const [name, secret] of Object.entries(PLANTED)) assert.ok(!html.includes(secret), `planted ${name} is on the page`);
  // No part of an asterisk-bearing value survives either: Markdown delimiting never truncates a secret.
  for (const piece of ['021000021', 'FAKEK', '/home/dana', '*er2secret', '*pass*value', '*tail99', '*key*value', '*secret*value', 'zq']) assert.ok(!html.includes(piece), `${piece} is on the page`);
  // The surrounding text stays readable; only the values go. `Authorization: Bearer` loses both words, as in Northwind.
  const rows = sections(html)[1]![1] as string[];
  for (const expected of [
    'Bash: $ STRADDLE_API_KEY=[redacted] curl -H &#34;Authorization: [redacted] [redacted]&#34; -d &#39;{&#34;account_number&#34;: &#34;[redacted]&#34;}&#39;',
    'Bash: $ DB_PASSWORD=[redacted] npm run migrate',
    'Edit: /repo/lib/straddle.ts',
    'straddle-api execute-request: method: POST\npath: /v1/chargesresult',
    'Bash: $ ls ~/straddle-demo/bin',
    `Grep: pattern: ${'a'.repeat(1978)}api_key=[reda\n… 5 more characters`,
    'Write: ~/shop/.env.local',
  ]) assert.ok(rows.includes(expected), `${expected.slice(0, 60)} missing from\n${rows.join('\n---\n')}`);
  const text = shown(html);
  for (const expected of [
    '{&quot;paykey&quot;: &quot;[redacted]&quot;, &quot;token&quot;: &quot;[redacted]&quot;}Straddle-Signature: [redacted]',
    'const key = &quot;[redacted]&quot;',
    'Approve the charge with paykey [redacted]?',
    '=&quot;Yes, use [redacted]&quot;',
    '01a0f80f-e858-4c1e-9d3b-2f5a6b7c8d9e',
    '~/straddle-demo/bin/straddle~/.npm/_logs/debug-0.log',
    'STRADDLE_WEBHOOK_SECRET=[redacted][redacted]',
    'api_key: [redacted]',
    'API key: [redacted]',
    '&quot;password&quot;:&quot;[redacted]&quot;,&quot;token&quot;:&quot;[redacted]&quot;',
    'secret: [redacted]',
    'Secret: [redacted]',
    '*API key:* [redacted]',
  ]) assert.ok(text.includes(expected) || text.includes(expected.replaceAll('&quot;', '"')), `${expected} missing`);
  for (const [, expected] of [...DELIMITED, ...LONG]) assert.ok(text.includes(`${expected}\n`) || text.includes(`${expected}┌`), `${expected} missing`);
  for (const kept of ['&quot;id&quot;:&quot;keepme01&quot;', '&quot;id&quot;:&quot;keepme02&quot;', '&quot;id&quot;: &quot;keepme25&quot;', 'keepme26', '&quot;id&quot;: &quot;keepme27&quot;', 'keepme30', 'keepme31', 'keepme32 stays in the fence as code']) assert.ok(text.includes(kept) || text.includes(kept.replaceAll('&quot;', '"')), `${kept} missing`);
  for (const l of [0, 1, 2]) for (const n of [0, 1]) for (const kept of [`[redacted] keepFIN${l}${n}`, `keepFENCE${l}${n} code`, `keepBARE${l}${n} code`]) assert.ok(text.includes(kept), `${kept} missing`);
  assert.ok(rows.some((r) => r.startsWith('Bash: $ curl -d ') && r.includes('keepme03') && r.includes('[redacted]')), rows.join('\n---\n'));
  for (const [, expected] of WORDS) assert.ok(rows.includes(expected), `${expected} missing from\n${rows.join('\n---\n')}`);
  for (const i of CROSS.keys()) {
    const line = text.slice(text.indexOf(`X${i} `), text.indexOf(`keepX${i}`) + `keepX${i}`.length);
    assert.ok(line.endsWith(`keepX${i}`) && line.includes('[redacted]'), `${CROSS[i]} shows as ${JSON.stringify(line)}`);
  }
  assert.ok(text.includes('$ cat credspassword=[redacted] keep100'), 'the value after the backslashes is redacted and the next word kept');
  // In the reply, each fence renders as code in its language and the table after them as a screen-reader table; the
  // lines before the fences keep their wording. In the written file, the fences stay as written.
  for (const language of ['typescript', 'shell']) assert.ok(html.includes(`<pre data-language="${language}"`), `${language} fence missing`);
  assert.ok(html.includes('<th scope="col">Check</th><th scope="col">Result</th>'), 'the table after the fences is missing');
  for (const prose of ['Verify the webhook signature:', 'Set your API key:', 'Rotate the token:']) assert.ok(new RegExp(`${prose.replace(/[?:]/g, '\\$&')}\\s*</`).test(html), `${prose} is followed by a redaction`);
  for (const kept of ['```typescript', '```shell', 'export STRADDLE_API_KEY=[redacted]', 'api_key: [redacted] keepme30', 'password:  [redacted] keepme31']) assert.ok(text.includes(kept), `${kept} missing from the written file`);
  // A prose account number before a full stop, and a bare one in a table cell, go; the timestamp beside it stays.
  assert.match(html, /Use \[redacted\] and \[redacted\]; routing_number: \[redacted\]\. Use account \[redacted\]\./);
  assert.match(html, /│ \[redacted\] *│ 2026-10-03T10:00:05Z │/);
});

test('a resumed session names its transcript twice: every row shows once, a call keeps its result across the resume, and a report renders as on the terminal with a table screen readers can read', async () => {
  const repo = recorded([
    assistant('2026-10-03T10:00:07.000Z', { type: 'text', text: '## Setup report\n- **Status:** complete\n\n| `Check` | Result |\n| --- | --- |\n| CLI | **ok** |' }),
    assistant('2026-10-03T10:00:07.500Z', { type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'straddle --version' } }),
    // Written after the resume below (second session-start at :08).
    JSON.stringify({ type: 'user', timestamp: '2026-10-03T10:00:09.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'straddle 1.0.3' }] } }),
  ].join('\n'));
  const events = readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8');
  const first = JSON.parse(events.split('\n')[0]!);
  writeFiles(repo, { '.straddle-wizard/events.jsonl': `${events}${JSON.stringify({ ...first, at: '2026-10-03T10:00:08.000Z' })}\n` });
  const html = await page(repo);
  assert.equal(html.split('Setup report').length, 2, html);
  assert.deepEqual(sections(html).flatMap(([, rows]) => rows as string[]).filter((r) => r.startsWith('Bash: ')), ['Bash: $ straddle --version']);
  assert.ok(shown(html).includes('$ straddle --versionstraddle 1.0.3'), 'the result written after the resume is paired');
  // The prose as on the terminal; the table drawn as on the terminal for the eye, with no color code left in the
  // header that holds inline code, and as a real table for a screen reader.
  assert.match(html, /<span class="who">agent<\/span><div class="body"><pre class="md" tabindex="0">/);
  assert.ok(!html.includes('\x1b') && !html.includes('[1m') && !html.includes('[0m'), 'a terminal color code is on the page');
  const art = /<pre aria-hidden="true">([\s\S]*?)<\/pre>/.exec(html)![1]!.replace(/<[^>]+>/g, '');
  assert.equal(art, '┌───────┬────────┐\n│ Check │ Result │\n├───────┼────────┤\n│ CLI   │ ok     │\n└───────┴────────┘');
  assert.ok(html.includes('<div class="visually-hidden"><table><thead><tr><th scope="col">Check</th><th scope="col">Result</th></tr></thead><tbody><tr><td>CLI</td><td>ok</td></tr></tbody></table></div>'), html);
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
    { timestamp: '2026-10-03T10:00:03.500Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '3 passing', metadata: { exit_code: 0 } }) } },
    { timestamp: '2026-10-03T10:00:03.600Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: { command: 'git status' }, call_id: 'c2' } },
    { timestamp: '2026-10-03T10:00:03.800Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'clean' } },
    { timestamp: '2026-10-03T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] } },
  ];
  writeFiles(repo, { '.straddle-wizard/events.jsonl': events.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  writeFiles(codexHome, { [`sessions/2026/10/03/rollout-2026-10-03T10-00-00-${id}.jsonl`]: rollout.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  const r = await runWizard(['log'], { cwd: repo, env: { CODEX_HOME: codexHome } });
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(join(repo, '.straddle-wizard', 'session-log.html'), 'utf8');
  assert.deepEqual(sections(html), [
    ['Session start', [`wizard: Session started (${id})`]],
    ['straddle-test · 01-begin', ['shell: $ npm test', 'exec: command: git statusresult', 'agent: Tests pass.']],
  ]);
  assert.ok(shown(html).includes('$ npm test3 passing'), 'the call output is paired with its call');
  assert.ok(shown(html).includes('clean'), 'the custom tool output is paired with its call');
  assert.ok(!html.includes('$ git status'), 'custom tool is rendered generically rather than as a shell command');
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

test('a transcript path that is a directory or a FIFO: the page still shows the recorded events, says why, and never hangs', async () => {
  const repo = recorded(null);
  const fifo = join(tempDir('log-fifo'), 'transcript.jsonl');
  execFileSync('mkfifo', [fifo]);
  const dir = tempDir('log-dir-transcript');
  const events = readFileSync(join(repo, '.straddle-wizard', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).slice(1);
  writeFiles(repo, { '.straddle-wizard/events.jsonl': [{ at: '2026-10-03T10:00:00.000Z', kind: 'session-start', session: 'abc12345-0000', transcript: dir }, { at: '2026-10-03T10:00:01.000Z', kind: 'session-start', session: 'abc12345-0001', transcript: fifo }].map((e) => JSON.stringify(e)).concat(events).join('\n') + '\n' });
  const html = await page(repo);
  assert.ok(html.includes(`The client transcript isn't a regular file I can read: ${dir}. Showing the Wizard's events only.`), html);
  assert.ok(html.includes(`The client transcript isn't a regular file I can read: ${fifo}. Showing the Wizard's events only.`), html);
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
