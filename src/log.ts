import { spawn } from 'node:child_process';
import { closeSync, existsSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRollout } from './codex.ts';
import { openRegular } from './discovery.ts';
import { readObservedEvents, type ObservedEvent } from './events.ts';
import { field, parseJson, text } from './json.ts';
import { WIZARD_DIR } from './receipt.ts';
import { markdown, tableCells } from './tui.ts';
import type { Prompter } from './ui.ts';

// A tool call's highlighted view, as Northwind's integration log draws it (app/integration-log/code.ts).
interface CodeBlock { code: string; language: string; meta?: string; props: { frame: 'terminal' | 'code' | 'none'; title?: string } }

// One line of the session, from events.jsonl or the client transcript, in time order.
type Entry =
  | { at: string; kind: 'step'; title: string; file: string }
  | { at: string; kind: 'tool'; name: string; input: string; block: CodeBlock | null }
  | { at: string; kind: 'text'; text: string }
  | { at: string; kind: 'event'; text: string };

interface Step { title: string; entries: Entry[] }
// A transcript the session named but the page can't show, and why.
interface Unavailable { path: string; problem: string }
interface SessionLog { steps: Step[]; unavailable: Unavailable[] }

// Northwind's integration log rules (lib/recorded-session.ts): sk_/pk_/rk_/whsec_ keys, Bearer and Basic credentials,
// `KEY=value` and `"secret": "value"` pairs, JWTs, long base64/hex runs, and home directories as `~`. Order matters:
// Bearer before `Authorization:`. Added here: account and routing numbers, named or standing alone as 8 to 17 digits
// (a table cell, a sentence), where digits inside a timestamp, path, version or id stay; and the Markdown and quoting
// agents put around a named value.
//
// The separator takes the label's closing delimiter on either side of the colon (`**Token**:`, `__API key:__`,
// `` `api_key`: ``, `"api_key":`; after the colon only when a space follows) and the value's opening quote or
// backtick. The value is then read by how it opens, with no length bound, and an unclosed one runs to the end of its
// line rather than being reread as prose:
// - a double-quoted value to its unescaped closing quote, reading `\"` and `\\` as escapes; one opened with an escaped
//   quote (JSON inside a string, `\"password\":\"…\"`) to its `\"`, reading `\\\"` and `\\\\` as its escapes;
// - a single-quoted or backticked value to its closing mark;
// - an emphasized value (`**…**`, `_…_`) to the matching closer before a space or punctuation;
// - any other value to whitespace or a quote, keeping runs of `,` `;` `}` `\` when more value follows them.
// Every branch stops only where its own terminator is, so no attempt fails after a long scan and the work is linear.
// Values under 6 characters stay, as in Northwind.
//
// A named rule matches at the separator and finds the name by looking behind it, so the name is never consumed and
// each separator looks back over one run of name characters: matching from the start of the name retried a `[\w-]*`
// at every word boundary and made long hyphenated text quadratic.
const named = (name: string, value: string) =>
  new RegExp(String.raw`(?=[*\\"'\x60\s:=])(?<=${name}[\w-]*)([*\\]*["'\x60]?\s*[:=](?:[*_\x60]{1,3}(?=\s))?\s*\\*(?:\x60{1,2}|["'])?)${value}`, 'gi');
