// Terminal screens in the Straddle CLI's human-mode look (straddle-cli internal/cli/detail_card_render.go): hand-drawn
// boxes, bold labels and headers. Color goes on after the plain width is measured, so a box is the same width with or
// without it. Only a TTY gets these; a pipe gets the plain lines.
import { stripVTControlCharacters } from 'node:util';

export interface Look { width: number; color: boolean }

// The CLI defines no brand color, so the Kit accent is cyan.
const SGR = { bold: '1', dim: '2', accent: '36', heading: '1;36', green: '32', yellow: '33', red: '31' } as const;
export type Style = keyof typeof SGR;

export const paint = (look: Look, style: Style, s: string): string => look.color && s ? `\x1b[${SGR[style]}m${s}\x1b[0m` : s;

// ponytail: counts UTF-16 units, so a wide CJK/emoji glyph throws a row off by a cell; measure East Asian width if
// reports ever carry them.
const cells = (s: string): number => stripVTControlCharacters(s).length;
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - cells(s)));

interface Word { s: string; w: number }

// Inline Markdown as styled words: **bold**, `code`, [text](url). Each word carries its own style, so a line can break
// between any two words. Without color, code keeps its backticks so it still reads as code.
function words(text: string, look: Look): Word[] {
  const out: Word[] = [];
  let cur: Word = { s: '', w: 0 };
  const push = (piece: string, style?: Style) => piece.split(/( +)/).forEach((part, i) => {
    if (i % 2) {
      if (cur.w) out.push(cur);
      cur = { s: '', w: 0 };
    } else if (part) {
      cur.s += style ? paint(look, style, part) : part;
      cur.w += cells(part);
    }
  });
  let last = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    push(text.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], 'bold');
    else if (m[2] !== undefined) push(look.color ? m[2] : `\`${m[2]}\``, 'accent');
    else {
      push(m[3]!);
      if (/^https?:/.test(m[4]!)) push(` (${m[4]})`, 'dim');
    }
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  if (cur.w) out.push(cur);
  return out;
}

// Word-wraps to lines no wider than w cells, hard-breaking (and unstyling) a word longer than w. Always one line.
export function wrap(text: string, w: number, look: Look): string[] {
  w = Math.max(1, w);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (let { s, w: ww } of words(text, look)) {
    if (ww > w) {
      let plain = stripVTControlCharacters(s);
      if (used) lines.push(line);
      while (plain.length > w) {
        lines.push(plain.slice(0, w));
        plain = plain.slice(w);
      }
      [line, used, s, ww] = ['', 0, plain, plain.length];
    }
    if (used && used + 1 + ww > w) {
      lines.push(line);
      [line, used] = ['', 0];
    }
    line += (used ? ' ' : '') + s;
    used += (used ? 1 : 0) + ww;
  }
  lines.push(line);
  return lines;
}

// A titled card, "┌─ Title ───┐": [label, value] rows with a bold label column and the value wrapped beside it; a
// bare string is a full-width paragraph, '' a blank line.
export function card(look: Look, title: string, rows: readonly (string | readonly [string, string])[]): string {
  const outer = Math.max(20, look.width);
  const body = outer - 4;
  const labelW = Math.min(28, Math.max(0, ...rows.map((r) => typeof r === 'string' ? 0 : r[0].length)));
  const valueW = body - labelW - 2;
  const t = title.slice(0, outer - 6);
  const lines = [`┌─ ${paint(look, 'bold', t)} ${'─'.repeat(outer - 5 - t.length)}┐`];
  for (const r of rows) {
    if (typeof r === 'string') {
      for (const l of wrap(r, body, look)) lines.push(`│ ${pad(l, body)} │`);
      continue;
    }
    wrap(r[1], valueW, look).forEach((v, i) => lines.push(`│ ${i ? ' '.repeat(labelW) : paint(look, 'bold', pad(r[0], labelW))}  ${pad(v, valueW)} │`));
  }
  lines.push(`└${'─'.repeat(outer - 2)}┘`);
  return lines.join('\n');
}

