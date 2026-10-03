import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { card, cells, markdown, splash, table } from '../src/tui.ts';
import { Prompter } from '../src/ui.ts';

const plain = { width: 60, color: false };

test('a table too wide for 60 columns wraps inside its cells, between words, with a rule between wrapped rows', () => {
  assert.equal(table(plain, ['Check', 'Result', 'Evidence'], [['API key', 'present (env var), not verified', '`straddle auth status`'], ['Docs MCP', 'search **passed**', '']]), [
    '┌──────────┬──────────────────────┬────────────────────────┐',
    '│ Check    │ Result               │ Evidence               │',
    '├──────────┼──────────────────────┼────────────────────────┤',
    '│ API key  │ present (env var),   │ `straddle auth status` │',
    '│          │ not verified         │                        │',
    '├──────────┼──────────────────────┼────────────────────────┤',
    '│ Docs MCP │ search passed        │                        │',
    '└──────────┴──────────────────────┴────────────────────────┘',
  ].join('\n'));
});

test('color is applied after the width is measured: bold header, accent code, same box', () => {
  assert.equal(table({ width: 60, color: true }, ['Step', 'Status'], [['Setup', '`ready`']]), [
    '┌───────┬────────┐',
    '│ \x1b[1mStep \x1b[0m │ \x1b[1mStatus\x1b[0m │',
    '├───────┼────────┤',
    '│ Setup │ \x1b[36mready\x1b[0m  │',
    '└───────┴────────┘',
  ].join('\n'));
});

test('a card wraps labels and values in their columns and paragraphs across the body', () => {
  assert.equal(card(plain, 'Straddle Wizard 0.1.0', [['Directory', '/Users/dev/northwind'], ['Language', 'TypeScript (detected: package.json, tsconfig.json)'], '', 'I never open .env files, keys or credential files, and I send nothing to Straddle.']), [
    '┌─ Straddle Wizard 0.1.0 ──────────────────────────────────┐',
    '│ Directory  /Users/dev/northwind                          │',
    '│ Language   TypeScript (detected: package.json,           │',
    '│            tsconfig.json)                                │',
    '│                                                          │',
    '│ I never open .env files, keys or credential files, and I │',
    '│ send nothing to Straddle.                                │',
    '└──────────────────────────────────────────────────────────┘',
  ].join('\n'));
});

test('a Setup report written from the skill\'s template renders as headings, a boxed table and lists', () => {
  assert.equal(markdown(plain, readFileSync(new URL('fixtures/straddle-setup.md', import.meta.url), 'utf8')), [
    'Straddle Setup report',
    '',
    'Status: complete',
    'Environment: https://sandbox.straddle.com, explicitly',
    'selected (env var)',
    'Integration type: account',
    'API key present: yes (env var), not verified',
    'SDK: @straddlecom/straddle 0.4.0',
    'Acting account: not required',
    'Setup result: ready_with_warnings',
    '',
    '┌────────────────────┬──────────────────┬──────────────────┐',
    '│ Check              │ Result           │ Evidence         │',
    '├────────────────────┼──────────────────┼──────────────────┤',
    '│ Agent client       │ Claude Code      │ session          │',
    '├────────────────────┼──────────────────┼──────────────────┤',
    '│ Straddle CLI       │ 1.0.3;           │ `straddle        │',
    '│                    │ idempotent       │ --version`       │',
    '│                    │ creates yes      │                  │',
    '├────────────────────┼──────────────────┼──────────────────┤',
    '│ API key            │ present (env     │ `straddle auth   │',
    '│                    │ var), not        │ status`          │',
    '│                    │ verified         │                  │',
    '├────────────────────┼──────────────────┼──────────────────┤',
    '│ API reachability   │ not run (no      │ `straddle        │',
    '│ (CLI)              │ network in this  │ doctor`          │',
    '│                    │ session)         │                  │',
    '└────────────────────┴──────────────────┴──────────────────┘',
    '',
    'Warnings',
    '',
    '• API reachability wasn\'t checked, so run `straddle doctor`',
    '  before Integrate.',
    '',
    'Next actions',
    '',
    '1. Plan the integration with straddle-plan.',
    '',
    'Verify before merging',
    '',
    '☐ No API key, token, or `.env` content appears in this',
    '  report or the conversation.',
    '☑ The environment is Sandbox.',
  ].join('\n'));
});

// The integration report's "Sandbox writes run" table (skills straddle-integrate/steps/07-handoff.md) has ten columns:
// even at four cells each it needs 71, so at 60 each row is a card of column: value lines.
test('a table that cannot fit even at its narrowest stacks each row as a card', () => {
  const sandboxWrites = '| # | Operation | Tool | Acting account | External ID | Idempotency key | Result | ID | Created or reused | Approved at |\n|---|---|---|---|---|---|---|---|---|---|\n'
    + '| 1 | Create customer | SDK `customers.create` | acct_7f3a | cust-northwind-001 | northwind-r1-customer-001 | 201 | 0f9b1c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e | created | 2026-10-03T04:50Z |';
  assert.equal(markdown(plain, sandboxWrites), [
    '┌──────────────────────────────────────────────────────────┐',
    '│ #                  1                                     │',
    '│ Operation          Create customer                       │',
    '│ Tool               SDK `customers.create`                │',
    '│ Acting account     acct_7f3a                             │',
    '│ External ID        cust-northwind-001                    │',
    '│ Idempotency key    northwind-r1-customer-001             │',
    '│ Result             201                                   │',
    '│ ID                 0f9b1c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e  │',
    '│ Created or reused  created                               │',
    '│ Approved at        2026-10-03T04:50Z                     │',
    '└──────────────────────────────────────────────────────────┘',
  ].join('\n'));
});