const SECRET_VALUE = String.raw`(?!\[redacted\])(?:(?<=\\")(?:[^"\\\n]|\\\\(?:\\["\\]|[^"\\\n])|\\(?!")[^\n]?){6,}(?=\\?"|\n|$)|(?<=[^\\]")(?:[^"\\\n]|\\[^\n]?){6,}(?="|\n|$)|(?<=')(?:[^'\\\n]|\\[^\n]?){6,}(?='|\n|$)|(?<=\x60)[^\x60\n]{6,}(?=\x60|\n|$)|([*_]{1,2})[^\n]+?(?:\2(?=[\s.,;:!?)\]]|$)|(?=\n|$))|(?:[^\s"'\x60\\,;}]|[\\,;}]+(?=[^\s"'\x60\\,;}])){6,})`;
const SECRETS: [RegExp, string][] = [
  [/\b(?:sk|pk|rk|whsec)_[A-Za-z0-9_-]{6,}/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+(?!\[redacted\])[^\s"'`\\]+/gi, '$1 [redacted]'],
  [named('(?:api[_ -]?key|secret|token|password|paykey|signature|authorization)', SECRET_VALUE), '$1[redacted]'],
  [named('(?:account|routing)[_ -]?(?:number|num|no)?', String.raw`\d{4,17}\b`), '$1[redacted]'],
  [/(?<![\w.:/-])\d{8,17}(?![\w:/-]|[.,]\d)/g, '[redacted]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/g, '[redacted]'],
  [/(?<![\w+=])(?=[\w+=]*\d)(?=[\w+=]*[A-Za-z])[A-Za-z0-9+_=]{32,}/g, '[redacted]'],
  [/\/(?:Users|home)\/[\w.-]+(?=\/|\b)/g, '~'],
];

function redact(raw: string): string {
  return SECRETS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), raw);
}

// Long outputs and inputs stop at 2000 characters, always after redaction, so a clip never splits a secret past its rule.
const CLIP = 2000;
const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}\n… ${s.length - CLIP} more characters` : s);

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

// A tool call's input as the agent wrote it: one `name: value` line per field, multi-line values (commands, patches,
// file contents) with their own line breaks, and a list of words as one command line.
function toolInput(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return Object.entries(input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : Array.isArray(v) && v.every((w) => typeof w === 'string') ? v.join(' ') : JSON.stringify(v)}`).join('\n');
}

// Shiki ids for the files the Wizard writes and edits; anything else renders as plain text.
const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', json: 'json', md: 'md', css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', sh: 'bash', py: 'python', rb: 'ruby', go: 'go' };

