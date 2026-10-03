// Terminal screens in the Straddle CLI's human-mode look (straddle-cli internal/cli/detail_card_render.go): hand-drawn
// boxes, bold labels and headers. Color goes on after the plain width is measured, so a box is the same width with or
// without it. Only a TTY gets these; a pipe gets the plain lines.
import { stripVTControlCharacters } from 'node:util';

export interface Look { width: number; color: boolean }

// The CLI defines no brand color, so the Kit accent is cyan.
const SGR = { bold: '1', dim: '2', accent: '36', heading: '1;36', green: '32', yellow: '33', red: '31' } as const;
export type Style = keyof typeof SGR;

export const paint = (look: Look, style: Style, s: string): string => look.color && s ? `\x1b[${SGR[style]}m${s}\x1b[0m` : s;

// Text from a repo file, safe to draw: line endings normalized, tabs as spaces, and escape sequences and every other
// control character dropped, so a report can't retitle the terminal, write the clipboard or move the cursor.
export function sanitize(text: string): string {
  return stripVTControlCharacters(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

// East Asian wide and emoji-presentation characters take two cells; combining marks, joiners and variation selectors
// none. The same split go-runewidth makes for the CLI, for the characters reports carry.
const WIDE = /[\u1100-\u115f\u231a\u231b\u23e9-\u23ec\u23f0\u23f3\u25fd\u25fe\u2614\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa\u26ab\u26bd\u26be\u26c4\u26c5\u26ce\u26d4\u26ea\u26f2\u26f3\u26f5\u26fa\u26fd\u2705\u270a\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
const ZERO = /[\p{Mn}\p{Me}\u200b-\u200f\u2060\ufe00-\ufe0f]/u;
const charCells = (ch: string): number => ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;

// The visible width of s in terminal cells, ignoring SGR codes.
export function cells(s: string): number {
  let n = 0;
  for (const ch of stripVTControlCharacters(s)) n += charCells(ch);
  return n;
}

const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - cells(s)));

// Splits plain s after at most w cells, by code point. A first character wider than w goes alone, so it always
// makes progress.
function cut(s: string, w: number): [string, string] {
  let used = 0;
  let i = 0;
  for (const ch of s) {
    const c = charCells(ch);
    if (i && used + c > w) break;
    used += c;
    i += ch.length;
  }
  return [s.slice(0, i), s.slice(i)];
}

// Breaks a plain word wider than w into pieces, after the last punctuation in each piece when that keeps at least
// half of it (paths, IDs and keys split at / - _ . : =), else at w.
function breakWord(word: string, w: number): string[] {
  const pieces: string[] = [];
  while (cells(word) > w) {
    let [head, rest] = cut(word, w);
    const at = /^.*[/\-_.,:;=&?]/s.exec(head)?.[0].length ?? 0;
    if (at >= head.length / 2) [head, rest] = [head.slice(0, at), head.slice(at) + rest];
    pieces.push(head);
    word = rest;
  }
  pieces.push(word);
  return pieces;
}

interface Word { s: string; w: number }

// Inline Markdown as styled words: **bold**, `code`, [text](url). Each word carries its own style, so a line can break
// between any two words. Without color, code keeps its backticks so it still reads as code.
function words(text: string, look: Look): Word[] {
  text = text.replace(/\s/g, ' ');
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

// Word-wraps to lines no wider than w cells, hard-breaking (and unstyling) a word longer than w. Always at least one line.
export function wrap(text: string, w: number, look: Look): string[] {
  w = Math.max(1, w);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (let { s, w: ww } of words(text, look)) {
    if (ww > w) {
      const pieces = breakWord(stripVTControlCharacters(s), w);
      if (used) lines.push(line);
      lines.push(...pieces.slice(0, -1));
      [line, used, s, ww] = ['', 0, pieces.at(-1)!, cells(pieces.at(-1)!)];
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

// A titled card, "┌─ Title ───┐" (a plain top rule without a title): [label, value] rows with a bold label column, both
// wrapped, and a bare string as a full-width paragraph, '' a blank line. The label column takes at most 28 cells and
// 40% of the body, so the value column always has room.
export function card(look: Look, title: string, rows: readonly (string | readonly [string, string])[]): string {
  const outer = Math.max(12, look.width);
  const body = outer - 4;
  const plain = { ...look, color: false };
  const labelW = Math.min(28, Math.floor(body * 0.4), Math.max(0, ...rows.map((r) => typeof r === 'string' ? 0 : cells(r[0]))));
  const valueW = body - labelW - 2;
  const t = cut(title, outer - 6)[0];
  const lines = [t ? `┌─ ${paint(look, 'bold', t)} ${'─'.repeat(outer - 5 - cells(t))}┐` : `┌${'─'.repeat(outer - 2)}┐`];
  for (const r of rows) {
    if (typeof r === 'string') {
      for (const l of wrap(r, body, look)) lines.push(`│ ${pad(l, body)} │`);
      continue;
    }
    const labels = wrap(r[0], labelW, plain);
    const values = wrap(r[1], valueW, look);
    for (let k = 0; k < Math.max(labels.length, values.length); k++) {
      lines.push(`│ ${paint(look, 'bold', pad(labels[k] ?? '', labelW))}  ${pad(values[k] ?? '', valueW)} │`);
    }
  }
  lines.push(`└${'─'.repeat(outer - 2)}┘`);
  return lines.join('\n');
}

// A boxed table no wider than look.width: bold header, each cell wrapped in its column, a rule between rows when any
// wraps. When the natural layout is too wide, a column gives up a cell at a time: first the one with the most room
// above its longest word, so text breaks between words; then the widest, down to 4 cells, as the CLI's layoutColumns
// does. When even that is too wide, each row becomes its own card of column: value lines.
export function table(look: Look, headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const column = (i: number) => [headers[i]!, ...rows.map((r) => r[i] ?? '')];
  const colW = headers.map((_, i) => Math.max(1, ...column(i).map((s) => cells(wrap(s, Infinity, look)[0]!))));
  const longest = headers.map((_, i) => Math.max(1, ...column(i).flatMap((s) => words(s, look).map((w) => w.w))));
  let total = colW.reduce((a, b) => a + b, 0) + 3 * colW.length + 1;
  while (total > look.width) {
    const room = colW.map((w, i) => w - longest[i]!);
    let i = room.indexOf(Math.max(...room));
    if (room[i]! <= 0) {
      i = colW.indexOf(Math.max(...colW));
      if (colW[i]! <= 4) break;
    }
    colW[i]!--;
    total--;
  }
  if (total > look.width) {
    if (!rows.length) return card(look, '', [headers.join(' · ')]);
    return rows.map((r) => card(look, '', headers.map((h, i) => [h, r[i] ?? ''] as const))).join('\n');
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
  return [
    rule('┌', '┬', '┐'), ...block(headers, 'bold'), ...rows.length ? [rule('├', '┼', '┤')] : [],
    ...body.flatMap((b, i) => i ? [...sep, ...b] : b), rule('└', '┴', '┘'),
  ].join('\n');
}

// The Markdown the skills' report files use: headings, pipe tables, bullet, numbered and checkbox lists, fenced code,
// paragraphs, and inline bold, code and links. HTML comments are dropped, and the text is sanitized first.
export function markdown(look: Look, text: string): string {
  const lines = sanitize(text).replace(/<!--[\s\S]*?-->/g, '').split('\n');
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
      if (rows.length) out.push(table(look, rows[0]!, rows.slice(1)));
    } else if (line.trimStart().startsWith('```')) {
      // Code keeps its spacing and is hard-wrapped at the width, never cut; a continuation keeps the block's indent.
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) {
        let rest = `  ${lines[i]}`;
        do {
          const [head, tail] = cut(rest, look.width);
          out.push(paint(look, 'dim', head));
          rest = tail && look.width > 4 ? `  ${tail}` : tail;
        } while (rest);
      }
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blank();
      // The heading's own style replaces inline code's, so in color its backticks go.
      const title = look.color ? m[2]!.replace(/`([^`]+)`/g, '$1') : m[2]!;
      for (const l of wrap(title, look.width, { ...look, color: false })) out.push(paint(look, m[1]!.length === 1 ? 'heading' : 'bold', l));
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      // A checkbox item shows its box in place of the bullet.
      const marker = m[3] ? (m[3].trim() === '[ ]' ? '☐ ' : '☑ ') : /\d/.test(m[2]!) ? `${m[2]} ` : '• ';
      const indent = Math.min(m[1]!.length, 8);
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
const wordmark = (look: Look, word: string) => [0, 1, 2].map((row) => paint(look, 'heading', [...word].map((ch) => GLYPHS[ch]![row]).join('  ').trimEnd()));

// The splash: a wizard beside "STRADDLE WIZARD" in block letters, 12 lines, 68 cells. Under 80 columns it's one line.
export function splash(look: Look): string[] {
  if (look.width < 80) return [`${paint(look, 'yellow', '✦')} ${paint(look, 'heading', 'Straddle Wizard')}`];
  const right = ['', '', ...wordmark(look, 'STRADDLE'), '', ...wordmark(look, 'WIZARD'), '', paint(look, 'dim', 'Straddle, set up by your coding agent')];
  return FIGURE.map((f, i) => (f.padEnd(21).replace(/[✦*.]+|[^\s✦*.]+/g, (run) => paint(look, /[✦*.]/.test(run) ? 'yellow' : 'accent', run)) + '  ' + (right[i] ?? '')).trimEnd());
}