// A boxed table no wider than look.width: bold header, each cell wrapped in its column. When the natural layout is too
// wide the widest column gives up a cell at a time, down to 4 cells, as the CLI's layoutColumns does. Rows that wrap
// get a rule between them so they stay apart.
export function table(look: Look, headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const natural = (s: string) => cells(wrap(s, Infinity, look)[0]!);
  const colW = headers.map((h, i) => Math.max(1, natural(h), ...rows.map((r) => natural(r[i] ?? ''))));
  let total = colW.reduce((a, b) => a + b, 0) + 3 * colW.length + 1;
  while (total > look.width) {
    const widest = colW.indexOf(Math.max(...colW));
    if (colW[widest]! <= 4) break;
    colW[widest]!--;
    total--;
  }
  const rule = (l: string, m: string, r: string) => l + colW.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const block = (row: readonly string[], style?: Style) => {
    const wrapped = colW.map((w, i) => wrap(row[i] ?? '', w, look));
    const height = Math.max(...wrapped.map((c) => c.length));
    return Array.from({ length: height }, (_, k) => `│ ${wrapped.map((c, i) => {
      const s = pad(c[k] ?? '', colW[i]!);
      return style ? paint(look, style, s) : s;
    }).join(' │ ')} │`);
  };
  const body = rows.map((r) => block(r));
  const sep = body.some((b) => b.length > 1) ? [rule('├', '┼', '┤')] : [];
  return [rule('┌', '┬', '┐'), ...block(headers, 'bold'), rule('├', '┼', '┤'), ...body.flatMap((b, i) => i ? [...sep, ...b] : b), rule('└', '┴', '┘')].join('\n');
}

// The Markdown the skills' report files use: headings, pipe tables, bullet, numbered and checkbox lists, fenced code,
// paragraphs, and inline bold, code and links. HTML comments are dropped.
export function markdown(look: Look, text: string): string {
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out: string[] = [];
  const blank = () => { if (out.length && out.at(-1) !== '') out.push(''); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]!); i++) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!)) rows.push(lines[i]!.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')));
      }
      i--;
      out.push(table(look, rows[0]!, rows.slice(1)));
    } else if (line.trimStart().startsWith('```')) {
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) out.push(paint(look, 'dim', `  ${lines[i]}`.slice(0, look.width)));
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blank();
      for (const l of wrap(m[2]!, look.width, { ...look, color: false })) out.push(paint(look, m[1]!.length === 1 ? 'heading' : 'bold', l));
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      // A checkbox item shows its box in place of the bullet.
      const marker = m[3] ? (m[3].trim() === '[ ]' ? '☐ ' : '☑ ') : /\d/.test(m[2]!) ? `${m[2]} ` : '• ';
      const indent = m[1]!.length;
      const hang = indent + marker.length;
      wrap(m[4]!, look.width - hang, look).forEach((l, k) => out.push(k ? ' '.repeat(hang) + l : ' '.repeat(indent) + paint(look, 'accent', marker.trimEnd()) + ' ' + l));
    } else if (!line.trim()) {
      blank();
    } else {
      out.push(...wrap(line.trim(), look.width, look));
    }
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}

// ---------- Start splash ----------

const FIGURE = [
  '          *         ',
  '    ✦    /\\    \\ | /',
  '        /  \\  -- ✦ --',
  '       / ✦  \\  / | \\',
  '      /  .   \\   |  ',
  '     /________\\  |  ',
  '      ( o  o )   |  ',
  '      (  __  )   |  ',
  '       \\~~~~/ ___/  ',
  '      /\\~~~~/\\   |  ',
  '     /  \\~~/  \\  |  ',
  '    /____\\/____\\ |  ',
];

const GLYPHS: Record<string, readonly [string, string, string]> = {
  S: ['▄▀▀▀', '▀▀▀▄', '▄▄▄▀'], T: ['▀█▀', ' █ ', ' █ '], R: ['█▀▀▄', '█▄▄▀', '█ ▀▄'], A: ['▄▀▀▄', '█▄▄█', '█  █'],
  D: ['█▀▀▄', '█  █', '█▄▄▀'], L: ['█   ', '█   ', '█▄▄▄'], E: ['█▀▀▀', '█▀▀ ', '█▄▄▄'], W: ['█   █', '█ █ █', '▀▄▀▄▀'],
  I: ['▀█▀', ' █ ', '▄█▄'], Z: ['▀▀▀█', ' ▄▀ ', '█▄▄▄'],
};
const wordmark = (word: string) => [0, 1, 2].map((row) => [...word].map((ch) => GLYPHS[ch]![row]).join('  '));

// The splash: a wizard beside "STRADDLE WIZARD" in block letters, 12 lines, 66 cells. Under 80 columns it's one line.
export function splash(look: Look): string[] {
  if (look.width < 80) return [`${paint(look, 'yellow', '✦')} ${paint(look, 'heading', 'Straddle Wizard')}`];
  const right = ['', '', ...wordmark('STRADDLE'), '', ...wordmark('WIZARD'), '', paint(look, 'dim', 'Straddle, set up by your coding agent')];
  return FIGURE.map((f, i) => (f.padEnd(21).replace(/[✦*.]+|[^\s✦*.]+/g, (run) => paint(look, /[✦*.]/.test(run) ? 'yellow' : 'accent', run)) + '  ' + paint(look, 'heading', right[i] ?? '')).trimEnd());
}
