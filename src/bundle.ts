import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { field, parseJson, text } from './json.ts';
import { WIZARD_VERSION } from './version.ts';

// The plugin releases this Wizard runs: GitHub releases of straddle-build/skills tagged v<plugin version>, each with
// the assets straddle-plugin-<version>.zip and SHA256SUMS from the skills repository's scripts/kit-release. Any 0.1.x
// release works, so a skills fix ships as a plugin release without a new Wizard; 0.2.0 needs a Wizard that accepts it.
export const PLUGIN_RELEASES = {
  repository: 'straddle-build/skills',
  url: 'https://api.github.com/repos/straddle-build/skills/releases?per_page=100',
  range: '0.1.x',
} as const;

// What the clients load. Everything else in the repository (evals, tests, scripts) is not part of the plugin.
export const RUNTIME_PATHS = ['plugin.json', 'mcp.json', '.claude-plugin', '.codex-plugin', '.cursor-plugin', 'assets', 'skills', 'references', 'third_party', 'LICENSE', 'README.md'];
// A skills checkout's other top-level entries, the kit release manifest directory (kit/, metadata no client loads),
// Claude Code's own bookkeeping in its installed cache copy (.in_use/ session pid files, .orphaned_at), plus Git
// metadata. Any other top-level entry (hooks/, commands/, agents/, .mcp.json, settings.json, ...) could be
// discovered and run by a client, so a bundle holding one is rejected rather than trusted.
const INERT_PATHS: Record<string, true> = {
  '.git': true, '.github': true, '.gitignore': true, '.markdownlint-cli2.jsonc': true, docs: true, evals: true, fixtures: true, kit: true, scripts: true, tests: true,
  '.in_use': true, '.orphaned_at': true,
};

export interface SkillInfo { version: string; description: string }

// `release`: a plugin release this Wizard downloaded and verified. `local`: a directory the developer passed with --bundle.
export interface Bundle {
  kind: 'release' | 'local';
  path: string;
  pluginVersion: string;
  contentSha256: string;
  skills: Record<string, SkillInfo>;
}

export type BundleCheck = { ok: true; bundle: Bundle } | { ok: false; reason: string };

// `notes`: the release's description on GitHub, its changelog.
export interface Release { tag: string; version: string; page: string; archiveUrl: string; sumsUrl: string; notes: string }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function inRange(version: string): boolean {
  const [major, minor] = PLUGIN_RELEASES.range.split('.');
  const parts = SEMVER.exec(version);
  return parts !== null && parts[1] === major && parts[2] === minor;
}

function newestFirst(a: { version: string }, b: { version: string }): number {
  const [x, y] = [a.version, b.version].map((v) => v.split('.').map(Number)) as [number[], number[]];
  return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!);
}

// Reads the frontmatter subset the skills use: top-level scalars and one nested `metadata.version`.
function frontmatter(text: string): { name?: string; description?: string; version?: string } {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const scalar = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim();
  return { name: scalar('name'), description: scalar('description'), version: /^\s+version:\s*(\S+)/m.exec(block)?.[1] };
}

// The sha256 of every regular file under the top-level entries `tops` of root, by path; a symlink or anything but
// regular files and directories maps to SPECIAL.
const SPECIAL = 'special';
function fileDigests(root: string, tops: readonly string[]): Record<string, string> {
  const digests: Record<string, string> = {};
  const visit = (rel: string): void => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    const info = lstatSync(abs);
    if (info.isFile()) digests[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
    else if (info.isDirectory()) for (const name of readdirSync(abs)) visit(`${rel}/${name}`);
    else digests[rel] = SPECIAL;
  };
  for (const top of tops) visit(top);
  return digests;
}

