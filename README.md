# wizard

Local Straddle Developer Kit installer and agent orchestrator.

`@straddlecom/wizard` is a guided terminal setup. Run it in your project, confirm what it detected, answer four questions, and it hands the work to your local coding agent (Claude Code, Codex, or Cursor) through the versioned [Straddle skills](https://github.com/straddle-build/skills). Every integration instruction lives in those skills. The Wizard detects, asks, checks readiness, starts the skill in your agent, and reports what it observed.

## Status

- The Wizard runs Straddle plugin releases: GitHub releases of `straddle-build/skills` in its `0.1.x` range. None is published yet, so until the first one exists, run it with `--bundle <skills checkout>`.
- The npm package is not published yet. `.github/workflows/release.yml` publishes it with npm provenance when a GitHub release is published.

## Requirements

- Node.js 22.18 or later.
- Claude Code or Codex on `PATH` for automated handoff. Cursor always gets a manual handoff.

## Skills bundle

The Wizard runs a Straddle plugin release, or a local skills directory you pass with `--bundle`. It doesn't pin a skills commit, so a skills fix reaches you with the next plugin release, without a new Wizard.

**Where releases come from.** GitHub releases of `straddle-build/skills`, read from `https://api.github.com/repos/straddle-build/skills/releases`. Each release is tagged `v<version>` and carries `straddle-plugin-<version>.zip` and `SHA256SUMS`, built by the skills repository's release cut (its `docs/packaging.md`, Plugin releases). This Wizard accepts plugin versions `0.1.x` (`PLUGIN_RELEASES` in `src/bundle.ts`). It uses the newest `vX.Y.Z` release in that range, and skips drafts, prereleases and newer releases outside it. A `0.2.0` plugin needs a Wizard release that accepts it. `STRADDLE_WIZARD_RELEASES` points the Wizard at another URL that serves the same JSON, such as a mirror.

**Verification.** The Wizard refuses a release, and keeps nothing from it, when:

- the zip's SHA-256 differs from its line in the release's `SHA256SUMS`;
- the release is outside the range;
- its `plugin.json` version isn't the tag's;
- the zip holds anything but stored regular files with safe paths;
- the unpacked top level holds anything a client could load besides the plugin's runtime files (`plugin.json`, `mcp.json`, the three client manifests, `assets/`, `skills/`, `references/`, `third_party/`, `LICENSE`, `README.md`). Examples are `hooks/`, `commands/`, `agents/` and `.mcp.json`.

A verified release is kept at `${XDG_CACHE_HOME:-~/.cache}/straddle-wizard/plugin`, a stable path, so a client marketplace registered from it survives updates. The Wizard records its content digest in `straddle-wizard/release.json` and re-hashes the directory against that record on every use, so an edited copy is refused.

**Order.**

1. `--bundle <path>` or `STRADDLE_WIZARD_BUNDLE`, when you pass one. This is for local testing: a skills checkout whose plugin version is in range and whose top level holds only plugin files, the checkout's own non-plugin files (`docs/`, `evals/`, `fixtures/`, `scripts/`, `tests/`, `kit/`, `.github/`, `.gitignore`, `.markdownlint-cli2.jsonc`, `.git`) and Claude Code's cache bookkeeping (`.in_use/`, `.orphaned_at`). It is labelled "local bundle, not a release" and isn't compared with any release.
2. Otherwise the Wizard lists the releases. If the newest in range is already cached and intact, it uses that copy. If not, it shows the release and the two asset URLs, and downloads them only after you choose Download (or pass `--yes` to `install`, `update` or `skill list`).
3. If the release list can't be read, for example offline, it uses the verified release already on this machine and says so.

`wizard status` never touches the network. It reports the cached release.

## Guided run

```sh
cd your-project
npx @straddlecom/wizard
```

1. **Context.** The Wizard shows the directory, detected language, framework, any Straddle SDK and other payment providers, and the program it will run. Choose Continue, Change detected context, Privacy and data, or Cancel. Detected values are suggestions; corrected values are marked "(you)".
2. **Choices.** It asks what you want to build (charges, payouts, or both), direct, SaaS, or marketplace, which SDK, and which notification path (webhook, FIFO, or polling endpoint). It never infers these from the framework. "Not decided yet" leaves the question to the skill.
3. **Agent.** Pick an installed agent, or pass `--client`. The menu labels how much progress the Wizard can see for each: Claude Code progress is observed through hooks, Codex progress is unverified, and Cursor is a manual handoff.
4. **Readiness.** The Wizard finds or downloads the skills bundle, then checks the agent binary and login, the Straddle plugin, the API MCP credential route, `STRADDLE_API_KEY` (presence only), and the declared environment. Claude Code sessions always load that bundle with `claude --plugin-dir`, so nothing needs installing. Codex loads its own installed copy, so the Wizard checks that copy's content against the bundle, not just its version; when it differs or is missing, the Wizard prints the exact native install or update commands and runs them only when you choose to.
5. **Steps.** The default program runs Setup, Plan, Integrate, and Test. Each step opens your agent in the same terminal with `/straddle:<skill>`, followed by the language and framework you confirmed (marked detected or corrected) and your choices. Answer its questions and approve or deny its actions there; choosing Start in the Wizard is not approval of anything. Exit the agent when the skill prints its handoff. Integrate and Test run only an approved plan: an approval recorded in `straddle-integration-plan.md` (or, for Test, `straddle-migration-plan.md`) that matches the current plan, or your approval of the current plan in that step's own session. The skill records your approval in the plan file, so it carries into later sessions until the plan is edited; the Wizard shows the plan and this rule before both steps. When Integrate or Test stops because the plan is not approved, approve the current plan there and ask the agent to continue.
6. **Report.** After each step the Wizard shows what it observed separately from what the agent reported. Observed means Claude Code hooks confirmed a step file was opened (with the Read tool, or by a shell command that names it) or a file edit completed, or the Wizard's before-and-after file hashes changed; a step entry is not completion or approval. Reported means the skill's printed handoff status (or `abort` when an abort is the later marker). When the agent prints both `STRADDLE_ABORT` and a handoff, the later one counts, so a step the agent recovers and completes in the same session advances. A reported handoff never outranks the Wizard's own evidence: a session that exits with an error, ends by a signal, or last reports `STRADDLE_ABORT` does not advance, and `wizard resume` runs that step again. The final report lists changed files, says when that list is incomplete (the discovery file limit was reached, or paths could not be read), states that the Wizard sent no Straddle request and verified no server-side resource, and prints the skill's "Verify before merging" checklist.

Ctrl-C at a Wizard prompt marks the run aborted and keeps all work. While the agent runs, Ctrl-C belongs to the agent. Nothing is rolled back. Starting a new run over a saved one, finished or not, keeps the saved receipt beside the new one as `.straddle-wizard/receipt.json.<state>-<time>`.

## Commands

| Command | What it does |
| -- | -- |
| `wizard` | Guided integration: Setup, Plan, Integrate, Test. |
| `wizard resume` | Shows the saved run and continues from the first step the Wizard has not advanced past. Choices the first run did not finish are asked first, and `--exclude` paths are added to the saved ones. |
| `wizard setup`, `plan`, `integrate`, `test` | One step of the integration program. |
| `wizard get-started`, `migrate`, `go-live`, `audit` | The named program's skill. |
| `wizard skill list`, `wizard skill run <name>` | Lists the bundle's skills with versions, or runs one directly. |
| `wizard install`, `update`, `remove` | Installs, updates, or removes the Straddle plugin with the client's own plugin commands. Install and update succeed only when the copy the client loads matches the Wizard's bundle, and never replace a `straddle` marketplace registered from another place. |
| `wizard mcp add`, `mcp remove` | Registers or removes only `straddle-api` and `straddle-docs` with the client's own MCP commands. |
| `wizard status` | Bundle, clients, plugin and MCP state, key presence, environment, and the saved run. |

Options: `--dir <path>`, `--client claude|codex|cursor` (for guided runs, `resume`, and configuration commands), `--bundle <path>` (or `STRADDLE_WIZARD_BUNDLE`), `--exclude <glob>` (repeatable, or `STRADDLE_WIZARD_EXCLUDE=a,b`), `--yes` for downloading the skills and for configuration commands, and `--json` for `status` and `skill list`.

`wizard audit` runs the `straddle-audit` skill and prints the findings table from `straddle-audit-report.md`, with `file:line` and confidence for each finding. There is no `diagnose` command.

## Guarantees

- **No code edit before the plan.** Integrate and Test do not start until `straddle-integration-plan.md` (or, for Test, `straddle-migration-plan.md`) exists. In Claude Code, a per-session hook also denies the file-edit tools (Edit, Write, MultiEdit, NotebookEdit) on repository files until the plan exists. It does not cover shell commands that write files, which Claude Code's own permission prompts cover unless a managed policy allows them. Codex sessions get no such hook; the skill's own instructions and Codex's approval prompts apply there.
- **No Straddle request without configuration.** A missing `STRADDLE_API_KEY`, an environment other than Sandbox, or a `STRADDLE_BASE_URL` that disagrees with `STRADDLE_ENVIRONMENT` is shown as a configuration error before any step that can send Straddle requests. `STRADDLE_BASE_URL` is treated as the target when it is set, as the Straddle CLI and SDKs do. The run stops before sending any Straddle request; set the values in your shell and resume. The Wizard checks only these shell variables, not a saved Straddle CLI login.
- **No secrets.** The Wizard reads dependency manifests and file names in the selected repository, and hashes other files locally to report which ones changed. It never opens `.env*` files, keys, certificates, credential or CLI configuration files, or paths you pass with `--exclude`, and it does not follow symlinks. The same rules apply when it shows the plan or the audit report: a symlinked or excluded one is not opened. Directories it cannot read are skipped and named. It never reads, stores, or prints your API key; set it in your own shell.
- **No stored or inherited approval.** `.straddle-wizard/receipt.json` records the program, agent, context, choices, bundle identity, state (`ready`, `running`, `blocked`, `aborted`, `completed`), observed events, and reported markers. It has no approval field, and the Wizard treats it as untrusted input: a receipt whose run id, program, agent, step or choices are not the Wizard's own is set aside, not used. A resumed step starts a fresh agent session that asks again for every Sandbox write; only a plan approval recorded in the plan file, for the unchanged plan, carries over. Claude Code sessions start with `--setting-sources ''` and a per-session `--settings` file whose default permission mode is `default`, so your user and project allow rules, deny rules, hooks, other plugins, and auto or accept-edits mode do not apply. Your organization's managed policy still applies and can allow edits, commands or MCP calls without a prompt; the Wizard does not read it, so its readiness screen does not promise a prompt. OAuth or keychain login keeps working; authentication configured in settings (`apiKeyHelper`, an `env` block for Bedrock or Vertex) does not apply in these sessions. Codex sessions start with `--sandbox workspace-write --ask-for-approval on-request`, which override a `danger-full-access` sandbox or `never` approval default for that session; the rest of your Codex configuration, including hooks, MCP servers and other plugins, still applies.
- **Your agent owns the code.** Edits happen in your local agent. The Wizard hosts no model and sends no repository content to Straddle.
- **Other client configuration stays.** Install, update, remove, and MCP commands act only on the `straddle` plugin, its `straddle` marketplace, and the `straddle-api` and `straddle-docs` servers.

## MCP servers

| Server | URL | Credential |
| -- | -- | -- |
| `straddle-api` | `https://mcp.scalar.com/mcp/d5d1b1c2-ae5b-432d-b795-4fcb31cfdedd` | Your Straddle API key as a bearer token from `STRADDLE_API_KEY`. No Scalar login. |
| `straddle-docs` | `https://straddle-build-straddle-openapi.apidocumentation.com/mcp` | None. |

Claude Code gets both from the Straddle plugin. Codex needs a client-level `straddle-api` with `--bearer-token-env-var STRADDLE_API_KEY`, which `wizard install` and `wizard mcp add` add. Cursor configuration is manual; the Wizard prints the JSON to merge.

## Development

```sh
npm ci
export STRADDLE_SKILLS_SOURCE=/path/to/straddle-skills   # any straddle-build/skills checkout with plugin 0.1.x
npm run typecheck
npm test
npm run build
```

Tests drive the real CLI. Most use `STRADDLE_SKILLS_SOURCE` as a local bundle. The release tests serve fixture plugin releases, built from that checkout, from a local HTTP server that answers like the GitHub releases API, so no real tag or release is used. Claude Code is replaced by a scripted process in `tests/fixtures/fake-claude.mjs`, so the test suite is simulated-adapter evidence, not native-client proof.
