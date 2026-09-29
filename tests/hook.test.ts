import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('records step entry only from a completed Read of a skill step file, without file contents or prompts', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');
  const read = (hook_event_name: string, file_path: string) => ({ hook_event_name, tool_name: 'Read', tool_input: { file_path } });

  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'SessionStart', transcript_path: '/t/s.jsonl', source: 'startup' });
  // An attempted read the developer then denies never reaches PostToolUse, so it is not a step entry.
  runHook(repo, events, 'straddle-integration-plan.md', read('PreToolUse', '/b/skills/straddle-plan/steps/02-sources.md'));
  runHook(repo, events, 'straddle-integration-plan.md', read('PostToolUse', '/b/skills/straddle-plan/steps/03-write-plan.md'));
  runHook(repo, events, 'straddle-integration-plan.md', read('PostToolUse', join(repo, 'src/app/page.tsx')));
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'UserPromptSubmit', prompt: 'my key is sk_test_secret' });

  const lines = recorded(events).map(({ at, ...rest }) => rest);
  assert.deepEqual(lines, [
    { kind: 'session-start', transcript: '/t/s.jsonl' },
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
