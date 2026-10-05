import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Straddle CLI installed with the Wizard, never one from the developer's PATH. @straddlecom/cli, an optional
// dependency, runs no install script: npm installs the binary as whichever of its optional platform packages
// (@straddlecom/cli-<platform>-<arch>) matches this machine, and the package's resolver finds it without downloading.
export type StraddleCli =
  | { kind: 'bundled'; dir: string; path: string; version: string }
  | { kind: 'missing'; reason: string; fix: string };

const VERSION_TIMEOUT_MS = 10_000;

export function bundledCli(): StraddleCli {
  // npx installs into <npm cache>/_npx/<hash> and reuses that tree on every later run, so reinstalling means deleting it.
  const npx = /^(.*[\\/]_npx[\\/][^\\/]+)[\\/]/.exec(fileURLToPath(import.meta.url))?.[1];
  const fix = `${npx ? `delete ${npx} (npx's cached install of the Wizard) and run it with npx again` : 'reinstall the Wizard'} without \`--omit=optional\`, or install the Straddle CLI`;
  let binaryPath: () => string | null;
  try {
    ({ binaryPath } = createRequire(import.meta.url)('@straddlecom/cli/resolve') as { binaryPath: () => string | null });
  } catch {
    return { kind: 'missing', reason: "@straddlecom/cli 1.0.4 or later isn't installed with the Wizard", fix };
  }
  const path = binaryPath();
  const target = `${process.platform}-${process.arch}`;
  if (!path) return { kind: 'missing', reason: `the Straddle CLI binary for ${target} isn't installed (npm skipped the optional platform package @straddlecom/cli-${target})`, fix };
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = r.status === 0 ? r.stdout.trim().split(/\s+/).at(-1) : undefined;
  if (!version) return { kind: 'missing', reason: `\`${path} --version\` failed: ${(r.error?.message ?? `${r.stdout}${r.stderr}`.trim()) || `exit ${r.status}`}`, fix };
  return { kind: 'bundled', dir: dirname(path), path, version };
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