// sha256 of the `<sha256>  <path>` listing (sorted by path) of RUNTIME_PATHS: the digest kit-release records as
// plugin.content_sha256. Null when a runtime path holds a symlink or anything but regular files and directories.
function contentSha256(root: string): string | null {
  const digests = Object.entries(fileDigests(root, RUNTIME_PATHS));
  if (digests.some(([, sha]) => sha === SPECIAL)) return null;
  const lines = digests.sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, sha]) => `${sha}  ${path}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

// What a client would load from root, or why it is not a Straddle plugin this Wizard runs.
function readPlugin(root: string, kind: Bundle['kind']): BundleCheck {
  if (!existsSync(join(root, 'plugin.json'))) return { ok: false, reason: `${root} is not a Straddle skills bundle (no plugin.json).` };
  const unexpected = readdirSync(root).filter((name) => !RUNTIME_PATHS.includes(name) && !Object.hasOwn(INERT_PATHS, name)).sort();
  if (unexpected.length) return { ok: false, reason: `${root} has files outside the Straddle plugin that a client could load: ${unexpected.join(', ')}.` };
  const digest = contentSha256(root);
  if (digest === null) return { ok: false, reason: `${root} has a symlink or special file among the plugin files.` };
  const pluginVersion = text(field(parseJson(readFileSync(join(root, 'plugin.json'), 'utf8')), 'version')) ?? 'unknown';
  if (!inRange(pluginVersion)) return { ok: false, reason: `${root} is plugin ${pluginVersion}; this Wizard runs plugin ${PLUGIN_RELEASES.range} only.` };
  const skills: Record<string, SkillInfo> = {};
  for (const dir of existsSync(join(root, 'skills')) ? readdirSync(join(root, 'skills')).sort() : []) {
    const file = join(root, 'skills', dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, 'utf8'));
    skills[dir] = { version: fm.version ?? 'unknown', description: fm.description ?? '' };
  }
  return { ok: true, bundle: { kind, path: root, pluginVersion, contentSha256: digest, skills } };
}

// A directory the developer chose with --bundle, for local testing. Checked for shape and range, not against a release.
export function loadLocalBundle(path: string): BundleCheck {
  return readPlugin(resolve(path), 'local');
}

// True when path holds exactly the bundle's plugin: nothing else a client could load, and the same content.
export function matchesBundle(path: string, bundle: Bundle): boolean {
  const check = readPlugin(resolve(path), bundle.kind);
  return check.ok && check.bundle.contentSha256 === bundle.contentSha256;
}

export function bundleLabel(bundle: Bundle): string {
  const skills = `${Object.keys(bundle.skills).length} skills`;
  return bundle.kind === 'release'
    ? `plugin release v${bundle.pluginVersion} of ${PLUGIN_RELEASES.repository} (${skills}, verified against its published SHA256SUMS)`
    : `local bundle ${bundle.path} (plugin ${bundle.pluginVersion}, ${skills}, not a release)`;
}

// ---------- Releases ----------

// One cached release at a stable path, so a client marketplace registered from it survives plugin updates.
export function releaseDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'straddle-wizard', 'plugin');
}

const recordPath = (env: NodeJS.ProcessEnv) => join(dirname(releaseDir(env)), 'release.json');
const readRecord = (env: NodeJS.ProcessEnv) => parseJson(existsSync(recordPath(env)) ? readFileSync(recordPath(env), 'utf8') : '');

// The plugin version of the release the Wizard last downloaded, whether or not its copy is still intact.
export function cachedVersion(env: NodeJS.ProcessEnv): string | null {
  return existsSync(releaseDir(env)) ? text(field(readRecord(env), 'version')) ?? null : null;
}

// Where the Wizard keeps an edited copy of a release when it installs a clean one in its place.
export function editedDir(env: NodeJS.ProcessEnv): string {
  return join(dirname(releaseDir(env)), 'edited');
}

// The cached release when it no longer matches the release the Wizard verified: edited by hand, or damaged.
// `changed`: each file that differs from the release, or null when the record predates per-file digests.
export interface EditedCopy { path: string; version: string | null; changed: string[] | null }

export function editedCopy(env: NodeJS.ProcessEnv): EditedCopy | null {
  const dir = releaseDir(env);
  if (!existsSync(dir)) return null;
  const record = readRecord(env);
  const version = text(field(record, 'version')) ?? null;
  const check = readPlugin(dir, 'release');
  if (version && check.ok && check.bundle.pluginVersion === version && check.bundle.contentSha256 === text(field(record, 'contentSha256'))) return null;
  const files = field(record, 'files');
  if (!files || typeof files !== 'object') return { path: dir, version, changed: null };
  const recorded = files as Record<string, unknown>;
  const now = fileDigests(dir, readdirSync(dir).filter((name) => !Object.hasOwn(INERT_PATHS, name)));
  const changed = [...new Set([...Object.keys(recorded), ...Object.keys(now)])].sort().flatMap((path) => {
    if (!Object.hasOwn(now, path)) return [`${path} (removed)`];
    if (!Object.hasOwn(recorded, path)) return [`${path} (added)`];
    return recorded[path] === now[path] ? [] : [`${path} (changed)`];
  });
  return { path: dir, version, changed };
}

// An edited copy moved aside so a clean release can take its place: nothing the developer changed is deleted.
export interface KeptEdits extends EditedCopy { backup: string }

function setAside(edited: EditedCopy, env: NodeJS.ProcessEnv): KeptEdits {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(editedDir(env), `plugin-${edited.version ? `v${edited.version}` : 'unknown'}-${stamp}`);
  mkdirSync(editedDir(env), { recursive: true });
  renameSync(edited.path, backup);
  return { ...edited, backup };
}

// The release this Wizard downloaded and verified earlier, re-hashed against the content digest it recorded then.
// Never fetches.
export function loadCachedRelease(env: NodeJS.ProcessEnv): BundleCheck {
  const dir = releaseDir(env);
  const record = readRecord(env);
  const version = text(field(record, 'version'));
  if (!version || !existsSync(dir)) {
    return { ok: false, reason: `No Straddle plugin release is on this machine yet. \`wizard\` or \`wizard install\` downloads the newest ${PLUGIN_RELEASES.range} release.` };
  }
  const check = readPlugin(dir, 'release');
  if (!check.ok) return check;
  if (check.bundle.pluginVersion !== version || check.bundle.contentSha256 !== text(field(record, 'contentSha256'))) {
    return { ok: false, reason: `${dir} no longer matches plugin release v${version} as the Wizard verified it. \`wizard\` or \`wizard install\` downloads it again.` };
  }
  return check;
}

