import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { field, parseJson } from './json.ts';

// No published plugin release exists yet (ME-810 cuts it after the Wizard). Until then the Wizard only
// accepts the merged skills source at this exact commit, and says so everywhere it shows the bundle.
export const PINNED_BUNDLE = {
  repository: 'straddle-build/skills',
  commit: 'f713fc6201ad0fd800d23a3ec4c4102b7acee91c',
  pluginVersion: '0.1.0',
} as const;

export interface SkillInfo { version: string; description: string }

export interface Bundle {
  kind: 'merged-source-development';
  path: string;
  repository: string;
  commit: string;
  pluginVersion: string;
  skills: Record<string, SkillInfo>;
}

export type BundleCheck = { ok: true; bundle: Bundle } | { ok: false; reason: string };

function git(path: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Reads the frontmatter subset the skills use: top-level scalars and one nested `metadata.version`.
function frontmatter(text: string): { name?: string; description?: string; version?: string } {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const scalar = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim();
  return { name: scalar('name'), description: scalar('description'), version: /^\s+version:\s*(\S+)/m.exec(block)?.[1] };
}

export function loadBundle(path: string | undefined): BundleCheck {
  if (!path) {
    return { ok: false, reason: `No published Straddle plugin release exists yet. Point the Wizard at a ${PINNED_BUNDLE.repository} checkout at ${PINNED_BUNDLE.commit.slice(0, 7)} with --bundle <path> or STRADDLE_WIZARD_BUNDLE.` };
  }
  const root = resolve(path);
  if (!existsSync(join(root, 'plugin.json'))) return { ok: false, reason: `${root} is not a Straddle skills checkout (no plugin.json).` };

  const head = git(root, ['rev-parse', 'HEAD']);
  if (head !== PINNED_BUNDLE.commit) {
    return { ok: false, reason: `${root} is ${head ? head.slice(0, 7) : 'not a git checkout'}, not the pinned commit ${PINNED_BUNDLE.commit.slice(0, 7)}.` };
  }
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty !== '') return { ok: false, reason: `${root} has local changes to tracked files; the pinned bundle must be unmodified.` };

  const pluginVersion = field(parseJson(readFileSync(join(root, 'plugin.json'), 'utf8')), 'version');
  if (pluginVersion !== PINNED_BUNDLE.pluginVersion) return { ok: false, reason: `plugin.json version ${String(pluginVersion)} is not ${PINNED_BUNDLE.pluginVersion}.` };

  const skills: Record<string, SkillInfo> = {};
  for (const dir of readdirSync(join(root, 'skills')).sort()) {
    const file = join(root, 'skills', dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, 'utf8'));
    if (fm.name !== dir || !fm.version) return { ok: false, reason: `skills/${dir}/SKILL.md has no matching name and metadata.version.` };
    skills[dir] = { version: fm.version, description: fm.description ?? '' };
  }
  return { ok: true, bundle: { kind: 'merged-source-development', path: root, repository: PINNED_BUNDLE.repository, commit: head, pluginVersion, skills } };
}

export function bundleLabel(bundle: Bundle): string {
  return `merged-source development bundle ${bundle.repository}@${bundle.commit.slice(0, 7)} (plugin ${bundle.pluginVersion}, ${Object.keys(bundle.skills).length} skills, unpublished)`;
}
