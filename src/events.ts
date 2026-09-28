import { existsSync, readFileSync } from 'node:fs';
import { field, parseJson, text } from './json.ts';

// Recorded by the Wizard's hook from native client events. Step entry is not completion or approval.
export type ObservedEvent =
  | { at: string; kind: 'session-start'; transcript?: string }
  | { at: string; kind: 'session-end'; reason?: string }
  | { at: string; kind: 'turn-end' }
  | { at: string; kind: 'step-entered'; skill: string; step: string }
  | { at: string; kind: 'edit'; path: string }
  | { at: string; kind: 'edit-denied'; path: string };

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

export function readObservedEvents(path: string): ObservedEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => parseJson(line)).filter((e): e is ObservedEvent => typeof field(e, 'kind') === 'string');
}

export function stepEntries(events: readonly ObservedEvent[], skill: string): string[] {
  const steps: string[] = [];
  for (const e of events) {
    if (e.kind === 'step-entered' && e.skill === skill && !steps.includes(e.step)) steps.push(e.step);
  }
  return steps;
}

// Assistant text from a Claude Code session transcript (JSONL). Only used to find marker and checklist lines.
export function transcriptAssistantText(path: string): string {
  if (!existsSync(path)) return '';
  const parts: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const entry = parseJson(line);
    if (field(entry, 'type') !== 'assistant') continue;
    const content = field(field(entry, 'message'), 'content');
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (field(block, 'type') === 'text') parts.push(text(field(block, 'text')) ?? '');
    }
  }
  return parts.join('\n');
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
