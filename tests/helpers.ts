import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { RUNTIME_PATHS } from '../src/bundle.ts';
import type { Receipt } from '../src/receipt.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'src', 'cli.ts');

// A straddle-build/skills checkout: the local --bundle most tests use, and the content of the fixture plugin releases.
export const SKILLS_SOURCE = process.env.STRADDLE_SKILLS_SOURCE ?? join(ROOT, '.straddle-skills');
if (!existsSync(join(SKILLS_SOURCE, 'plugin.json'))) {
  throw new Error('Set STRADDLE_SKILLS_SOURCE to a straddle-build/skills checkout with plugin 0.1.x');
}

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `wizard-${label}-`));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// A Next.js app with no payment provider, so the integration program has no Migrate step.
export function nextRepo(): string {
  const repo = tempDir('repo');
  writeFiles(repo, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '15.0.0', react: '19.0.0' }, devDependencies: { typescript: '5.6.0' } }),
    'tsconfig.json': '{}',
    'src/app/page.tsx': 'export default function Page() { return null }\n',
  });
  return repo;
}

export interface FakeClaude {
  bin: string;
  state: string;
  setState(patch: Record<string, unknown>): void;
  sessions(scripts: Record<string, unknown>): void;
  calls(): string[];
  // Every status line the session rendered, in order.
  statusLines(): string[];
}

