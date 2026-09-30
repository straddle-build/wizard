import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, nextRepo, tempDir, writeFiles } from './helpers.ts';

const HOOK = join(ROOT, 'src', 'hook.ts');

function runHook(repo: string, events: string, gate: string, payload: object) {
  const r = spawnSync(process.execPath, [HOOK, '--events', events, '--repo', repo, '--gate', gate], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { status: r.status, decision: r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined };
}

function recorded(events: string) {
  return readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('records step entry only after a completed read of a skill step file, without file contents or prompts', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');
  const read = (hook_event_name: string, file_path: string) => ({ hook_event_name, tool_name: 'Read', tool_input: { file_path } });

  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'SessionStart', session_id: 'c0ffee00-1111-2222-3333-444455556666', transcript_path: '/t/s.jsonl', source: 'startup' });
  // An attempted read the developer then denies never reaches PostToolUse, so it is not a step entry.
  runHook(repo, events, 'straddle-integration-plan.md', read('PreToolUse', '/b/skills/straddle-plan/steps/02-sources.md'));
  runHook(repo, events, 'straddle-integration-plan.md', read('PostToolUse', '/b/skills/straddle-plan/steps/03-write-plan.md'));
  runHook(repo, events, 'straddle-integration-plan.md', read('PostToolUse', join(repo, 'src/app/page.tsx')));
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'UserPromptSubmit', prompt: 'my key is sk_test_secret' });

  const lines = recorded(events).map(({ at, ...rest }) => rest);
  assert.deepEqual(lines, [
    { kind: 'session-start', session: 'c0ffee00-1111-2222-3333-444455556666', transcript: '/t/s.jsonl' },
    { kind: 'step-entered', skill: 'straddle-plan', step: '03-write-plan' },
  ]);
  assert.ok(!readFileSync(events, 'utf8').includes('sk_test_secret'));
});

test('denies code edits in the repository until the durable plan exists, and records only edits that completed', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');
  const write = (hook_event_name: string, path: string) => ({ hook_event_name, tool_name: 'Write', tool_input: { file_path: join(repo, path), content: 'x' } });

  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('PreToolUse', 'src/straddle.ts')).decision, 'deny');
  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('PreToolUse', 'straddle-integration-plan.md')).decision, undefined);
  // Setup writes its state file before any plan exists.
  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('PreToolUse', 'straddle-setup.md')).decision, undefined);
  runHook(repo, events, 'straddle-integration-plan.md', write('PostToolUse', 'straddle-integration-plan.md'));

  writeFiles(repo, { 'straddle-integration-plan.md': '# Straddle integration plan\n' });
  // Allowed by the gate but then denied by the developer in the client: no PostToolUse, so no edit is recorded.
  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('PreToolUse', 'src/straddle.ts')).decision, undefined);

  assert.deepEqual(recorded(events).map((e) => [e.kind, e.path]), [
    ['edit-denied', 'src/straddle.ts'],
    ['edit', 'straddle-integration-plan.md'],
  ]);
});

test('fails closed on an edit payload it cannot read', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');

  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }).decision, 'deny');
});

test('every completed tool call, Stop and SessionEnd record the markers the agent printed, each once however often they sweep', () => {
  const repo = nextRepo();
  const dir = tempDir('events');
  const events = join(dir, 'e.jsonl');
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'STRADDLE_HANDOFF {"skill":"straddle-setup","status":"ready","report":"ready"}' }] } }) + '\n');

  // A turn can finish Setup and start Plan before it ends, so a completed tool call already records Setup's handoff.
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_straddle_straddle-docs__search', tool_input: {}, transcript_path: transcript });
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'Stop', transcript_path: transcript });
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', transcript_path: transcript });

  assert.deepEqual(recorded(events).map((e) => e.kind === 'marker' ? [e.kind, e.marker.skill, e.marker.status] : [e.kind]), [
    ['marker', 'straddle-setup', 'ready'],
    ['turn-end'],
    ['session-end'],
  ]);
});
