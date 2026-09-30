import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { followCodex } from '../src/codex.ts';
import { appendEvents, newRollout, parseMarkers, readObservedEvents, rolloutEvents, stepEntries, transcriptMarkers, verifyChecklist, type ObservedEvent } from '../src/events.ts';
import { tempDir } from './helpers.ts';

test('parses model-reported markers, including ones inside code fences, and ignores malformed ones', () => {
  const text = [
    'STRADDLE_PROGRESS {"skill":"straddle-plan","step":"01-decisions"}',
    '```text',
    'STRADDLE_HANDOFF {"skill":"straddle-plan","status":"draft","report":"plan at straddle-integration-plan.md"}',
    '```',
    'STRADDLE_ABORT {not json}',
    'mention of STRADDLE_HANDOFF {"skill":"x"} mid-line is not a marker',
  ].join('\n');

  assert.deepEqual(parseMarkers(text), [
    { kind: 'progress', skill: 'straddle-plan', step: '01-decisions' },
    { kind: 'handoff', skill: 'straddle-plan', status: 'draft', report: 'plan at straddle-integration-plan.md' },
  ]);
});

test('observed step entry comes only from client events, never from markers', () => {
  const events: ObservedEvent[] = [
    { at: '2026-09-28T00:00:00Z', kind: 'session-start' },
    { at: '2026-09-28T00:00:01Z', kind: 'step-entered', skill: 'straddle-plan', step: '01-decisions' },
    { at: '2026-09-28T00:00:02Z', kind: 'step-entered', skill: 'straddle-plan', step: '01-decisions' },
    { at: '2026-09-28T00:00:03Z', kind: 'step-entered', skill: 'straddle-best-practices', step: '01-other' },
    { at: '2026-09-28T00:00:04Z', kind: 'step-entered', skill: 'straddle-plan', step: '02-sources' },
  ];

  assert.deepEqual(stepEntries(events, 'straddle-plan'), ['01-decisions', '02-sources']);
});

test('extracts the last verify-before-merging checklist the agent printed', () => {
  const text = [
    '## Verify before merging',
    '- [ ] old',
    'later turn',
    '## Verify before merging',
    '',
    '- [ ] Every SDK method in the plan exists in the installed SDK version.',
    '- [ ] No secret appears in the plan.',
    '',
    'STRADDLE_HANDOFF {"skill":"straddle-plan","status":"draft","report":"x"}',
  ].join('\n');

  assert.deepEqual(verifyChecklist(text), [
    '- [ ] Every SDK method in the plan exists in the installed SDK version.',
    '- [ ] No secret appears in the plan.',
  ]);
  assert.deepEqual(verifyChecklist('no checklist here'), []);
});

test('markers swept from a Claude Code transcript at every turn end are recorded once, and only from the agent\'s replies', () => {
  const dir = tempDir('transcript');
  const transcript = join(dir, 't.jsonl');
  const events = join(dir, 'events.jsonl');
  const assistant = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'STRADDLE_HANDOFF {"skill":"straddle-plan","status":"draft"}' } }),
    assistant('a1', 'Setup is done.\nSTRADDLE_HANDOFF {"skill":"straddle-setup","status":"ready"}'),
  ];
  writeFileSync(transcript, lines.join('\n') + '\n');
  appendEvents(events, transcriptMarkers(transcript, 't1'));
  writeFileSync(transcript, [...lines, assistant('a2', 'STRADDLE_PROGRESS {"skill":"straddle-plan","step":"01-decisions"}')].join('\n') + '\n');
  appendEvents(events, transcriptMarkers(transcript, 't2'));

  assert.deepEqual(readObservedEvents(events).events.map((e) => (e.kind === 'marker' ? [e.at, e.marker.skill, e.marker.kind] : e.kind)), [
    ['t1', 'straddle-setup', 'handoff'],
    ['t2', 'straddle-plan', 'progress'],
  ]);
});

