# Use Straddle Wizard

Configure an agent, manage the Straddle plugin, and continue an integration from its saved plans and reports. For installation and a first run, start with the [README](../README.md).

Examples use the global `wizard` command. With npx, replace it with `npx @straddlecom/wizard@latest`. The installed-package instructions apply to npm release `0.1.2`; [source-only behavior](#source-only-behavior) covers changes after that release.

## Configure sandbox requests

Wizard reads `STRADDLE_API_KEY`, `STRADDLE_ENVIRONMENT`, and `STRADDLE_BASE_URL` from the shell that starts it. It records whether the key is present. Keep the key in your shell or secret manager.

In Bash or Zsh, select sandbox and supply your sandbox key:

```sh
export STRADDLE_API_KEY="YOUR_SANDBOX_API_KEY"
export STRADDLE_ENVIRONMENT=sandbox
```

In PowerShell, set the same values:

```powershell
$env:STRADDLE_API_KEY = "YOUR_SANDBOX_API_KEY"
$env:STRADDLE_ENVIRONMENT = "sandbox"
```

An existing `STRADDLE_BASE_URL` overrides the environment's host in the CLI and SDKs. For sandbox requests, remove that override or set it to `https://sandbox.straddle.com`. Wizard reports a configuration error when the two settings disagree or the target is outside sandbox.

Without the key or sandbox environment, the guided run can proceed through planning. After setting them, use `wizard resume`; Setup runs first, followed by the remaining steps. A standalone `wizard setup` reports missing configuration. Manual status output supplies a handoff only when the next step can start.

Supply the key in Wizard's shell even if you saved it in the CLI. Claude Code's settings can also supply environment variables that override the shell inside its session. The skills check the environment again before sending requests.

## Configure an agent

Choose the client with `--client claude`, `--client codex`, or `--client cursor`. Auto requires the client's command on `PATH` and a signed-in session. Manual provides the instructions to use in your own client, including app-only installations.

Wizard prepares the plugin differently for each client.

| Client and mode | How the agent loads the plugin |
| --- | --- |
| Claude Code or Cursor, Auto | Wizard passes the selected bundle with `--plugin-dir` for that session. |
| Codex, Auto | Wizard checks the client's installed plugin against the selected bundle. |
| Any client, Manual | Wizard checks the installed plugin when the client exposes it, or prints installation instructions. |

Install or update the plugin for a named client:

```sh
wizard install --client codex
wizard update --client codex
```

Wizard prints the native commands before asking to run them. A successful install or update verifies the loaded plugin's content against the selected bundle. If a `straddle` marketplace already points elsewhere, Wizard reports the conflict and leaves that registration in place.

`wizard remove --client codex` removes the Straddle plugin using the client's commands. The configuration commands act on the `straddle` plugin and marketplace, plus the two Straddle MCP servers.

### Configure MCP servers

The plugin connects your agent to the following services.

| Service | Server name | Authentication |
| --- | --- | --- |
| API MCP | `straddle-api` | Bearer token from `STRADDLE_API_KEY` |
| Docs MCP | `straddle-docs` | Public documentation |

The API MCP endpoint is `https://mcp.scalar.com/mcp/d5d1b1c2-ae5b-432d-b795-4fcb31cfdedd`. The Docs MCP endpoint is `https://straddle-build-straddle-openapi.apidocumentation.com/mcp`.

Claude Code receives both servers through the plugin. Codex needs a client-level API MCP registration that reads `STRADDLE_API_KEY`; `wizard install` includes that registration. To configure the servers separately:

```sh
wizard mcp add --client codex
```

Cursor setup prints JSON for you to merge into its configuration. `wizard mcp remove --client codex` removes the two named Straddle servers.

### Choose Auto or Manual

Set the mode when starting or resuming a run:

```sh
wizard --client claude --mode auto
wizard resume --mode manual
```

Auto starts one agent session for the integration program. Manual prints the prompt and any preparation steps. When you return from a Manual session, Wizard reads the skill files to determine the next task. Manual can still run client version and plugin checks, plus configuration commands you approve; it does not require a successful login check.

Program sessions use your client's permission and sandbox settings. For Claude Code, Wizard adds a checklist status line and progress hooks through session settings. That status line replaces your usual one for the session. If your Claude Code policy disables those hooks, Wizard uses the saved files when you return and starts a new session when a prior session ID is unavailable.

Cursor Auto uses `cursor-agent` with the workspace and plugin directory. Resume adds the saved chat ID. Wizard leaves Cursor configuration changes to the instructions shown in Manual setup.

## Select a plugin release

Wizard `0.1.2` accepts Straddle plugin releases in the `0.1.x` range. It selects the newest compatible published release from [straddle-build/skills](https://github.com/straddle-build/skills/releases), excluding drafts and prereleases.

Each release supplies `straddle-plugin-<version>.zip` and `SHA256SUMS`. Before using a download, Wizard verifies its checksum, plugin version, archive paths, file types, and allowed plugin contents. It reuses an intact cached copy of the selected release.

The cache directory is `${XDG_CACHE_HOME:-~/.cache}/straddle-wizard/plugin`. Its adjacent `release.json` stores the verified content digest. Wizard checks that digest on later uses. An edited or damaged cache requires a fresh download. If the release list is unavailable, Wizard can use the verified release already cached on your machine and reports that choice.

`wizard status` reports the local cached bundle. To inspect the skills available in a selected release:

```sh
wizard skill list
wizard skill list --json
```

`--yes` accepts plugin downloads and runs install, update, remove, or MCP configuration commands without another prompt. Approving those setup operations does not approve a plan or a sandbox write inside the agent session.

For a mirror, `STRADDLE_WIZARD_RELEASES` can point to a URL that serves the GitHub releases JSON format. A local `--bundle` takes precedence over release discovery; see [Develop and test Wizard](#develop-and-test-wizard).

## Use the bundled CLI

Wizard depends optionally on `@straddlecom/cli`. npm selects the matching `@straddlecom/cli-<platform>-<arch>` binary package for macOS, Linux, or Windows on x64 or ARM64. These packages run no install scripts, so they can install with `--ignore-scripts`.

For Auto, Wizard puts its bundled CLI directory first on the agent session's `PATH`. For Manual, the handoff prints the shell or PowerShell command needed to use the same binary. `wizard status` shows the resolved binary path and version.

If npm omits optional packages, Wizard reports the missing binary and a recovery step. This can happen with `--omit=optional`, an incomplete cross-platform lockfile, or an unsupported system. Reinstall with optional dependencies enabled, or use a [standalone CLI installation](https://github.com/straddle-build/straddle-cli#install). For an npx cache problem, Wizard identifies the specific cached installation to replace.

Wizard's binary check runs `straddle --version` on the installed platform package. It does not download a replacement during the check. If the bundled binary is unavailable, the skills use an existing `straddle` on `PATH` or the Straddle SDK.

## Resume and inspect a run

Use the following commands to inspect progress and continue work:

```sh
wizard status
wizard status --json
wizard resume
```

Wizard reads the skill files in program order. The first missing, incomplete, or outdated result determines the next step.

| Step | File | Completion evidence |
| --- | --- | --- |
| Setup | `straddle-setup.md` | `Status: complete` |
| Plan | `straddle-integration-plan.md` | Approved plan state and matching approval hash |
| Migrate | `straddle-migration-report.md` | `Status: migrated` for the approved migration plan |
| Integrate | `straddle-integration-report.md` | `Status: complete` for the approved plan |
| Test | `straddle-test-evidence.md` | `Status: complete` for the approved plan |
| Go Live | `straddle-go-live-report.md` | `Status: ready` for the approved plan |

The approval hash is the SHA-256 of the plan with its `- Plan state:` and `- Approval:` lines removed. Reports name their plan and its hash. Changing the plan invalidates the earlier approval and reports. A completed migration requires its report, even when the migration plan is already approved.

In Auto, Wizard uses a saved session ID to reopen Claude Code, Codex, or Cursor at the next step. If no ID is available, it opens a new session there. Manual prints the next prompt. Without a run receipt, Wizard asks for context and resumes from the existing skill files.

### Read progress and reports

Claude Code reports progress through session hooks and its status line. Codex Auto follows its session log and serves a checklist at a local `127.0.0.1` browser address. For both clients, a completed checkbox requires agreement between the saved skill file and the agent's successful handoff.

Cursor and Manual runs use the saved files when the session ends or when you return. `wizard status --json` includes the bundle, client checks, bundled CLI, configuration errors, and saved run. A Manual run can include the next prompt in `run.paste`.

The end-of-session report shows step evidence and the verification checklist. Auto also compares file hashes to identify changes and reports when that comparison is incomplete. In a terminal, Wizard renders the reports produced by the run. Piped output stays plain, and `--json` keeps machine-readable output.

`NO_COLOR` removes color. `CI` or `TERM=dumb` also suppresses the startup splash. Terminal cards wrap to the available width, up to 100 columns; wide report tables use one card per row.

### Finish after testing

When Test is complete for the approved plan and Go Live is the only unfinished step, Wizard offers **Finish here (skip Go Live)** if Go Live has not reported for that plan. Status then shows `Go Live skipped`. Editing the plan or replacing its test evidence makes Go Live pending again. Run `wizard go-live` to perform the readiness review separately.

### Start fresh

When Wizard finds a saved run or Straddle state files, it offers a fresh start or resume. A fresh integration keeps earlier skill files as `<file>.previous-<time>` and preserves the receipt and events with timestamped names.

The receipt moves after you confirm context. Skill files and events move after you choose an agent and mode. Cancelling before those choices keeps the skill files in place. Single-step commands such as `wizard plan` run their skill without moving the integration's state files aside.

Ctrl-C at a Wizard prompt saves an aborted run and keeps the work. During an agent session, the agent handles Ctrl-C. Resume prompts require a fresh preview and approval for each sandbox write. The unchanged plan's recorded approval remains valid.

## Inspect the session log

Open the local log after a recorded session:

```sh
wizard log
```

Wizard writes `.straddle-wizard/session-log.html` with owner-only permissions, replacing the previous generated page. The page groups recorded tool calls and agent replies by step. A terminal opens it in your browser; piped output prints the path.

The log combines `.straddle-wizard/events.jsonl` with available Claude Code transcripts or Codex session logs. It reports missing or unreadable transcripts and still shows the recorded steps. Secret-labeled values, tokens, account and routing numbers, and home-directory paths pass through redaction before rendering. The HTML, styles, and scripts stay in one local file.

## Control project discovery

Select another project directory or exclude additional sensitive paths:

```sh
wizard --dir ./my-app --exclude 'private/**' --exclude 'customer-data/**'
```

`--exclude` is repeatable. `STRADDLE_WIZARD_EXCLUDE` accepts comma-separated patterns. Resume adds new exclusions to those already saved for the run.

Discovery reads dependency manifests and filenames, and Auto hashes eligible project files to identify changes. It skips `.env*`, keys, certificates, credential and CLI configuration files, excluded paths, and symlinks. The same exclusions apply when reading plans and reports. Unreadable directories are skipped and named.

For a project that declares Plaid, Wizard checks source for Transfer, Identity Verification, and Link usage. Transfer or Identity Verification adds the migration step. Link-only usage is recorded as a bank connection so planning can choose whether to keep Plaid tokens or use Straddle Bridge.

Tests, mocks, fixtures, and installed packages do not count as application use. Transfer or Identity Verification mentions in comments count conservatively; Link mentions in comments and docstrings do not. If discovery cannot inspect all relevant source, or finds no Plaid calls, it keeps Plaid as a provider. The saved run retains that choice during resume so migration edits do not remove the migration step midway through a run.

## Develop and test Wizard

Install dependencies in a source checkout. The test suite also needs a Straddle skills checkout containing a compatible plugin and state-file templates:

```sh
npm ci
export STRADDLE_SKILLS_SOURCE=/path/to/straddle-skills
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

The [CI workflow](../.github/workflows/ci.yml) pins the skills fixture commit used by tests. Use that revision when reproducing CI. Tests exercise the CLI with a scripted Claude Code adapter and local HTTP fixtures for plugin releases. Contract tests compare the skills' report headers and plan-approval rules with Wizard's readers.

To use a local plugin checkout, pass its path:

```sh
node dist/cli.js --bundle /path/to/straddle-skills
```

`STRADDLE_WIZARD_BUNDLE` supplies the same override. Wizard checks the plugin version, runtime paths, and permitted checkout files, then labels it as a local bundle. A local bundle takes precedence over release downloads. Extra client-loadable directories, symlinks in runtime paths, or an incompatible version fail validation.

For offline integration fixtures, the configuration reader accepts a loopback synthetic target. The selected skill checks the additional fixture conditions before sending requests.

## Source-only behavior

The default branch contains the following behavior after npm release `0.1.2`. Building this branch includes it; the published `0.1.2` package uses the earlier behavior.

### Use decisions from a revised plan

The source build uses resolved choices from the integration plan's Decisions table in later handoffs. Its final report also lists sandbox resource IDs recorded by the agent, with synthetic targets and earlier test runs excluded. Those IDs are reported evidence, not an independent API readback.

### Review payment code after testing

With a local skills bundle containing `straddle-payment-review`, the source build runs an advisory payment review between Test and Go Live. It applies to Claude Code and Codex Auto, plus Claude Code Manual.

Before the first session changes files, Wizard saves the starting state under `refs/straddle-wizard/<run id>`. The comparison excludes existing edits, sensitive files, and paths supplied through `--exclude`. After Test, a fresh session reviews the run's changes. Go Live then resumes the original session.

The review process receives read-only permissions: Claude Code has no shell, and Codex uses a read-only sandbox with MCP servers disabled. The reviewer prints a report. Wizard saves a valid report as `straddle-payment-review.md` only if the code stays unchanged during review.

Open Critical or High findings appear as warnings in Go Live. The readiness review can still report ready, so read the findings before proceeding. Fixes return to Integrate after approval. An incomplete review also produces a warning. Ctrl-C stops review without saving a report, and resume tries again. A saved report is reused only when its plan and code hashes still match.

Claude Code Manual receives a command for a separate review session. Codex Manual and Cursor continue with the standard program. The full review contract lives in the selected skills bundle's `wizard-program.md` reference.
