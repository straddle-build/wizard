import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { field, parseJson, text } from './json.ts';

// Recorded from native client events: the Claude Code hook, or the Codex session log the Wizard follows.
// Step entry is not completion or approval. A `marker` event records what the agent printed, which is reported,
// not observed. `key` marks events swept from a transcript, so a later sweep never records them twice.
export type ObservedEvent =
  | { at: string; kind: 'session-start'; session?: string; transcript?: string }
  | { at: string; kind: 'session-end'; reason?: string }
  | { at: string; kind: 'turn-end' }
  | { at: string; kind: 'step-entered'; skill: string; step: string; key?: string }
  | { at: string; kind: 'edit'; path: string }
  | { at: string; kind: 'edit-denied'; path: string }
  | { at: string; kind: 'marker'; marker: ReportedMarker; key: string };

// Printed by the model in its visible output. Best-effort: they can be missing, repeated or wrong.
export interface ReportedMarker {
  kind: 'progress' | 'abort' | 'handoff';
  skill: string;
  step?: string;
  status?: string;
  reason?: string;
  report?: string;
}

const MARKER = /^STRADDLE_(PROGRESS|ABORT|HANDOFF) (\{.*\})\s*$/;
// A skill step file named in a tool call, such as `cat <bundle>/skills/straddle-integrate/steps/06-review.md`.
export const STEP_FILES = /\/skills\/(straddle-[a-z-]+)\/steps\/(\d{2}-[a-z0-9-]+)\.md\b/g;

export function parseMarkers(output: string): ReportedMarker[] {
  const markers: ReportedMarker[] = [];
  for (const line of output.split('\n')) {
    const match = MARKER.exec(line.trim());
    if (!match) continue;
    const body = parseJson(match[2]!);
    const skill = text(field(body, 'skill'));
    if (!skill) continue;
    const marker: ReportedMarker = { kind: match[1]!.toLowerCase() as ReportedMarker['kind'], skill };
    for (const key of ['step', 'status', 'reason', 'report'] as const) {
      const value = text(field(body, key));
      if (value !== undefined) marker[key] = value;
    }
    markers.push(marker);
  }
  return markers;
}

// The string fields each persisted event must carry, and the ones it may carry.
const EVENT_FIELDS: Record<ObservedEvent['kind'], { required: string[]; optional: string[] }> = {
  'session-start': { required: [], optional: ['session', 'transcript'] },
  'session-end': { required: [], optional: ['reason'] },
  'turn-end': { required: [], optional: [] },
  'step-entered': { required: ['skill', 'step'], optional: ['key'] },
  edit: { required: ['path'], optional: [] },
  'edit-denied': { required: ['path'], optional: [] },
  marker: { required: ['key'], optional: [] },
};
const MARKER_KINDS: Record<ReportedMarker['kind'], true> = { progress: true, abort: true, handoff: true };

const strings = (value: unknown, required: readonly string[], optional: readonly string[]) =>
  required.every((k) => typeof field(value, k) === 'string') && optional.every((k) => field(value, k) === undefined || typeof field(value, k) === 'string');

// events.jsonl sits in the repository and is appended by separate processes, so a line is used only when it has
// exactly the shape its kind promises.
function isObservedEvent(value: unknown): value is ObservedEvent {
  const kind = text(field(value, 'kind'));
  if (!kind || !Object.hasOwn(EVENT_FIELDS, kind) || typeof field(value, 'at') !== 'string') return false;
  const shape = EVENT_FIELDS[kind as ObservedEvent['kind']];
  if (!strings(value, shape.required, shape.optional)) return false;
  if (kind !== 'marker') return true;
  const marker = field(value, 'marker');
  const markerKind = text(field(marker, 'kind'));
  return markerKind !== undefined && Object.hasOwn(MARKER_KINDS, markerKind) && strings(marker, ['skill'], ['step', 'status', 'reason', 'report']);
}

// The recorded events, and how many lines were skipped because they aren't one.
export function readObservedEvents(path: string): { events: ObservedEvent[]; skipped: number } {
  if (!existsSync(path)) return { events: [], skipped: 0 };
  const events: ObservedEvent[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const value = parseJson(line);
    if (isObservedEvent(value)) events.push(value);
    else skipped++;
  }
  return { events, skipped };
}

