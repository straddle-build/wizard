import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

// The Straddle CLI installed with the Wizard (@straddlecom/cli), never one from the developer's PATH. Its postinstall
// downloads the platform binary into vendor/; the package's bin, bin/straddle.js, only launches that binary (and
// downloads it when missing), and isn't named `straddle`. So vendor/ is the directory a session's PATH gets.
export type StraddleCli =
  | { kind: 'bundled'; dir: string; path: string; version: string }
  | { kind: 'missing'; reason: string; fix: string };

const VERSION_TIMEOUT_MS = 10_000;

export function bundledCli(): StraddleCli {
  let pkgDir: string;
  try {
    pkgDir = dirname(createRequire(import.meta.url).resolve('@straddlecom/cli/package.json'));
  } catch {
    return { kind: 'missing', reason: "@straddlecom/cli isn't installed with the Wizard", fix: 'reinstall the Wizard, or install the Straddle CLI' };
  }
  // <install>/node_modules/@straddlecom/cli: rebuilding there reruns the binary download.
  const fix = `run \`npm rebuild @straddlecom/cli\` in ${dirname(dirname(dirname(pkgDir)))}, or install the Straddle CLI`;
  const dir = join(pkgDir, 'vendor');
  const path = join(dir, process.platform === 'win32' ? 'straddle.exe' : 'straddle');
  if (!existsSync(path)) return { kind: 'missing', reason: `its binary was never downloaded (install scripts off, or the download failed): no ${path}`, fix };
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = r.status === 0 ? r.stdout.trim().split(/\s+/).at(-1) : undefined;
  if (!version) return { kind: 'missing', reason: `\`${path} --version\` failed: ${(r.error?.message ?? `${r.stdout}${r.stderr}`.trim()) || `exit ${r.status}`}`, fix };
  return { kind: 'bundled', dir, path, version };
}

// An agent session's environment: the bundled CLI first on PATH, so the skills' `straddle` calls use it.
export function sessionEnv(env: NodeJS.ProcessEnv, cli: StraddleCli): NodeJS.ProcessEnv {
  return cli.kind === 'bundled' ? { ...env, PATH: [cli.dir, env.PATH].filter(Boolean).join(delimiter) } : env;
}

// One line for readiness and `wizard status`.
export function cliSummary(cli: StraddleCli): string {
  return cli.kind === 'bundled'
    ? `straddle ${cli.version} at ${cli.path}, first on PATH in the agent session`
    : `not available: ${cli.reason}. To fix it, ${cli.fix}. Until then the skills use a \`straddle\` on your PATH, or the Straddle SDK`;
}
