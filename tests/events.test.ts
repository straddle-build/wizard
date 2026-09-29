import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkers, stepEntries, verifyChecklist, type ObservedEvent } from '../src/events.ts';

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
