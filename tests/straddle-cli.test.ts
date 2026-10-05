// The Straddle CLI the Wizard installs with itself, seen from inside a launched session (the scripted Claude Code in
// tests/fixtures/fake-claude.mjs) and from `wizard status`.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionEnv } from '../src/straddle-cli.ts';
import { ROOT, fakeClaude, nextRepo, runWizard, tempDir, writeFiles } from './helpers.ts';

const CONFIGURED = { STRADDLE_API_KEY: 'sk_test_value_in_test_env', STRADDLE_ENVIRONMENT: 'sandbox' };
// Continue, charges, marketplace, suggested SDK, webhook endpoint, Auto, Start.
const AUTO_START = ['1', '1', '3', '', '1', '1', '1'];
const SETUP_SESSION = { 'straddle-setup': { steps: ['01-begin'], text: 'STRADDLE_HANDOFF {"skill":"straddle-setup","status":"ready","report":"ready"}' } };

const TARGET = `${process.platform}-${process.arch}`;

// A copy of this Wizard installed in `root` with a fixture @straddlecom/cli whose resolver answers the path of a stub
// `straddle` in this platform's package, or null as when npm skipped that optional package; or with no @straddlecom/cli.
function wizardInstall(layout: 'platform package' | 'no platform package' | 'no package', root: string): { cli: string; binary: string } {
  mkdirSync(join(root, 'node_modules', '@straddlecom'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
    if (entry !== '@straddlecom') symlinkSync(join(ROOT, 'node_modules', entry), join(root, 'node_modules', entry));
  }
  const binary = join(root, 'node_modules', '@straddlecom', `cli-${TARGET}`, 'bin', 'straddle');
  if (layout !== 'no package') {
    writeFiles(join(root, 'node_modules', '@straddlecom', 'cli'), {
      'package.json': JSON.stringify({ name: '@straddlecom/cli', version: '1.0.4', exports: { '.': './resolve.js', './resolve': './resolve.js', './package.json': './package.json' } }),
      'resolve.js': `module.exports = { binaryPath: () => ${layout === 'platform package' ? JSON.stringify(binary) : 'null'} };\n`,
    });
  }
  if (layout === 'platform package') {
    writeFiles(root, { [binary.slice(root.length + 1)]: '#!/bin/sh\necho "straddle 1.0.4"\n' });
    chmodSync(binary, 0o755);
  }
  return { cli: join(root, 'src', 'cli.ts'), binary };
}

test('a launched Claude Code session runs `straddle` from the Wizard\'s platform package, and status names that binary and version', async () => {
  const { cli, binary } = wizardInstall('platform package', realpathSync(tempDir('install')));
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(SETUP_SESSION);

  const r = await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: AUTO_START, cli });
  const status = await runWizard(['status'], { cwd: repo, env: CONFIGURED, cli });

  assert.match(r.stdout, /Session ended \(Claude Code exited with code 0\)/, r.stdout + r.stderr);
  assert.equal(readFileSync(join(claude.state, 'straddle.txt'), 'utf8'), `${binary}\nstraddle 1.0.4\n`);
  assert.ok(r.stdout.includes(`Straddle CLI      straddle 1.0.4 at ${binary}, first on PATH in the agent session\n`), r.stdout);
  assert.ok(status.stdout.includes(`  Straddle CLI   straddle 1.0.4 at ${binary}, first on PATH in the agent session\n`), status.stdout);
});

test('the session PATH change touches only the variable the platform reads: `PATH` on macOS and Linux, Windows\' own `Path`', () => {
  const posix = { kind: 'bundled', dir: '/w/cli-darwin-arm64/bin', path: '/w/cli-darwin-arm64/bin/straddle', version: '1.0.4' } as const;
  const windows = { kind: 'bundled', dir: 'C:\\w\\cli-win32-x64\\bin', path: 'C:\\w\\cli-win32-x64\\bin\\straddle.exe', version: '1.0.4' } as const;

  assert.deepEqual(sessionEnv({ Path: '/custom', PATH: '/usr/bin' }, posix, 'darwin'), { Path: '/custom', PATH: '/w/cli-darwin-arm64/bin:/usr/bin' });
  assert.deepEqual(sessionEnv({ Path: '/custom', PATH: '/usr/bin' }, posix, 'linux'), { Path: '/custom', PATH: '/w/cli-darwin-arm64/bin:/usr/bin' });
  assert.deepEqual(sessionEnv({ Path: 'C:\\Windows', HOME: 'C:\\h' }, windows, 'win32'), { Path: 'C:\\w\\cli-win32-x64\\bin;C:\\Windows', HOME: 'C:\\h' });
});

// npx keeps its install in <npm cache>/_npx/<hash>, so the fix there names that directory to delete.
for (const layout of ['no platform package', 'no package'] as const) {
  test(`${layout}: readiness and status say the CLI is missing with the fix, and the session still runs, with no \`straddle\` added to its PATH`, async () => {
    const root = layout === 'no platform package' ? join(realpathSync(tempDir('npm-cache')), '_npx', '0a1b2c3d4e5f6789') : realpathSync(tempDir('install'));
    const { cli } = wizardInstall(layout, root);
    const repo = nextRepo();
    const claude = fakeClaude();
    claude.sessions(SETUP_SESSION);
    const missing = layout === 'no platform package'
      ? `not available: the Straddle CLI binary for ${TARGET} isn't installed (npm skipped the optional platform package @straddlecom/cli-${TARGET}). To fix it, delete ${root} (npx's cached install of the Wizard) and run it with npx again without \`--omit=optional\`, or install the Straddle CLI. Until then the skills use a \`straddle\` on your PATH, or the Straddle SDK\n`
      : "not available: @straddlecom/cli 1.0.4 or later isn't installed with the Wizard. To fix it, reinstall the Wizard without `--omit=optional`, or install the Straddle CLI. Until then the skills use a `straddle` on your PATH, or the Straddle SDK\n";

    const r = await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: AUTO_START, cli });
    const status = await runWizard(['status'], { cwd: repo, env: CONFIGURED, cli });

    assert.ok(r.stdout.includes(`Straddle CLI      ${missing}`), r.stdout + r.stderr);
    assert.match(r.stdout, /Session ended \(Claude Code exited with code 0\)/);
    assert.equal(readFileSync(join(claude.state, 'straddle.txt'), 'utf8'), '');
    assert.equal(status.code, 0);
    assert.ok(status.stdout.includes(`  Straddle CLI   ${missing}`), status.stdout);
  });
}