// Northwind's block(): Bash shows `$ command` over its output in a terminal frame; Edit's old and new lines become a
// diff in the file's language; Write shows the file; any other call shows its result, as JSON when it reads as JSON.
// A Codex shell call reads as Bash. A call with no recorded result and nothing of its own to show gets no block.
function toolBlock(name: string, input: unknown, result: string): CodeBlock | null {
  const s = (k: string) => text(field(input, k)) ?? '';
  const words = field(input, 'command');
  const command = Array.isArray(words) ? words.join(' ') : s('command');
  const target = s('file_path');
  const lang = LANG[target.split('.').pop() ?? ''] ?? 'txt';
  const block: CodeBlock | null =
    name === 'Bash' || (name === 'shell' && command) ? { code: `$ ${command}\n${result}`, language: 'shellsession', props: { frame: 'terminal' } }
    : name === 'Edit' ? { code: `${s('old_string').replace(/^/gm, '- ')}\n${s('new_string').replace(/^/gm, '+ ')}`, language: 'diff', meta: `lang="${lang}"`, props: { frame: 'code', title: target } }
    : name === 'Write' ? { code: s('content'), language: lang, props: { frame: 'code', title: target } }
    : result ? { code: result, language: /^\s*[[{]/.test(result) ? 'json' : 'txt', props: { frame: 'none' } }
    : null;
  if (!block) return null;
  return { ...block, code: clip(redact(block.code)), props: { ...block.props, ...(block.props.title === undefined ? {} : { title: redact(block.props.title) }) } };
}

// The text of a Claude Code tool_result or a Codex call output, which may wrap it as `{"output": …}`.
function resultText(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => text(field(part, 'text')) ?? '').join('\n');
  const raw = text(value) ?? (value === undefined ? '' : JSON.stringify(value));
  return text(field(parseJson(raw), 'output')) ?? raw;
}

// Claude Code transcripts and Codex rollouts: assistant text and tool calls, timestamped, each call with the result
// recorded for it (paired by id, so a resumed session appending to the same file keeps its pairs).
function transcriptEntries(content: string): Entry[] {
  const rows = content.split('\n').map(parseJson);
  const results = new Map<string, string>();
  for (const row of rows) {
    const payload = field(row, 'payload');
    const call = text(field(payload, 'call_id'));
    if (call && (text(field(payload, 'type')) ?? '').endsWith('_output')) results.set(call, resultText(field(payload, 'output')));
    const content = field(field(row, 'message'), 'content');
    if (field(row, 'type') === 'user' && Array.isArray(content)) {
      for (const block of content) if (field(block, 'type') === 'tool_result') results.set(text(field(block, 'tool_use_id')) ?? '', resultText(field(block, 'content')));
    }
  }
  return rows.flatMap((entry): Entry[] => {
    const at = text(field(entry, 'timestamp'));
    if (!at) return [];
    if (field(entry, 'type') === 'response_item') {
      const payload = field(entry, 'payload');
      const type = text(field(payload, 'type')) ?? '';
      if (type.endsWith('_call')) {
        const args = text(field(payload, 'arguments'));
        const input = args === undefined ? field(payload, 'input') : parseJson(args) ?? args;
        const name = text(field(payload, 'name')) ?? type;
        return [{ at, kind: 'tool', name, input: toolInput(input), block: toolBlock(name, input, results.get(text(field(payload, 'call_id')) ?? '') ?? '') }];
      }
      const content = field(payload, 'content');
      if (type !== 'message' || field(payload, 'role') !== 'assistant' || !Array.isArray(content)) return [];
      return content.flatMap((c): Entry[] => (field(c, 'type') === 'output_text' ? [{ at, kind: 'text', text: text(field(c, 'text')) ?? '' }] : []));
    }
    const content = field(field(entry, 'message'), 'content');
    if (field(entry, 'type') !== 'assistant' || !Array.isArray(content)) return [];
    return content.flatMap((block): Entry[] => {
      const type = field(block, 'type');
      if (type === 'text') return [{ at, kind: 'text', text: text(field(block, 'text')) ?? '' }];
      if (type !== 'tool_use') return [];
      const name = text(field(block, 'name')) ?? 'tool';
      const input = field(block, 'input');
      return [{ at, kind: 'tool', name, input: toolInput(input), block: toolBlock(name, input, results.get(text(field(block, 'id')) ?? '') ?? '') }];
    });
  });
}

// The transcript path comes from events.jsonl in the repository, so it is read the way discovery reads repository
// files: a regular file only, never through a symlink, without blocking on a FIFO, and only up to a size bound. A
// directory, device or FIFO there leaves the page showing the recorded events.
const TRANSCRIPT_LIMIT = 256 * 2 ** 20;
function readTranscript(path: string): { text: string } | Unavailable {
  const file = openRegular(path);
  if (!file) return { path, problem: existsSync(path) ? "isn't a regular file I can read" : 'is missing (moved or deleted)' };
  try {
    if (file.size > TRANSCRIPT_LIMIT) return { path, problem: `is over ${TRANSCRIPT_LIMIT / 2 ** 20} MB` };
    const buf = Buffer.allocUnsafe(file.size);
    let n = 0;
    for (let r = 1; n < file.size && r > 0; n += r) r = readSync(file.fd, buf, n, file.size - n, n);
    return { text: buf.toString('utf8', 0, n) };
  } finally {
    closeSync(file.fd);
  }
}

// Null when the Wizard recorded no session here.
function sessionLog(repo: string): SessionLog | null {
  const { events } = readObservedEvents(join(repo, WIZARD_DIR, 'events.jsonl'));
  if (!events.length) return null;
  // Claude Code's hook names its transcript; a Codex session is found by id among its rollouts. One not found is
  // listed by what it would have been.
  const transcripts = [...new Set(events.flatMap((e) => (e.kind !== 'session-start' ? [] : e.transcript ? [e.transcript] : e.session ? [findRollout(process.env, repo, 0, e.session) ?? `the Codex rollout for session ${e.session}`] : [])))].map(readTranscript);
  const entries: Entry[] = [
    ...events.flatMap((e): Entry[] => {
      if (e.kind === 'step-entered') return [{ at: e.at, kind: 'step', title: `${e.skill} · ${e.step}`, file: `/skills/${e.skill}/steps/${e.step}.md` }];
      const line = eventText(e);
      return line ? [{ at: e.at, kind: 'event', text: line }] : [];
    }),
    ...transcripts.flatMap((t) => ('text' in t ? transcriptEntries(t.text) : [])),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const steps: Step[] = [{ title: 'Session start', entries: [] }];
  for (const e of entries) {
    if (e.kind !== 'step') { steps.at(-1)!.entries.push(e); continue; }
    // The step is entered once its file has been read, so the tool call that read it opens the step.
    const last = steps.at(-1)!.entries.at(-1);
    const opener = last?.kind === 'tool' && last.input.includes(e.file) ? steps.at(-1)!.entries.pop()! : null;
    steps.push({ title: e.title, entries: opener ? [opener] : [] });
  }
  return { steps: steps.filter((s, i) => i > 0 || s.entries.length), unavailable: transcripts.flatMap((t) => ('problem' in t ? [t] : [])) };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Redaction first, then HTML escaping, for every recorded string the page shows.
const clean = (s: string) => escape(redact(s));

// An agent reply after redaction, split at its fenced code and its pipe tables. Prose goes through the Wizard's own
// terminal Markdown renderer (headings, lists, bold, code), so it reads like the report screens; each fence is
// highlighted like tool output, in the language its opening line names; each table is drawn as the terminal draws it.
type ReplyPart = { prose: string } | { table: string[] } | { block: CodeBlock };
function replyParts(raw: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  const lines = redact(raw).split('\n');
  let prose: string[] = [];
  const flush = () => {
    if (prose.join('').trim()) parts.push({ prose: prose.join('\n') });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(lines[i]!);
    if (/^\s*\|/.test(lines[i]!)) {
      flush();
      const table: string[] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]!); i++) table.push(lines[i]!);
      parts.push({ table });
      i--;
    } else if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) code.push(lines[i]!);
      parts.push({ block: { code: code.join('\n'), language: fence[1] || 'txt', props: { frame: 'none' } } });
    } else {
      prose.push(lines[i]!);
    }
  }
  flush();
  return parts;
}