async function get(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'user-agent': `straddle-wizard/${WIZARD_VERSION}` }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Throws when the list cannot be read, so the caller can fall back to the release already on this machine.
// STRADDLE_WIZARD_RELEASES points at another URL serving the same JSON as the GitHub releases API (mirrors, tests).
export async function listReleases(env: NodeJS.ProcessEnv): Promise<unknown> {
  const url = env.STRADDLE_WIZARD_RELEASES || PLUGIN_RELEASES.url;
  const list = parseJson((await get(url)).toString('utf8'));
  if (!Array.isArray(list)) throw new Error(`${url} did not return a list of releases`);
  return list;
}

// Every published vX.Y.Z release, newest first. Drafts and prereleases never count.
function publishedReleases(list: unknown): Release[] {
  return (Array.isArray(list) ? list : []).flatMap((entry): Release[] => {
    const tag = text(field(entry, 'tag_name')) ?? '';
    const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
    if (!version || field(entry, 'draft') === true || field(entry, 'prerelease') === true) return [];
    const assets = field(entry, 'assets');
    const asset = (name: string) => text(field((Array.isArray(assets) ? assets : []).find((a) => field(a, 'name') === name), 'browser_download_url')) ?? '';
    return [{ tag, version, page: text(field(entry, 'html_url')) ?? tag, archiveUrl: asset(`straddle-plugin-${version}.zip`), sumsUrl: asset('SHA256SUMS'), notes: text(field(entry, 'body')) ?? '' }];
  }).sort(newestFirst);
}

