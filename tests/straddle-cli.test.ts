// The Straddle CLI the Wizard installs with itself, seen from inside a launched session (the scripted Claude Code in
// tests/fixtures/fake-claude.mjs) and from `wizard status`.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, fakeClaude, nextRepo, runWizard, tempDir } from './helpers.ts';

const CONFIGURED = { STRADDLE_API_KEY: 'sk_test_value_in_test_env', STRADDLE_ENVIRONMENT: 'sandbox' };
// Continue, charges, marketplace, suggested SDK, webhook endpoint, Auto, Start.
const AUTO_START = ['1', '1', '3', '', '1', '1', '1'];
const SETUP_SESSION = { 'straddle-setup': { steps: ['01-begin'], text: 'STRADDLE_HANDOFF {"skill":"straddle-setup","status":"ready","report":"ready"}' } };

// A copy of this Wizard installed with `--ignore-scripts`: @straddlecom/cli without the binary its postinstall downloads.
function wizardWithoutCliBinary(): { cli: string; root: string } {
  const root = realpathSync(tempDir('install'));
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@straddlecom'), { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
    if (entry !== '@straddlecom') symlinkSync(join(ROOT, 'node_modules', entry), join(root, 'node_modules', entry));
  }
  const cli = join(ROOT, 'node_modules', '@straddlecom', 'cli');
  cpSync(cli, join(root, 'node_modules', '@straddlecom', 'cli'), { recursive: true, filter: (src) => src !== join(cli, 'vendor') });
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

test('without the CLI binary, readiness and status say so with the fix, and the session still runs, with no `straddle` added to its PATH', async () => {
  const { cli, root } = wizardWithoutCliBinary();
  const repo = nextRepo();
  const claude = fakeClaude();
  claude.sessions(SETUP_SESSION);
  const missing = `not available: its binary was never downloaded (install scripts off, or the download failed): no ${root}/node_modules/@straddlecom/cli/vendor/straddle. To fix it, run \`npm rebuild @straddlecom/cli\` in ${root}, or install the Straddle CLI. Until then the skills use a \`straddle\` on your PATH, or the Straddle SDK\n`;

  const r = await runWizard(['setup', '--client', 'claude'], { cwd: repo, claude, env: CONFIGURED, input: AUTO_START, cli });
  const status = await runWizard(['status'], { cwd: repo, env: CONFIGURED, cli });

  assert.ok(r.stdout.includes(`Straddle CLI      ${missing}`), r.stdout + r.stderr);
  assert.match(r.stdout, /Session ended \(Claude Code exited with code 0\)/);
  assert.equal(readFileSync(join(claude.state, 'straddle.txt'), 'utf8'), '');
  assert.equal(status.code, 0);
  assert.ok(status.stdout.includes(`  Straddle CLI   ${missing}`), status.stdout);
});