// The terminal renderer's Markdown, escaped, with its color codes as nested spans: each code opens a span and each
// reset closes the innermost, so a bold header holding inline code closes cleanly.
const MARKDOWN_COLUMNS = 96;
function terminalHtml(md: string): string {
  let open = 0;
  const html = escape(markdown({ width: MARKDOWN_COLUMNS, color: true }, md)).replace(/\x1b\[([\d;]*)m/g, (_, sgr: string) => {
    if (sgr !== '0' && sgr !== '') { open++; return `<span class="t${sgr.replace(';', '-')}">`; }
    if (!open) return '';
    open--;
    return '</span>';
  });
  return html + '</span>'.repeat(open);
}

// A reply's table: the terminal's box drawing for the eye, hidden from screen readers, beside the same cells as a real
// table for them. Inline backticks and bold markers come off the cells there.
function tableHtml(lines: readonly string[]): string {
  const [head = [], ...body] = lines.flatMap((l) => [tableCells(l) ?? []]).filter((cells) => cells.length);
  const cell = (tag: 'th' | 'td', c: string) => `<${tag}${tag === 'th' ? ' scope="col"' : ''}>${escape(c.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1'))}</${tag}>`;
  // A table box grows to its content whatever its width, so the clipping goes on a wrapper.
  return `<div class="md" tabindex="0"><pre aria-hidden="true">${terminalHtml(lines.join('\n'))}</pre><div class="visually-hidden"><table><thead><tr>${head.map((c) => cell('th', c)).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => cell('td', c)).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}

const row = (at: string, who: string, body: string, kind = '') => `<div class="row${kind}"><span class="at">${clean(at)}</span><span class="who">${who}</span>${body}</div>`;

// Highlights every tool block with Expressive Code and Shiki's Ayu Mirage. Imported here, not at the top: every Wizard
// command loads this module, and only `wizard log` should pay for the highlighter. Everything comes from installed
// packages; the page carries its HTML, CSS and copy-button script inline.
async function highlight(blocks: readonly CodeBlock[]): Promise<{ html: string[]; styles: string; script: string }> {
  const { ExpressiveCode, loadShikiTheme } = await import('expressive-code');
  const { toHtml } = await import('expressive-code/hast');
  const ec = new ExpressiveCode({
    themes: [await loadShikiTheme('ayu-mirage')],
    frames: { extractFileNameFromCode: false },
    defaultProps: { wrap: true },
    styleOverrides: { codeFontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', uiFontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', codeFontSize: '0.8rem', uiFontSize: '0.8rem' },
    // A fence can name any language; one Shiki doesn't know renders as plain text, and that fallback is no news for
    // `wizard log`'s output. Real failures still reject the render.
    logger: { warn: () => {}, error: () => {} },
  });
  const done = await Promise.all(blocks.map((b) => ec.render(b)));
  const styles = new Set([await ec.getBaseStyles(), await ec.getThemeStyles(), ...done.flatMap((d) => [...d.styles])]);
  return { html: done.map((d) => toHtml(d.renderedGroupAst)), styles: [...styles].join(''), script: (await ec.getJsModules()).join('\n') };
}

async function renderLog(log: SessionLog, repo: string): Promise<string> {
  const entries = log.steps.flatMap((s) => s.entries);
  const replies = new Map(entries.flatMap((e) => (e.kind === 'text' ? [[e, replyParts(e.text)] as const] : [])));
  const blocks = [
    ...entries.flatMap((e) => (e.kind === 'tool' && e.block ? [e.block] : [])),
    ...[...replies.values()].flat().flatMap((p) => ('block' in p ? [p.block] : [])),
  ];
  const code = await highlight(blocks);
  const highlighted = new Map(blocks.map((b, i) => [b, code.html[i]!]));
  const missing = log.unavailable.map((t) => `<p class="warn">The client transcript ${t.problem}: ${clean(t.path)}. Showing the Wizard's events only.</p>`);
  const steps = log.steps.map((s) => {
    const rows = s.entries.map((e) => {
      // Like Northwind's rows, a call reads as one line (the command, the file, or the call's fields) and opens to its
      // highlighted output. Frame `none` keeps the fields above, since the block holds only the result. An MCP tool
      // reads as Northwind names it: mcp__plugin_straddle_straddle-api__execute-request is straddle-api execute-request.
      if (e.kind === 'tool') {
        const summary = !e.block ? '' : e.block.props.frame === 'terminal' ? e.block.code.split('\n')[0]! : e.block.props.title || 'result';
        const fields = e.block && e.block.props.frame !== 'none' ? '' : `<pre class="fields">${escape(clip(redact(e.input)))}</pre>`;
        const name = e.name.replace(/^mcp__plugin_[^_]+_/, '').replace(/^mcp__/, '').replace('__', ' ');
        return row(e.at, clean(name), `<div class="body">${fields}${e.block ? `<details><summary>${escape(summary)}</summary>${highlighted.get(e.block)}</details>` : ''}</div>`, ' tool');
      }
      // A reply's prose and tables keep the terminal's 96 columns, so they scroll sideways on a narrow screen and take
      // keyboard focus for that.
      if (e.kind === 'text') {
        const parts = replies.get(e)!.map((p) => ('block' in p ? highlighted.get(p.block)! : 'table' in p ? tableHtml(p.table) : `<pre class="md" tabindex="0">${terminalHtml(p.prose)}</pre>`));
        return row(e.at, 'agent', `<div class="body">${parts.join('')}</div>`);
      }
      return row(e.at, 'wizard', `<div class="body">${clean(e.kind === 'event' ? e.text : e.title)}</div>`, ' wizard');
    });
    return `<section><h2>${clean(s.title)}</h2>${rows.join('')}</section>`;
  });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Straddle Wizard session log</title>
<style>
:root{color-scheme:dark;--bg:#1f2430;--panel:#232834;--fg:#cbccc6;--muted:#8a94a6;--line:#33415e;--accent:#5ccfe6;--heading:#ffcc66}
*{box-sizing:border-box}
body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg);margin:0 auto;padding:2rem 1.5rem;max-width:84rem}
::selection{background:#34455a}
h1{font-size:1.5rem;margin:0 0 .5rem;color:var(--fg);overflow-wrap:anywhere}
h2{color:var(--heading);font-size:1.1rem;margin:2rem 0 .5rem;overflow-wrap:anywhere}
p{max-width:75ch;margin:0 0 .75rem;overflow-wrap:anywhere}
.row{display:grid;grid-template-columns:24ch 16ch minmax(0,1fr);gap:0 1rem;padding:.5rem 0;border-top:1px solid var(--line)}
.at{color:var(--muted);font-variant-numeric:tabular-nums}
.who{color:var(--fg);min-width:0;overflow-wrap:anywhere}
.tool .who{color:var(--accent)}
.wizard .body{color:var(--muted)}
.body{margin:0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.fields{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.body .expressive-code{margin-top:.5rem;white-space:normal}
summary{cursor:pointer;white-space:pre-wrap;overflow-wrap:anywhere}
summary:focus-visible,.md:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.md{white-space:pre;overflow-x:auto;overflow-wrap:normal;padding-bottom:.25rem}
.md pre{margin:0;font:inherit}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.t1{font-weight:bold}.t2{color:var(--muted)}.t36{color:var(--accent)}.t1-36{color:var(--heading);font-weight:bold}.t32{color:#bae67e}.t33{color:var(--heading)}.t31{color:#f28779}
.warn{color:#f28779}
@media (max-width:640px){body{padding:1rem}h1{font-size:1.2rem}.row{display:flex;flex-wrap:wrap;gap:0 1rem}.row .body{flex:0 0 100%;margin-top:.25rem}}
.md{line-height:1.2}
</style>
<style>${code.styles}</style>
<script type="module">${code.script}</script>
<main><h1>Straddle Wizard session log</h1><p>${clean(repo)}. Built on this machine from ${WIZARD_DIR}/events.jsonl and your agent's transcript; nothing was uploaded.</p>
${missing.join('\n')}
${steps.join('\n')}
</main>
</html>
`;
}

// Writes the viewer next to the run record and returns its path, or null when no session was recorded. The page holds
// the session's commands and replies, so it goes to a fresh owner-only file renamed into place: a symlink or a looser
// file already at the path is replaced, never followed or reused.
export async function writeLog(repo: string): Promise<string | null> {
  const log = sessionLog(repo);
  if (!log) return null;
  const html = await renderLog(log, repo);
  const path = join(repo, WIZARD_DIR, 'session-log.html');
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, html, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
  return path;
}

// The page's path is data on every platform: `open` and xdg-open take it as an argument, and on Windows PowerShell's
// Invoke-Item reads it from the environment as a literal path, so no cmd or PowerShell parsing sees `&`, `%` or quotes.
export function openFile(path: string): void {
  const [command, args, env] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:STRADDLE_WIZARD_LOG'], { ...process.env, STRADDLE_WIZARD_LOG: path }]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [path], process.env];
  spawn(command, args, { stdio: 'ignore', detached: true, env, windowsHide: true }).on('error', () => {}).unref();
}

// End of a session in a terminal: offers the log when the session recorded anything. Only the event count decides;
// the transcripts are read once the developer says yes.
export async function offerLog(io: Prompter, repo: string, open: (path: string) => void = openFile): Promise<void> {
  if (!readObservedEvents(join(repo, WIZARD_DIR, 'events.jsonl')).events.length) return;
  const answer = await io.ask('Open the session log? [Y/n] ');
  if (answer === null || !['', 'y', 'yes'].includes(answer.toLowerCase())) return;
  const path = (await writeLog(repo))!;
  open(path);
  io.say(`Opened ${path}`);
}
