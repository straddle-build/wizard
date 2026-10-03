import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readObservedEvents, type ObservedEvent } from './events.ts';
import { field, parseJson, text } from './json.ts';
import { WIZARD_DIR } from './receipt.ts';
import type { Prompter } from './ui.ts';

// One line of the session, from events.jsonl or the client transcript, in time order.
type Entry =
  | { at: string; kind: 'step'; title: string }
  | { at: string; kind: 'tool'; name: string; input: string }
  | { at: string; kind: 'text'; text: string }
  | { at: string; kind: 'event'; text: string };

interface Step { title: string; entries: Entry[] }
interface SessionLog { steps: Step[]; missingTranscripts: string[] }

// Secrets go before anything is rendered: API keys, bearer tokens, paykey and other credential values, and digit
// runs long enough to be account or routing numbers.
const SECRETS: [RegExp, string][] = [
  [/\bsk_[A-Za-z0-9_]{8,}/g, 'sk_[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/((?:paykey|api[_-]?key|secret|token|password)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^\s"'\\,}]{6,}/gi, '$1[redacted]'],
  [/\b\d{6,17}\b/g, '[redacted number]'],
];

function redact(raw: string): string {
  return SECRETS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), raw);
}

const eventText = (e: ObservedEvent): string | null => {
  switch (e.kind) {
    case 'session-start': return `Session started${e.session ? ` (${e.session})` : ''}`;
    case 'session-end': return `Session ended${e.reason ? ` (${e.reason})` : ''}`;
    case 'edit': return `Edited ${e.path}`;
    case 'edit-denied': return `Blocked an edit before the plan existed: ${e.path}`;
    case 'marker': return `Agent reported ${e.marker.kind}: ${JSON.stringify(e.marker)}`;
    case 'go-live-skipped': return 'You finished without Go Live';
    default: return null;
  }
};

// Claude Code and Cursor transcripts: assistant text and tool calls, timestamped.
function transcriptEntries(path: string): Entry[] {
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    const entry = parseJson(line);
    const at = text(field(entry, 'timestamp'));
    const content = field(field(entry, 'message'), 'content');
    if (field(entry, 'type') !== 'assistant' || !at || !Array.isArray(content)) return [];
    return content.flatMap((block): Entry[] => {
      const type = field(block, 'type');
      if (type === 'text') return [{ at, kind: 'text', text: text(field(block, 'text')) ?? '' }];
      if (type === 'tool_use') return [{ at, kind: 'tool', name: text(field(block, 'name')) ?? 'tool', input: JSON.stringify(field(block, 'input') ?? {}) }];
      return [];
    });
  });
}

// Null when the Wizard recorded no session here.
function sessionLog(repo: string): SessionLog | null {
  const { events } = readObservedEvents(join(repo, WIZARD_DIR, 'events.jsonl'));
  if (!events.length) return null;
  const transcripts = [...new Set(events.flatMap((e) => (e.kind === 'session-start' && e.transcript ? [e.transcript] : [])))];
  const missingTranscripts = transcripts.filter((t) => !existsSync(t));
  const entries: Entry[] = [
    ...events.flatMap((e): Entry[] => {
      if (e.kind === 'step-entered') return [{ at: e.at, kind: 'step', title: `${e.skill} · ${e.step}` }];
      const line = eventText(e);
      return line ? [{ at: e.at, kind: 'event', text: line }] : [];
    }),
    ...transcripts.filter((t) => existsSync(t)).flatMap(transcriptEntries),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const steps: Step[] = [{ title: 'Session start', entries: [] }];
  for (const e of entries) {
    if (e.kind === 'step') steps.push({ title: e.title, entries: [] });
    else steps.at(-1)!.entries.push(e);
  }
  return { steps: steps.filter((s, i) => i > 0 || s.entries.length), missingTranscripts };
}

// Redaction first, then HTML escaping, for every recorded string the page shows.
const clean = (s: string) => redact(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function renderLog(log: SessionLog, repo: string): string {
  const missing = log.missingTranscripts.map((t) => `<p class="warn">The client transcript is missing (moved or deleted): ${clean(t)}. Showing the Wizard's events only.</p>`);
  const steps = log.steps.map((s) => {
    const rows = s.entries.map((e) => {
      if (e.kind === 'tool') return `<tr><td class="at">${clean(e.at)}</td><td class="tool">${clean(e.name)}</td><td><code>${clean(e.input)}</code></td></tr>`;
      if (e.kind === 'text') return `<tr><td class="at">${clean(e.at)}</td><td>agent</td><td><pre>${clean(e.text)}</pre></td></tr>`;
      return `<tr><td class="at">${clean(e.at)}</td><td>wizard</td><td>${clean(e.kind === 'event' ? e.text : e.title)}</td></tr>`;
    });
    return `<section><h2>${clean(s.title)}</h2><table>${rows.join('')}</table></section>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>Straddle Wizard session log</title>
<style>body{font:14px ui-monospace,monospace;background:#1f2430;color:#cbccc6;margin:2em}h2{color:#ffcc66}table{border-collapse:collapse;width:100%}td{border-top:1px solid #33415e;padding:4px 8px;vertical-align:top}.at{color:#707a8c;white-space:nowrap}.tool{color:#5ccfe6}pre,code{white-space:pre-wrap;margin:0}.warn{color:#f28779}</style>
<h1>Straddle Wizard session log</h1><p>${clean(repo)}. Built on this machine from ${WIZARD_DIR}/events.jsonl and your agent's transcript; nothing was uploaded.</p>
${missing.join('\n')}
${steps.join('\n')}
`;
}

// Writes the viewer next to the run record and returns its path, or null when no session was recorded.
export function writeLog(repo: string): string | null {
  const log = sessionLog(repo);
  if (!log) return null;
  const path = join(repo, WIZARD_DIR, 'session-log.html');
  writeFileSync(path, renderLog(log, repo), { mode: 0o600 });
  return path;
}

export function openFile(path: string): void {
  const [command, ...args] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  spawn(command!, [...args, path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// End of a session in a terminal: offers the log when the session recorded anything.
export async function offerLog(io: Prompter, repo: string, open: (path: string) => void = openFile): Promise<void> {
  if (!sessionLog(repo)) return;
  const answer = await io.ask('Open the session log? [Y/n] ');
  if (answer === null || !['', 'y', 'yes'].includes(answer.toLowerCase())) return;
  const path = writeLog(repo)!;
  open(path);
  io.say(`Opened ${path}`);
}
