import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from './clients.ts';
import { field, parseJson } from './json.ts';

// No tagged plugin release exists yet (ME-810 cuts it after the Wizard). Until then the Wizard uses the merged
// skills source at this exact commit, verified by content, and says so everywhere it shows the bundle.
export const PINNED_BUNDLE = {
  repository: 'straddle-build/skills',
  url: 'https://github.com/straddle-build/skills.git',
  commit: 'f713fc6201ad0fd800d23a3ec4c4102b7acee91c',
  pluginVersion: '0.1.0',
  // sha256 of the `<sha256>  <path>` listing (sorted by path) of RUNTIME_PATHS at the commit; the same digest the
  // ME-810 kit manifest records as plugin.content_sha256.
  contentSha256: 'e9a5db1d995e5798681e04d9d7f840000b6e0861f3e4b76ae3a31b881ad00b7c',
} as const;

// What the clients load. Everything else in the repository (evals, tests, scripts) is not part of the plugin.
const RUNTIME_PATHS = ['plugin.json', 'mcp.json', '.claude-plugin', '.codex-plugin', '.cursor-plugin', 'assets', 'skills', 'references', 'third_party', 'LICENSE', 'README.md'];

export interface SkillInfo { version: string; description: string }

export interface Bundle {
  kind: 'merged-source-snapshot';
  path: string;
  repository: string;
  commit: string;
  pluginVersion: string;
  skills: Record<string, SkillInfo>;
}

export type BundleCheck = { ok: true; bundle: Bundle } | { ok: false; reason: string };

// Reads the frontmatter subset the skills use: top-level scalars and one nested `metadata.version`.
function frontmatter(text: string): { name?: string; description?: string; version?: string } {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const scalar = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim();
  return { name: scalar('name'), description: scalar('description'), version: /^\s+version:\s*(\S+)/m.exec(block)?.[1] };
}

// Null when a runtime path holds a symlink or anything but regular files and directories.
function contentSha256(root: string): string | null {
  const lines: string[] = [];
  const visit = (rel: string): boolean => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return true;
    const info = lstatSync(abs);
    if (info.isFile()) { lines.push(`${createHash('sha256').update(readFileSync(abs)).digest('hex')}  ${rel}`); return true; }
    if (!info.isDirectory()) return false;
    return readdirSync(abs).every((name) => visit(`${rel}/${name}`));
  };
  if (!RUNTIME_PATHS.every(visit)) return null;
  lines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  return createHash('sha256').update(lines.map((l) => `${l}\n`).join('')).digest('hex');
}

export function loadBundle(path: string): BundleCheck {
  const root = resolve(path);
  if (!existsSync(join(root, 'plugin.json'))) return { ok: false, reason: `${root} is not a Straddle skills bundle (no plugin.json).` };
  if (contentSha256(root) !== PINNED_BUNDLE.contentSha256) {
    return { ok: false, reason: `${root} does not match the pinned ${PINNED_BUNDLE.repository}@${PINNED_BUNDLE.commit.slice(0, 7)} snapshot.` };
  }
  const pluginVersion = String(field(parseJson(readFileSync(join(root, 'plugin.json'), 'utf8')), 'version'));
  const skills: Record<string, SkillInfo> = {};
  for (const dir of readdirSync(join(root, 'skills')).sort()) {
    const file = join(root, 'skills', dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, 'utf8'));
    skills[dir] = { version: fm.version ?? 'unknown', description: fm.description ?? '' };
  }
  return { ok: true, bundle: { kind: 'merged-source-snapshot', path: root, repository: PINNED_BUNDLE.repository, commit: PINNED_BUNDLE.commit, pluginVersion, skills } };
}

export function bundleLabel(bundle: Bundle): string {
  return `merged-source snapshot ${bundle.repository}@${bundle.commit.slice(0, 7)} (plugin ${bundle.pluginVersion}, ${Object.keys(bundle.skills).length} skills, not a tagged release)`;
}

// The Wizard-owned copy of the pinned snapshot.
export function snapshotDir(env: NodeJS.ProcessEnv): string {
  const cacheRoot = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  return join(cacheRoot, 'straddle-wizard', `skills-${PINNED_BUNDLE.commit}`);
}

// Fetches exactly the pinned commit with Git into a staging directory; the caller verifies it, then moves it in place.
export function fetchCommands(staging: string): Command[] {
  return [
    { bin: 'git', args: ['init', '-q', staging] },
    { bin: 'git', args: ['-C', staging, 'fetch', '--depth', '1', PINNED_BUNDLE.url, PINNED_BUNDLE.commit] },
    { bin: 'git', args: ['-C', staging, 'checkout', '-q', '--detach', 'FETCH_HEAD'] },
  ];
}
