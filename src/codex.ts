// Live progress for Codex sessions. Codex has no status line command and no hook the Wizard installs, so the Wizard
// follows the session's rollout log for step entries and markers, and shows the checklist on a local page.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendEvents, newRollout, rolloutEvents, type Rollout } from './events.ts';
import { field, parseJson, text } from './json.ts';

function rolloutFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /(^|\/)rollout-[^/]*\.jsonl$/.test(f)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// The rollout of the session this Wizard started: the one named for `session` when it resumes one, otherwise the newest
// rollout written since `since` whose session runs in `repo`.
function findRollout(env: NodeJS.ProcessEnv, repo: string, since: number, session: string | null): string | null {
  // ponytail: scans every rollout under sessions/ each second until found; limit to recent day folders if that gets slow.
  try {
    const files = rolloutFiles(join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'sessions'));
    if (session) return files.find((f) => f.endsWith(`-${session}.jsonl`)) ?? null;
    const root = realpathSync(repo);
    const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
    for (const file of files.filter((f) => mtime(f) >= since).sort((a, b) => mtime(b) - mtime(a))) {
      try {
        const cwd = text(field(field(parseJson(readFileSync(file, 'utf8').split('\n', 1)[0]!), 'payload'), 'cwd'));
        if (cwd && existsSync(cwd) && realpathSync(cwd) === root) return file;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface Follower { stop(): Rollout }

// Appends the session's events to `eventsFile` as Codex logs them, once a second and once more on stop.
export function followCodex(env: NodeJS.ProcessEnv, repo: string, eventsFile: string, since: number, session: string | null): Follower {
  const state = newRollout();
  let file: string | null = null;
  let offset = 0;
  let partial = '';
  const read = () => {
    try {
      file ??= findRollout(env, repo, since, session);
      if (!file) return;
      const fd = openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(Math.max(0, statSync(file).size - offset));
        offset += readSync(fd, chunk, 0, chunk.length, offset);
        const lines = (partial + chunk.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        appendEvents(eventsFile, lines.flatMap((line) => rolloutEvents(state, line)));
      } finally {
        closeSync(fd);
      }
    } catch {
    }
  };
  const timer = setInterval(read, 1000);
  return { stop() { clearInterval(timer); read(); return state; } };
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// A read-only page on 127.0.0.1 that shows `render()` and reloads itself every two seconds.
export async function checklistPage(render: () => string): Promise<{ url: string; close(): void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Straddle Wizard</title><pre style="font:15px/1.5 ui-monospace,monospace;margin:2rem">${escapeHtml(render())}</pre>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => { server.close(); server.closeAllConnections(); } };
}
