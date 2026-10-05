import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, win32 } from 'node:path';
import { field, parseJson, text } from './json.ts';

// The Straddle CLI installed with the Wizard (@straddlecom/cli, an optional dependency), never one from the
// developer's PATH. npm drops the package when its postinstall, which downloads the platform binary, fails.
export type StraddleCli =
  | { kind: 'bundled'; dir: string; path: string; version: string }
  | { kind: 'missing'; reason: string; fix: string };

const VERSION_TIMEOUT_MS = 10_000;

export function bundledCli(): StraddleCli {
  let manifest: string;
  try {
    manifest = createRequire(import.meta.url).resolve('@straddlecom/cli/package.json');
  } catch {
    return { kind: 'missing', reason: "@straddlecom/cli isn't installed with the Wizard (npm leaves it out when its binary download fails)", fix: 'reinstall the Wizard, or install the Straddle CLI' };
  }
  const pkgDir = dirname(manifest);
  // <install>/node_modules/@straddlecom/cli: rebuilding there reruns the binary download.
  const fix = `run \`npm rebuild @straddlecom/cli\` in ${dirname(dirname(dirname(pkgDir)))}, or install the Straddle CLI`;
  const bin = text(field(field(parseJson(readFileSync(manifest, 'utf8')), 'bin'), 'straddle'));
  if (!bin || !existsSync(join(pkgDir, bin))) return { kind: 'missing', reason: `@straddlecom/cli in ${pkgDir} declares no \`straddle\` bin that exists`, fix };
  // The declared bin, bin/straddle.js, is a Node launcher for ../vendor/straddle(.exe), which the postinstall
  // downloads; the launcher downloads it itself when missing. A session's PATH needs a file named `straddle`, and this
  // check must not download, so both use the native binary beside the launcher.
  const dir = join(dirname(join(pkgDir, bin)), '..', 'vendor');
  const path = join(dir, process.platform === 'win32' ? 'straddle.exe' : 'straddle');
  if (!existsSync(path)) return { kind: 'missing', reason: `its binary was never downloaded (install scripts off, or the download failed): no ${path}`, fix };
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = r.status === 0 ? r.stdout.trim().split(/\s+/).at(-1) : undefined;
  if (!version) return { kind: 'missing', reason: `\`${path} --version\` failed: ${(r.error?.message ?? `${r.stdout}${r.stderr}`.trim()) || `exit ${r.status}`}`, fix };
  return { kind: 'bundled', dir, path, version };
}

// An agent session's environment: the bundled CLI first on PATH, so the skills' `straddle` calls use it. Windows
// names are case-insensitive and it spells the variable `Path`, so a second, differently cased key would leave which
// one wins to chance; elsewhere `Path` is a different variable and only `PATH` counts.
export function sessionEnv(env: NodeJS.ProcessEnv, cli: StraddleCli, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (cli.kind !== 'bundled') return env;
  if (platform !== 'win32') return { ...env, PATH: [cli.dir, env.PATH].filter(Boolean).join(posix.delimiter) };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: [cli.dir, env[key]].filter(Boolean).join(win32.delimiter) };
}

// One line for readiness and `wizard status`.
export function cliSummary(cli: StraddleCli): string {
  return cli.kind === 'bundled'
    ? `straddle ${cli.version} at ${cli.path}, first on PATH in the agent session`
    : `not available: ${cli.reason}. To fix it, ${cli.fix}. Until then the skills use a \`straddle\` on your PATH, or the Straddle SDK`;
}