test('fenced code is hard-wrapped with its spacing kept, never cut', () => {
  assert.equal(markdown(plain, '```\nstraddle charges create --amount 1000 --currency USD --paykey "$PAYKEY" --idempotency-key northwind-r1-charge-001\n```'), [
    '  straddle charges create --amount 1000 --currency USD --pay',
    '  key "$PAYKEY" --idempotency-key northwind-r1-charge-001',
  ].join('\n'));
});

test('a report file\'s escape sequences and control characters are dropped, and CRLF lines parse', () => {
  assert.equal(markdown(plain, '# Report\r\n\r\nStatus: \x1b]0;pwned\x07done\x1b[2J\r\n- [ ] one\r\n'), 'Report\n\nStatus: done\n☐ one');
});

// Wide (CJK, emoji) text in every column, at widths down to where even four cells per column can't fit.
test('no line of a table or card is wider than the width, with wide text, at 20, 30 and 60 columns', () => {
  const headers = ['Step', '状態', 'Evidence', 'Notes'];
  const rows = [['Setup ✅', '完了しました', 'straddle-setup.md:Status', '日本語のメモ and a long-running sentence'], ['Test', '保留', '`straddle doctor`', '✨ none']];
  for (const width of [20, 30, 60]) {
    for (const color of [false, true]) {
      const look = { width, color };
      const drawn = [table(look, headers, rows), card(look, 'Straddle Wizard 報告', [['状態', '完了しました、次は計画です'], ['Directory', '/Users/dev/northwind-kit/very/long/path']])];
      for (const line of drawn.join('\n').split('\n')) assert.ok(cells(line) <= width, `${width}${color ? ' color' : ''}: ${cells(line)} cells: ${line}`);
    }
  }
});

// The Prompter on a fake terminal with the given environment (unset by default: CI and TERM as on a developer's
// machine); returns what it wrote.
async function inTerminal(screen: { isTTY?: boolean; columns?: number }, env: Record<string, string>, run: (io: Prompter) => Promise<unknown> | unknown): Promise<string> {
  const keys = ['NO_COLOR', 'CI', 'TERM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    let text = '';
    const output = Object.assign(new PassThrough(), screen, { write: (chunk: string) => { text += chunk; return true; } });
    await run(new Prompter(new PassThrough(), output));
    return text;
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('the splash is plain art at 80 columns with NO_COLOR, one line under 80, and absent in a pipe', async () => {
  const splashIn = (screen: { isTTY?: boolean; columns?: number }) => inTerminal(screen, { NO_COLOR: '1' }, (io) => io.splash());
  assert.equal(await splashIn({ isTTY: true, columns: 80 }), [
    '          *',
    '    ✦    /\\    \\ | /',
    '        /  \\  -- ✦ --  ▄▀▀▀  ▀█▀  █▀▀▄  ▄▀▀▄  █▀▀▄  █▀▀▄  █     █▀▀▀',
    '       / ✦  \\  / | \\   ▀▀▀▄   █   █▄▄▀  █▄▄█  █  █  █  █  █     █▀▀',
    '      /  .   \\   |     ▄▄▄▀   █   █ ▀▄  █  █  █▄▄▀  █▄▄▀  █▄▄▄  █▄▄▄',
    '     /________\\  |',
    '      ( o  o )   |     █   █  ▀█▀  ▀▀▀█  ▄▀▀▄  █▀▀▄  █▀▀▄',
    '      (  __  )   |     █ █ █   █    ▄▀   █▄▄█  █▄▄▀  █  █',
    '       \\~~~~/ ___/     ▀▄▀▄▀  ▄█▄  █▄▄▄  █  █  █ ▀▄  █▄▄▀',
    '      /\\~~~~/\\   |',
    '     /  \\~~/  \\  |     Straddle, set up by your coding agent',
    '    /____\\/____\\ |',
    '',
    '',
  ].join('\n'));
  assert.equal(await splashIn({ isTTY: true, columns: 60 }), '✦ Straddle Wizard\n\n');
  assert.equal(await splashIn({}), '');
});

test('in CI or on a dumb terminal a TTY gets no splash and no color', async () => {
  for (const env of [{ CI: 'true' }, { TERM: 'dumb' }]) {
    assert.equal(await inTerminal({ isTTY: true, columns: 100 }, env, async (io) => {
      await io.splash();
      io.say(io.bold('Steps'));
    }), 'Steps\n', JSON.stringify(env));
  }
});

test('a terminal that reports 0 columns is drawn at 80', async () => {
  let width = 0;
  await inTerminal({ isTTY: true, columns: 0 }, {}, (io) => { width = io.look!.width; });
  assert.equal(width, 80);
});

test('a markdown table with only delimiter rows does not crash and emits no table', () => {
  assert.equal(markdown(plain, '| --- | --- |\n|---|'), '');
});

test('the splash in color styles the wordmark as heading and subtitle as dim without nesting', () => {
  const lines = splash({ width: 80, color: true });
  assert.match(lines[2]!, /\x1b\[1;36m/);
  assert.ok(lines[10]!.includes('\x1b[2mStraddle, set up by your coding agent\x1b[0m'));
  assert.ok(!lines[10]!.includes('\x1b[1;36m\x1b[2m'));
});
