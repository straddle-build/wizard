#!/usr/bin/env node
// Claude Code hook command installed per session through `claude --settings`. It records only event kind,
// skill step names and repository-relative edit paths: never prompts, file contents or tool output.
// Step entries and edits come from PostToolUse, which runs only after a tool call was allowed and completed;
// an attempted call the client or developer denies is never recorded as progress or a change.
// PreToolUse enforces "no code edit before the durable plan exists" for Claude Code's file-edit tools.
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { ObservedEvent } from './events.ts';
import { field, parseJson, text } from './json.ts';
import { SKILL_ARTIFACTS } from './programs.ts';

const STEP_FILE = /\/skills\/(straddle-[a-z-]+)\/steps\/(\d{2}-[a-z0-9-]+)\.md$/;
const EDIT_TOOLS: Record<string, true> = { Edit: true, Write: true, MultiEdit: true, NotebookEdit: true };

const { values } = parseArgs({ options: { events: { type: 'string' }, repo: { type: 'string' }, gate: { type: 'string' } } });
const eventsFile = values.events ?? '';
const repo = values.repo ?? '';
const gate = (values.gate ?? '').split(',').filter(Boolean);

const payload = parseJson(readFileSync(0, 'utf8'));
const hookEvent = text(field(payload, 'hook_event_name'));
const tool = text(field(payload, 'tool_name')) ?? '';
const input = field(payload, 'tool_input');
const at = new Date().toISOString();

function record(event: ObservedEvent): void {
  appendFileSync(eventsFile, JSON.stringify(event) + '\n');
}

function repoRelative(path: string): string | null {
  const abs = resolve(path);
  const roots = [resolve(repo)];
  if (existsSync(repo)) roots.push(realpathSync(repo));
  for (const root of roots) {
    const rel = relative(root, abs);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return null;
}

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}

if (hookEvent === 'SessionStart') {
  const transcript = text(field(payload, 'transcript_path'));
  record(transcript ? { at, kind: 'session-start', transcript } : { at, kind: 'session-start' });
} else if (hookEvent === 'SessionEnd') {
  const reason = text(field(payload, 'reason'));
  record(reason ? { at, kind: 'session-end', reason } : { at, kind: 'session-end' });
} else if (hookEvent === 'Stop') {
  record({ at, kind: 'turn-end' });
} else if (hookEvent === 'PostToolUse' && tool === 'Read') {
  const step = STEP_FILE.exec(text(field(input, 'file_path')) ?? '');
  if (step) record({ at, kind: 'step-entered', skill: step[1]!, step: step[2]! });
} else if (hookEvent === 'PostToolUse' && EDIT_TOOLS[tool]) {
  const path = text(field(input, 'file_path')) ?? text(field(input, 'notebook_path'));
  const rel = path ? repoRelative(path) : null;
  if (rel !== null) record({ at, kind: 'edit', path: rel });
} else if (hookEvent === 'PreToolUse' && EDIT_TOOLS[tool]) {
  const path = text(field(input, 'file_path')) ?? text(field(input, 'notebook_path'));
  const rel = path ? repoRelative(path) : null;
  if (!path) {
    deny('Straddle Wizard could not read the edit target, so it cannot confirm the durable plan exists.');
  } else if (rel === null || (SKILL_ARTIFACTS as readonly string[]).includes(rel) || gate.some((file) => existsSync(join(repo, file)))) {
    // Allowed by the gate. Outside the repository, or once the plan exists, the client's own permission prompt decides.
  } else {
    record({ at, kind: 'edit-denied', path: rel });
    deny(`No code edit before the durable plan exists: ${gate.join(' or ')} is not in the repository yet. Run the plan step first.`);
  }
}