// Appends the events not recorded yet: a keyed event already in the file is skipped.
export function appendEvents(path: string, events: readonly ObservedEvent[]): void {
  const seen = new Set(readObservedEvents(path).events.map((e) => text(field(e, 'key'))));
  const fresh = events.filter((e) => { const key = text(field(e, 'key')); return key === undefined || !seen.has(key); });
  if (fresh.length) appendFileSync(path, fresh.map((e) => JSON.stringify(e) + '\n').join(''));
}

export function stepEntries(events: readonly ObservedEvent[], skill: string): string[] {
  const steps: string[] = [];
  for (const e of events) {
    if (e.kind === 'step-entered' && e.skill === skill && !steps.includes(e.step)) steps.push(e.step);
  }
  return steps;
}

function assistantText(entry: unknown): string {
  const content = field(field(entry, 'message'), 'content');
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => (field(block, 'type') === 'text' ? [text(field(block, 'text')) ?? ''] : [])).join('\n');
}

function transcriptEntries(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((line) => parseJson(line)).filter((entry) => field(entry, 'type') === 'assistant');
}

// Assistant text from a Claude Code session transcript (JSONL). Only used to find marker and checklist lines.
export function transcriptAssistantText(path: string): string {
  return transcriptEntries(path).map(assistantText).join('\n');
}

// The markers in a Claude Code transcript, keyed by transcript entry.
export function transcriptMarkers(path: string, at: string): ObservedEvent[] {
  return transcriptEntries(path).flatMap((entry) => {
    const id = text(field(entry, 'uuid'));
    return id ? parseMarkers(assistantText(entry)).map((marker, i): ObservedEvent => ({ at, kind: 'marker', marker, key: `${id}:${i}` })) : [];
  });
}

// Reading state for one Codex session rollout log (~/.codex/sessions/.../rollout-*.jsonl), line by line.
export interface Rollout { session: string | null; line: number; calls: Map<string, string>; text: string[] }

export function newRollout(): Rollout {
  return { session: null, line: 0, calls: new Map(), text: [] };
}

// One rollout line as events: the session id, the step files a tool call names once its output is logged (a call the
// developer refuses has none), and the markers in the agent's replies. Keys are line numbers in the log.
export function rolloutEvents(state: Rollout, raw: string): ObservedEvent[] {
  const n = state.line++;
  const entry = parseJson(raw);
  const payload = field(entry, 'payload');
  const at = text(field(entry, 'timestamp')) ?? new Date().toISOString();
  if (field(entry, 'type') === 'session_meta') {
    state.session = text(field(payload, 'id')) ?? null;
    return state.session ? [{ at, kind: 'session-start', session: state.session }] : [];
  }
  if (field(entry, 'type') !== 'response_item') return [];
  const type = text(field(payload, 'type')) ?? '';
  const call = text(field(payload, 'call_id'));
  const key = `codex:${state.session}:${n}`;
  if (call && type.endsWith('_call')) { state.calls.set(call, JSON.stringify(payload)); return []; }
  if (call && type.endsWith('_call_output')) {
    const named = state.calls.get(call) ?? '';
    state.calls.delete(call);
    return [...named.matchAll(STEP_FILES)].map((m, i): ObservedEvent => ({ at, kind: 'step-entered', skill: m[1]!, step: m[2]!, key: `${key}:${i}` }));
  }
  if (type !== 'message' || field(payload, 'role') !== 'assistant') return [];
  const content = field(payload, 'content');
  const said = (Array.isArray(content) ? content : []).flatMap((c) => (field(c, 'type') === 'output_text' ? [text(field(c, 'text')) ?? ''] : [])).join('\n');
  state.text.push(said);
  return parseMarkers(said).map((marker, i): ObservedEvent => ({ at, kind: 'marker', marker, key: `${key}:${i}` }));
}

// The skill's own "Verify before merging" checklist, as the agent last printed it. The Wizard never authors it.
export function verifyChecklist(output: string): string[] {
  const lines = output.split('\n');
  const start = lines.findLastIndex((l) => /^#+\s*Verify before merging\s*$/.test(l.trim()));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^- \[[ x]\]/.test(trimmed)) { items.push(trimmed); continue; }
    if (trimmed === '' && items.length === 0) continue;
    break;
  }
  return items;
}