// The newest published release in range, or why there is none.
export function pickRelease(list: unknown): Release | string {
  const releases = publishedReleases(list);
  const newest = releases.find((r) => inRange(r.version));
  if (!newest) {
    return releases[0]
      ? `The newest Straddle plugin release, ${releases[0].tag}, is outside this Wizard's ${PLUGIN_RELEASES.range} range. Update the Wizard, or pass --bundle <dir>.`
      : `No Straddle plugin release is published yet. Pass --bundle <dir> to use a local skills checkout.`;
  }
  if (!newest.archiveUrl || !newest.sumsUrl) return `Plugin release ${newest.tag} has no straddle-plugin-${newest.version}.zip and SHA256SUMS assets, so the Wizard cannot verify it.`;
  return newest;
}

// A published release newer than every one in range: it needs a newer Wizard.
export function newerOutsideRange(list: unknown): Release | null {
  const releases = publishedReleases(list);
  const newest = releases.find((r) => inRange(r.version));
  return releases[0] && !inRange(releases[0].version) && (!newest || newestFirst(releases[0], newest) < 0) ? releases[0] : null;
}

// The releases after version `from` up to and including `to`, newest first.
export function releasesSince(list: unknown, from: string, to: Release): Release[] {
  return publishedReleases(list).filter((r) => newestFirst(r, { version: from }) < 0 && newestFirst(r, to) >= 0);
}

// A changelog line kit-release writes into every release, which says nothing about what changed.
const BUILD_STAMP = /^(Built by scripts\/kit-release\b|Verify straddle-plugin-)/;

// What a release's notes say changed, without kit-release's build stamp.
export function releaseNotes(release: Release): string[] {
  return release.notes.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() && !BUILD_STAMP.test(line.trim()));
}

// Commits about tests, evals, release bookkeeping, CI and docs change nothing a developer's agent loads.
const INTERNAL_COMMIT = /^(merge\b|(tests?|evals?|kit|ci|chore|build|docs?|style|refactor|release|no-mistakes)(\([^)]*\))?!?:)/i;

// A commit subject without the internal ticket and pull request references developers can't open.
export function tidySubject(subject: string): string {
  return subject
    .replace(/^([a-z]+)\((?:[a-z]+-\d+[,\s]*)+\)(!?):/i, '$1$2:')
    .replace(/^[A-Z]+-\d+(?:\/\d+)*:\s*/, '')
    .replace(/\s*\((?:#\d+|[A-Z]+-\d+(?:,\s*[A-Z]+-\d+)*)\)/g, '')
    .trim();
}

export const compareUrl = (from: string, to: string) => `https://github.com/${PLUGIN_RELEASES.repository}/compare/${from}...${to}`;

// The subjects of the commits between two release tags that change the plugin for developers, oldest first.
// Reads the GitHub compare API beside the releases list (STRADDLE_WIZARD_RELEASES included). Throws when it can't.
export async function releaseCommits(env: NodeJS.ProcessEnv, from: string, to: string): Promise<string[]> {
  const base = (env.STRADDLE_WIZARD_RELEASES || PLUGIN_RELEASES.url).replace(/\/releases(\?.*)?$/, '');
  const commits = field(parseJson((await get(`${base}/compare/${from}...${to}`)).toString('utf8')), 'commits');
  if (!Array.isArray(commits)) throw new Error(`${base}/compare/${from}...${to} did not return a list of commits`);
  return commits.flatMap((commit) => {
    const parents = field(commit, 'parents');
    const subject = (text(field(field(commit, 'commit'), 'message')) ?? '').split('\n')[0]!.trim();
    return (Array.isArray(parents) && parents.length > 1) || !subject || INTERNAL_COMMIT.test(subject) ? [] : [tidySubject(subject)];
  });
}

// The plugin archive kit-release builds: a zip of stored (uncompressed) regular files. Returns why it cannot be
// unpacked, or null once every entry is written under dest.
function unzipStored(zip: Buffer, dest: string): string | null {
  try {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return 'not a zip archive';
    let at = zip.readUInt32LE(end + 16);
    for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
      if (zip.readUInt32LE(at) !== 0x02014b50) return 'corrupt zip directory';
      const method = zip.readUInt16LE(at + 10);
      const size = zip.readUInt32LE(at + 20);
      const nameLength = zip.readUInt16LE(at + 28);
      const mode = zip.readUInt32LE(at + 38) >>> 16;
      const local = zip.readUInt32LE(at + 42);
      const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
      if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => ['', '.', '..'].includes(part))) return `${name}: unsafe path`;
      if (method !== 0 || (mode & 0o170000) !== 0o100000) return `${name}: not a stored regular file`;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + size > zip.length) return `${name}: truncated`;
      mkdirSync(dirname(join(dest, name)), { recursive: true });
      writeFileSync(join(dest, name), zip.subarray(start, start + size), { mode: mode & 0o755 });
    }
    return null;
  } catch (error) {
    return `corrupt zip archive (${error instanceof Error ? error.message : String(error)})`;
  }
}

