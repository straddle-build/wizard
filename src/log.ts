import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRollout } from './codex.ts';
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

// Claude Code transcripts and Codex rollouts: assistant text and tool calls, timestamped.
function transcriptEntries(path: string): Entry[] {
  return readFileSync(path, 'utf8').split('\n').flatMap((line): Entry[] => {
    const entry = parseJson(line);
    const at = text(field(entry, 'timestamp'));
    if (!at) return [];
    if (field(entry, 'type') === 'response_item') {
      const payload = field(entry, 'payload');
      const type = text(field(payload, 'type')) ?? '';
      if (type.endsWith('_call')) return [{ at, kind: 'tool', name: text(field(payload, 'name')) ?? type, input: text(field(payload, 'arguments')) ?? text(field(payload, 'input')) ?? JSON.stringify(field(payload, 'action') ?? {}) }];
      const content = field(payload, 'content');
      if (type !== 'message' || field(payload, 'role') !== 'assistant' || !Array.isArray(content)) return [];
      return content.flatMap((c): Entry[] => (field(c, 'type') === 'output_text' ? [{ at, kind: 'text', text: text(field(c, 'text')) ?? '' }] : []));
    }
    const content = field(field(entry, 'message'), 'content');
    if (field(entry, 'type') !== 'assistant' || !Array.isArray(content)) return [];
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
  // Claude Code's hook names its transcript; a Codex session is found by id among its rollouts. One not found is
  // listed by what it would have been.
  const transcripts = [...new Set(events.flatMap((e) => (e.kind !== 'session-start' ? [] : e.transcript ? [e.transcript] : e.session ? [findRollout(process.env, repo, 0, e.session) ?? `the Codex rollout for session ${e.session}`] : [])))];
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

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Redaction first, then HTML escaping, for every recorded string the page shows.
const clean = (s: string) => escape(redact(s));

// Ayu Mirage token colors for fenced code: comments, strings, keywords, numbers.
const TOKENS = /(\/\/.*|#.*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|import|from|export|async|await|if|else|for|while|new|class|def|try|catch|throw|true|false|null)\b|\b(\d+(?:\.\d+)?)\b/g;
const highlight = (code: string) => {
  let html = '';
  let last = 0;
  for (const m of code.matchAll(TOKENS)) {
    const kind = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n';
    html += `${escape(code.slice(last, m.index))}<span class="${kind}">${escape(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return html + escape(code.slice(last));
};

// Agent text after redaction: Markdown tables as tables, fenced code highlighted, the rest as written.
function markdown(raw: string): string {
  const lines = redact(raw).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.startsWith('```')) {
      const end = lines.findIndex((l, j) => j > i && l.startsWith('```'));
      const stop = end < 0 ? lines.length : end;
      out.push(`<pre class="code">${highlight(lines.slice(i + 1, stop).join('\n'))}</pre>`);
      i = stop + 1;
    } else if (lines[i]!.trim().startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
      }
      out.push(`<table class="md">${rows.map((r, n) => `<tr>${r.map((c) => (n ? `<td>${escape(c)}</td>` : `<th>${escape(c)}</th>`)).join('')}</tr>`).join('')}</table>`);
    } else {
      out.push(`<div class="md">${escape(lines[i]!)}</div>`);
      i++;
    }
  }
  return out.join('');
}

function renderLog(log: SessionLog, repo: string): string {
  const missing = log.missingTranscripts.map((t) => `<p class="warn">The client transcript is missing (moved or deleted): ${clean(t)}. Showing the Wizard's events only.</p>`);
  const steps = log.steps.map((s) => {
    const rows = s.entries.map((e) => {
      if (e.kind === 'tool') return `<tr><td class="at">${clean(e.at)}</td><td class="tool">${clean(e.name)}</td><td><code>${clean(e.input)}</code></td></tr>`;
      if (e.kind === 'text') return `<tr><td class="at">${clean(e.at)}</td><td>agent</td><td>${markdown(e.text)}</td></tr>`;
      return `<tr><td class="at">${clean(e.at)}</td><td>wizard</td><td>${clean(e.kind === 'event' ? e.text : e.title)}</td></tr>`;
    });
    return `<section><h2>${clean(s.title)}</h2><table>${rows.join('')}</table></section>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>Straddle Wizard session log</title>
<style>body{font:14px ui-monospace,monospace;background:#1f2430;color:#cbccc6;margin:2em}h2{color:#ffcc66}table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #33415e;padding:4px 8px;vertical-align:top;text-align:left}th{color:#ffd580}.at{color:#707a8c;white-space:nowrap}.tool{color:#5ccfe6}pre,code,.md{white-space:pre-wrap;margin:0}table.md{width:auto;margin:4px 0}table.md td,table.md th{border:1px solid #33415e}pre.code{background:#232834;padding:8px}.c{color:#5c6773;font-style:italic}.s{color:#bae67e}.k{color:#ffa759}.n{color:#ffcc66}.warn{color:#f28779}</style>
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
