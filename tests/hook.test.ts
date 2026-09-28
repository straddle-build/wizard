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

test('records step entry from a Read of a skill step file, without file contents or prompts', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');

  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'SessionStart', transcript_path: '/t/s.jsonl', source: 'startup' });
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/b/skills/straddle-plan/steps/03-write-plan.md' } });
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'src/app/page.tsx') } });
  runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'UserPromptSubmit', prompt: 'my key is sk_test_secret' });

  const lines = recorded(events).map(({ at, ...rest }) => rest);
  assert.deepEqual(lines, [
    { kind: 'session-start', transcript: '/t/s.jsonl' },
    { kind: 'step-entered', skill: 'straddle-plan', step: '03-write-plan' },
  ]);
  assert.ok(!readFileSync(events, 'utf8').includes('sk_test_secret'));
});

test('denies code edits in the repository until the durable plan exists, and allows the plan itself', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');
  const write = (path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(repo, path), content: 'x' } });

  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('src/straddle.ts')).decision, 'deny');
  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('straddle-integration-plan.md')).decision, undefined);

  writeFiles(repo, { 'straddle-integration-plan.md': '# Straddle integration plan\n' });
  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', write('src/straddle.ts')).decision, undefined);

  assert.deepEqual(recorded(events).map((e) => [e.kind, e.path]), [
    ['edit-denied', 'src/straddle.ts'],
    ['edit', 'straddle-integration-plan.md'],
    ['edit', 'src/straddle.ts'],
  ]);
});

test('fails closed on an edit payload it cannot read', () => {
  const repo = nextRepo();
  const events = join(tempDir('events'), 'e.jsonl');

  assert.equal(runHook(repo, events, 'straddle-integration-plan.md', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }).decision, 'deny');
});
