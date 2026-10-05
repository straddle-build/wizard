// The Straddle CLI the Wizard installs with itself, seen from inside a launched session (the scripted Claude Code in
// tests/fixtures/fake-claude.mjs) and from `wizard status`.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionEnv } from '../src/straddle-cli.ts';
import { ROOT, fakeClaude, nextRepo, runWizard, tempDir } from './helpers.ts';

const CONFIGURED = { STRADDLE_API_KEY: 'sk_test_value_in_test_env', STRADDLE_ENVIRONMENT: 'sandbox' };
// Continue, charges, marketplace, suggested SDK, webhook endpoint, Auto, Start.
const AUTO_START = ['1', '1', '3', '', '1', '1', '1'];
const SETUP_SESSION = { 'straddle-setup': { steps: ['01-begin'], text: 'STRADDLE_HANDOFF {"skill":"straddle-setup","status":"ready","report":"ready"}' } };

// A copy of this Wizard as npm leaves it when the CLI's binary download didn't happen: installed with
// `--ignore-scripts` (@straddlecom/cli without vendor/), or after the download failed (npm drops the optional package).
function wizardInstall(layout: 'no binary' | 'no package'): { cli: string; root: string } {
  const root = realpathSync(tempDir('install'));
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@straddlecom'), { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
    if (entry !== '@straddlecom') symlinkSync(join(ROOT, 'node_modules', entry), join(root, 'node_modules', entry));
  }
  const cli = join(ROOT, 'node_modules', '@straddlecom', 'cli');
  if (layout === 'no binary') cpSync(cli, join(root, 'node_modules', '@straddlecom', 'cli'), { recursive: true, filter: (src) => src !== join(cli, 'vendor') });
  return { cli: join(root, 'src', 'cli.ts'), root };
}

test('a launched Claude Code session runs `straddle` from the Wizard\'s own install, and status names that binary and version', async () => {
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(SETUP_SESSION);
  const bundled = join(realpathSync(ROOT), 'node_modules', '@straddlecom', 'cli', 'vendor', 'straddle');

  const r = await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: AUTO_START });
  const status = await runWizard(['status'], { cwd: repo, env: CONFIGURED });

  assert.match(r.stdout, /Session ended \(Claude Code exited with code 0\)/, r.stdout + r.stderr);
  assert.equal(readFileSync(join(claude.state, 'straddle.txt'), 'utf8'), `${bundled}\nstraddle 1.0.3\n`);
  assert.ok(r.stdout.includes(`Straddle CLI      straddle 1.0.3 at ${bundled}, first on PATH in the agent session\n`), r.stdout);
  assert.ok(status.stdout.includes(`  Straddle CLI   straddle 1.0.3 at ${bundled}, first on PATH in the agent session\n`), status.stdout);
});

test('the session PATH change touches only the variable the platform reads: `PATH` on macOS and Linux, Windows\' own `Path`', () => {
  const posix = { kind: 'bundled', dir: '/w/vendor', path: '/w/vendor/straddle', version: '1.0.3' } as const;
  const windows = { kind: 'bundled', dir: 'C:\\w\\vendor', path: 'C:\\w\\vendor\\straddle.exe', version: '1.0.3' } as const;

  assert.deepEqual(sessionEnv({ Path: '/custom', PATH: '/usr/bin' }, posix, 'darwin'), { Path: '/custom', PATH: '/w/vendor:/usr/bin' });
  assert.deepEqual(sessionEnv({ Path: '/custom', PATH: '/usr/bin' }, posix, 'linux'), { Path: '/custom', PATH: '/w/vendor:/usr/bin' });
  assert.deepEqual(sessionEnv({ Path: 'C:\\Windows', HOME: 'C:\\h' }, windows, 'win32'), { Path: 'C:\\w\\vendor;C:\\Windows', HOME: 'C:\\h' });
});

for (const layout of ['no binary', 'no package'] as const) {
  test(`${layout}: readiness and status say the CLI is missing with the fix, and the session still runs, with no \`straddle\` added to its PATH`, async () => {
    const { cli, root } = wizardInstall(layout);
    const repo = nextRepo();
    const claude = fakeClaude();
    claude.sessions(SETUP_SESSION);
    const missing = layout === 'no binary'
      ? `not available: its binary was never downloaded (install scripts off, or the download failed): no ${root}/node_modules/@straddlecom/cli/vendor/straddle. To fix it, run \`npm rebuild @straddlecom/cli\` in ${root}, or install the Straddle CLI. Until then the skills use a \`straddle\` on your PATH, or the Straddle SDK\n`
      : "not available: @straddlecom/cli isn't installed with the Wizard (npm leaves it out when its binary download fails). To fix it, reinstall the Wizard, or install the Straddle CLI. Until then the skills use a `straddle` on your PATH, or the Straddle SDK\n";

    const r = await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: AUTO_START, cli });
    const status = await runWizard(['status'], { cwd: repo, env: CONFIGURED, cli });

    assert.ok(r.stdout.includes(`Straddle CLI      ${missing}`), r.stdout + r.stderr);
    assert.match(r.stdout, /Session ended \(Claude Code exited with code 0\)/);
    assert.equal(readFileSync(join(claude.state, 'straddle.txt'), 'utf8'), '');
    assert.equal(status.code, 0);
    assert.ok(status.stdout.includes(`  Straddle CLI   ${missing}`), status.stdout);
  });
}
