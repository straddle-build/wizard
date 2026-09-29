import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Receipt } from '../src/receipt.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'src', 'cli.ts');

// The merged skills source at the pinned commit. Tests verify the real bundle, never a copy.
export const SKILLS_SOURCE = process.env.STRADDLE_SKILLS_SOURCE ?? join(ROOT, '.straddle-skills');
if (!existsSync(join(SKILLS_SOURCE, 'plugin.json'))) {
  throw new Error('Set STRADDLE_SKILLS_SOURCE to a straddle-build/skills checkout at the pinned commit');
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

export function nextRepo(): string {
  const repo = tempDir('repo');
  writeFiles(repo, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '15.0.0', react: '19.0.0', stripe: '17.0.0' }, devDependencies: { typescript: '5.6.0' } }),
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
}

export function fakeClaude(): FakeClaude {
  const bin = tempDir('bin');
  const state = tempDir('claude-state');
  symlinkSync(join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs'), join(bin, 'claude'));
  writeFileSync(join(state, 'sessions.json'), '{}');
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
    calls() {
      const path = join(state, 'calls.log');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
    },
  };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

export function runWizard(args: string[], opts: { cwd: string; input?: string[]; env?: Record<string, string>; claude?: FakeClaude }): Promise<RunResult> {
  const path = [opts.claude?.bin, dirname(process.execPath), '/usr/bin', '/bin'].filter(Boolean).join(':');
  const env: Record<string, string> = {
    PATH: path,
    HOME: opts.cwd,
    NO_COLOR: '1',
    STRADDLE_WIZARD_BUNDLE: SKILLS_SOURCE,
    ...(opts.claude ? { FAKE_CLAUDE_STATE: opts.claude.state } : {}),
    ...opts.env,
  };
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