// Verifies a release archive against the release's SHA256SUMS and this Wizard's range, then unpacks it into dest,
// which must not exist yet. kit-release check --wizard-tarball runs this on a plugin release before it is published.
export function unpackRelease(release: { version: string; archive: Uint8Array; sums: string }, dest: string): BundleCheck {
  const name = `straddle-plugin-${release.version}.zip`;
  if (!inRange(release.version)) return { ok: false, reason: `Plugin release ${release.version} is outside this Wizard's ${PLUGIN_RELEASES.range} range.` };
  const listed = release.sums.split('\n').map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())).find((m) => m?.[2] === name)?.[1];
  const actual = createHash('sha256').update(release.archive).digest('hex');
  if (listed !== actual) return { ok: false, reason: `${name} (sha256 ${actual}) does not match the release's SHA256SUMS (${listed ?? 'not listed'}); the Wizard refuses it.` };
  if (existsSync(dest)) return { ok: false, reason: `${dest} already exists.` };
  const problem = unzipStored(Buffer.from(release.archive), dest);
  if (problem) return { ok: false, reason: `${name}: ${problem}` };
  const check = readPlugin(dest, 'release');
  if (check.ok && check.bundle.pluginVersion !== release.version) return { ok: false, reason: `${name} holds plugin ${check.bundle.pluginVersion}, not ${release.version}.` };
  return check;
}

// `keptEdits`: where the cached release went when it had been edited, so the clean release could take its place.
export type Downloaded = BundleCheck & { keptEdits: KeptEdits | null };

// Downloads a release and its SHA256SUMS, verifies them, and only then replaces the cached release. A cached copy that
// no longer matches what the Wizard verified is moved into editedDir, never deleted.
export async function downloadRelease(release: Release, env: NodeJS.ProcessEnv): Promise<Downloaded> {
  let archive: Buffer;
  let sums: string;
  try {
    [archive, sums] = await Promise.all([get(release.archiveUrl), get(release.sumsUrl).then((b) => b.toString('utf8'))]);
  } catch (error) {
    return { ok: false, reason: `Downloading plugin release ${release.tag} failed: ${error instanceof Error ? error.message : String(error)}`, keptEdits: null };
  }
  const dir = releaseDir(env);
  const staging = `${dir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  const check = unpackRelease({ version: release.version, archive, sums }, staging);
  if (!check.ok) { rmSync(staging, { recursive: true, force: true }); return { ...check, keptEdits: null }; }
  const edited = editedCopy(env);
  const keptEdits = edited ? setAside(edited, env) : null;
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const files = fileDigests(dir, RUNTIME_PATHS);
  writeFileSync(recordPath(env), `${JSON.stringify({ version: release.version, release: release.page, archiveSha256, contentSha256: check.bundle.contentSha256, files }, null, 2)}\n`);
  return { ...loadCachedRelease(env), keptEdits };
}