export function fakeClaude(): FakeClaude {
  const bin = tempDir('bin');
  const state = tempDir('claude-state');
  symlinkSync(join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs'), join(bin, 'claude'));
  writeFileSync(join(state, 'sessions.json'), '{}');
  const lines = (name: string) => {
    const path = join(state, name);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
  };
  return {
    bin,
    state,
    setState(patch) {
      const path = join(state, 'state.json');
      const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { loggedIn: true, marketplace: null, installed: false, mcp: {} };
      writeFileSync(path, JSON.stringify({ ...current, ...patch }));
    },
    sessions(scripts) {
      writeFileSync(join(state, 'sessions.json'), JSON.stringify(scripts));
    },
    calls: () => lines('calls.log'),
    statusLines: () => lines('statusline.log'),
  };
}

// The chat id a fake cursor-agent session writes its transcript under.
export const CURSOR_CHAT = 'c0ffee00-1111-2222-3333-444455556666';

// Fake claude, codex and cursor-agent that record every call. `cursor-agent status` prints `status`; a cursor-agent
// started with --workspace writes its chat transcript where Cursor does.
export function fakeClients(status: string): { env: { HOME: string; PATH: string }; calls: () => string[] } {
  const dir = tempDir('fake-clients');
  const log = join(dir, 'calls.log');
  const chat = `if [ "$1" = --workspace ]; then d="$HOME/.cursor/projects/$(cd "$2" && pwd -P | tr '/.' '--' | sed 's/^-*//')/agent-transcripts/${CURSOR_CHAT}"; mkdir -p "$d"; echo '{}' >> "$d/${CURSOR_CHAT}.jsonl"; fi\n`;
  for (const [bin, version] of [['claude', '2.1.283 (Claude Code)'], ['codex', 'codex-cli 0.130.0'], ['cursor-agent', '2026.09.28-64d2043']]) {
    writeFileSync(join(dir, bin), `#!/bin/sh\necho "${bin} $*" >> '${log}'\ncase "$1" in --version) echo '${version}';; status) echo '${status}';; esac\n${bin === 'cursor-agent' ? chat : ''}`);
    chmodSync(join(dir, bin), 0o755);
  }
  const home = join(dir, 'home');
  mkdirSync(home);
  return { env: { HOME: home, PATH: [dir, '/usr/bin', '/bin'].join(':') }, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

// The program's journeys as they run without the payment review: the skills source minus straddle-payment-review,
// so they test the same flow whatever skills release the source is. Review journeys pass
// STRADDLE_WIZARD_BUNDLE: SKILLS_SOURCE, which must carry the review.
export const BUNDLE_WITHOUT_REVIEW = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-bundle-no-review-'));
  cpSync(SKILLS_SOURCE, dir, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') });
  rmSync(join(dir, 'skills', 'straddle-payment-review'), { recursive: true, force: true });
  return realpathSync(dir);
})();

// `cli`: the Wizard to run, by default this checkout's.
export function runWizard(args: string[], opts: { cwd: string; input?: string[]; env?: Record<string, string>; claude?: FakeClaude; cli?: string }): Promise<RunResult> {
  const path = [opts.claude?.bin, dirname(process.execPath), '/usr/bin', '/bin'].filter(Boolean).join(':');
  const env: Record<string, string> = {
    PATH: path,
    HOME: opts.cwd,
    NO_COLOR: '1',
    STRADDLE_WIZARD_BUNDLE: BUNDLE_WITHOUT_REVIEW,
    // Nothing listens here, so a test that forgets its fixture release server never reaches GitHub.
    STRADDLE_WIZARD_RELEASES: 'http://127.0.0.1:9/releases',
    ...(opts.claude ? { FAKE_CLAUDE_STATE: opts.claude.state } : {}),
    ...opts.env,
  };
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const child = spawn(process.execPath, [opts.cli ?? CLI, ...args], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(opts.input ? opts.input.join('\n') + '\n' : '');
  return promise;
}

export function readReceipt(repo: string): Receipt {
  return JSON.parse(readFileSync(join(repo, '.straddle-wizard', 'receipt.json'), 'utf8')) as Receipt;
}

// A zip in kit-release's plugin archive layout: stored entries with Unix file modes, in the order given.
export function storedZip(entries: Array<{ name: string; data: Buffer; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode = 0o100644 } of entries) {
    const path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    parts.push(local, path, data);
    directory.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((n, b) => n + b.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

// The plugin files of SKILLS_SOURCE as a release archive whose plugin.json says `version`.
export function pluginZip(version: string): Buffer {
  const entries: Array<{ name: string; data: Buffer }> = [];
  const visit = (rel: string): void => {
    const abs = join(SKILLS_SOURCE, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) { for (const name of readdirSync(abs).sort()) visit(`${rel}/${name}`); return; }
    const data = readFileSync(abs);
    entries.push({ name: rel, data: rel === 'plugin.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(data.toString('utf8')), version })) : data });
  };
  for (const path of [...RUNTIME_PATHS].sort()) visit(path);
  return storedZip(entries);
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export interface FixtureRelease { tag: string; zip?: Buffer; sums?: string; prerelease?: boolean }
export interface ReleaseServer { url: string; requests: string[]; close(): Promise<void> }

// Serves plugin releases the way the GitHub releases API and its asset downloads do, for STRADDLE_WIZARD_RELEASES.
export async function releaseServer(releases: FixtureRelease[]): Promise<ReleaseServer> {
  const files = new Map<string, Buffer>();
  const requests: string[] = [];
  let list = '';
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const body = req.url === '/releases' ? Buffer.from(list) : files.get(req.url ?? '');
    res.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  list = JSON.stringify(releases.map((release) => {
    const version = release.tag.slice(1);
    const archive = `straddle-plugin-${version}.zip`;
    const zip = release.zip ?? pluginZip(version);
    files.set(`/${release.tag}/${archive}`, zip);
    files.set(`/${release.tag}/SHA256SUMS`, Buffer.from(release.sums ?? `${sha256(zip)}  ${archive}\n`));
    return {
      tag_name: release.tag, draft: false, prerelease: release.prerelease ?? false, html_url: `${base}/${release.tag}`,
      assets: [archive, 'SHA256SUMS'].map((name) => ({ name, browser_download_url: `${base}/${release.tag}/${name}` })),
    };
  }));
  return { url: `${base}/releases`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
