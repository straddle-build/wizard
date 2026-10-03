import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { markdown, splash, table } from '../src/tui.ts';
import { Prompter } from '../src/ui.ts';

const plain = { width: 60, color: false };

test('a table too wide for 60 columns wraps inside its cells, with a rule between wrapped rows', () => {
  assert.equal(table(plain, ['Check', 'Result', 'Evidence'], [['API key', 'present (env var), not verified', '`straddle auth status`'], ['Docs MCP', 'search **passed**', '']]), [
    '┌──────────┬───────────────────────┬───────────────────────┐',
    '│ Check    │ Result                │ Evidence              │',
    '├──────────┼───────────────────────┼───────────────────────┤',
    '│ API key  │ present (env var),    │ `straddle auth        │',
    '│          │ not verified          │ status`               │',
    '├──────────┼───────────────────────┼───────────────────────┤',
    '│ Docs MCP │ search passed         │                       │',
    '└──────────┴───────────────────────┴───────────────────────┘',
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
    '┌──────────────────┬───────────────────┬───────────────────┐',
    '│ Check            │ Result            │ Evidence          │',
    '├──────────────────┼───────────────────┼───────────────────┤',
    '│ Agent client     │ Claude Code       │ session           │',
    '├──────────────────┼───────────────────┼───────────────────┤',
    '│ Straddle CLI     │ 1.0.3; idempotent │ `straddle         │',
    '│                  │ creates yes       │ --version`        │',
    '├──────────────────┼───────────────────┼───────────────────┤',
    '│ API key          │ present (env      │ `straddle auth    │',
    '│                  │ var), not         │ status`           │',
    '│                  │ verified          │                   │',
    '├──────────────────┼───────────────────┼───────────────────┤',
    '│ API reachability │ not run (no       │ `straddle doctor` │',
    '│ (CLI)            │ network in this   │                   │',
    '│                  │ session)          │                   │',
    '└──────────────────┴───────────────────┴───────────────────┘',
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

// A terminal with NO_COLOR gets the boxes and the art without one escape code; a pipe gets no splash at all.
async function splashIn(screen: { isTTY?: boolean; columns?: number }): Promise<string> {
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    let text = '';
    const output = Object.assign(new PassThrough(), screen, { write: (chunk: string) => { text += chunk; return true; } });
    await new Prompter(new PassThrough(), output).splash();
    return text;
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
}

test('the splash is plain art at 80 columns with NO_COLOR, one line under 80, and absent in a pipe', async () => {
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

test('a markdown table with only delimiter rows does not crash and emits no table', () => {
  assert.equal(markdown(plain, '| --- | --- |\n|---|'), '');
});

test('the splash in color styles the wordmark as heading and subtitle as dim without nesting', () => {
  const lines = splash({ width: 80, color: true });
  assert.match(lines[2]!, /\x1b\[1;36m/);
  assert.ok(lines[10]!.includes('\x1b[2mStraddle, set up by your coding agent\x1b[0m'));
  assert.ok(!lines[10]!.includes('\x1b[1;36m\x1b[2m'));
});