test('a Codex rollout yields its session id, step files a tool call opened once its output is logged, and the agent\'s markers', () => {
  const state = newRollout();
  const at = '2026-09-30T20:00:00.000Z';
  const lines = [
    { timestamp: at, type: 'session_meta', payload: { id: '01a0edf0-145f-7253-a347-af992a03ab61', cwd: '/repo' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: "sed -n '1,200p' /p/skills/straddle-plan/steps/01-decisions.md" }) } },
    // A call with no logged output (refused or still running) is not an entry yet.
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify({ cmd: 'cat /p/skills/straddle-plan/steps/02-sources.md' }) } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'step text' } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'STRADDLE_HANDOFF {"skill":"straddle-plan","status":"draft"}' }] } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Plan drafted.\nSTRADDLE_HANDOFF {"skill":"straddle-plan","status":"draft"}' }] } },
  ];
  const events: ObservedEvent[] = lines.flatMap((line) => rolloutEvents(state, JSON.stringify(line)));

  assert.equal(state.session, '01a0edf0-145f-7253-a347-af992a03ab61');
  assert.deepEqual(stepEntries(events, 'straddle-plan'), ['01-decisions']);
  assert.deepEqual(events.flatMap((e) => (e.kind === 'marker' ? [[e.marker.kind, e.marker.status, e.key]] : [])), [['handoff', 'draft', 'codex:01a0edf0-145f-7253-a347-af992a03ab61:5:0']]);
  assert.match(state.text.join('\n'), /Plan drafted\./);
});

test('followCodex follows rollout log and survives transient filesystem errors or rotations without unhandled exceptions', () => {
  const dir = tempDir('codex');
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const repo = tempDir('repo');
  const events = join(dir, 'events.jsonl');
  const rollout = join(sessions, 'rollout-test.jsonl');
  const at = '2026-09-30T20:00:00.000Z';
  const line1 = JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 's1', cwd: repo } });
  writeFileSync(rollout, line1 + '\n');

  const follower = followCodex({ CODEX_HOME: dir }, repo, events, 0, null);
  const line2 = JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'STRADDLE_HANDOFF {"skill":"straddle-setup","status":"ready"}' }] } });
  appendFileSync(rollout, line2 + '\n');
  const state = follower.stop();
  assert.equal(state.session, 's1');
  assert.equal(readObservedEvents(events).events.length, 2);

  unlinkSync(rollout);
  const follower2 = followCodex({ CODEX_HOME: dir }, repo, events, 0, null);
  assert.doesNotThrow(() => follower2.stop());
});

test('persisted events of the wrong shape are skipped and counted at the read boundary, never handed to a consumer', () => {
  const file = join(tempDir('events'), 'events.jsonl');
  const valid = [
    { at: 't1', kind: 'session-start', session: 'c0ffee00-1111-2222-3333-444455556666' },
    { at: 't2', kind: 'step-entered', skill: 'straddle-setup', step: '01-begin' },
    { at: 't3', kind: 'marker', key: 'a1:0', marker: { kind: 'handoff', skill: 'straddle-setup', status: 'ready' } },
  ];
  const malformed = [
    '{"at":"t4","kind":"marker"}',
    '{"at":"t5","kind":"marker","key":"k","marker":{"kind":"handoff"}}',
    '{"at":"t6","kind":"marker","key":"k","marker":{"kind":"shout","skill":"straddle-setup"}}',
    '{"at":"t7","kind":"step-entered","skill":"straddle-setup"}',
    '{"kind":"turn-end"}',
    '{"at":"t8","kind":"edit","path":7}',
    '{"at":"t9","kind":"reboot"}',
    'not json',
  ];
  writeFileSync(file, [...valid.map((e) => JSON.stringify(e)), ...malformed].join('\n') + '\n');

  const read = readObservedEvents(file);
  assert.deepEqual(read.events, valid);
  assert.equal(read.skipped, malformed.length);
});

test('a new Codex session is found by when its session started, not by which rollout was written last', () => {
  const dir = tempDir('codex');
  const sessions = join(dir, 'sessions', '2026', '09', '30');
  mkdirSync(sessions, { recursive: true });
  const repo = tempDir('repo');
  const events = join(dir, 'events.jsonl');
  const since = Date.now() - 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const meta = (id: string, started: number) => JSON.stringify({ timestamp: iso(started), type: 'session_meta', payload: { id, cwd: repo, timestamp: iso(started) } }) + '\n';
  const fresh = join(sessions, 'rollout-new.jsonl');
  const other = join(sessions, 'rollout-other.jsonl');
  writeFileSync(fresh, meta('new-session-0001', since + 5_000));
  // Another Codex session in the same repo, started before this one and still writing: its file is the newest on disk.
  writeFileSync(other, meta('other-session-01', since - 30 * 60_000));
  utimesSync(fresh, (since + 5_000) / 1000, (since + 5_000) / 1000);
  utimesSync(other, (since + 50_000) / 1000, (since + 50_000) / 1000);

  const state = followCodex({ CODEX_HOME: dir }, repo, events, since, null).stop();
  assert.equal(state.session, 'new-session-0001');
});

