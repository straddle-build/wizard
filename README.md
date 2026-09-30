# wizard

Local Straddle Developer Kit installer and agent orchestrator.

`@straddlecom/wizard` is a guided terminal setup. Run it in your project, confirm what it detected, answer four questions, and it hands the work to your local coding agent (Claude Code, Codex, or Cursor) through the versioned [Straddle skills](https://github.com/straddle-build/skills). Every integration instruction lives in those skills. The Wizard detects, asks, checks readiness, starts the skill in your agent, and reports what it observed.

## Status

- No tagged Straddle plugin release exists yet. The Wizard uses the merged skills source, `straddle-build/skills` at `4bb8afe20b72448e0f1b12a42257075a5d53e26b` (plugin `0.1.0`), and labels it "merged-source snapshot … not a tagged release" everywhere it appears.
- The npm package is not published yet. `.github/workflows/release.yml` publishes it with npm provenance when a GitHub release is published.

## Requirements

- Node.js 22.18 or later, and Git.
- Claude Code or Codex on `PATH` for automated handoff. Cursor always gets a manual handoff.

## Skills bundle

The Wizard needs the pinned skills snapshot on your machine. It checks every bundle by content: the SHA-256 of the plugin's runtime files (`plugin.json`, `mcp.json`, the three client manifests, `assets/`, `skills/`, `references/`, `third_party/`, `LICENSE`, `README.md`) must equal the digest of that commit, and the bundle's top level may hold nothing else except the commit's own non-plugin files (`docs/`, `evals/`, `fixtures/`, `scripts/`, `tests/`, `.github/`, `.gitignore`, `.markdownlint-cli2.jsonc`), the kit release metadata in `kit/`, Claude Code's cache bookkeeping (`.in_use/`, `.orphaned_at`), and `.git`. Anything else there, such as `hooks/`, `commands/`, `agents/` or `.mcp.json`, is something a client could load, so the bundle is rejected. It looks, in order, at:

1. `--bundle <path>` or `STRADDLE_WIZARD_BUNDLE`, when you pass one. Nothing else is tried.
2. The bundle the saved run last used.
3. Claude Code's `straddle` marketplace, when it holds the same content.
4. Its own snapshot in `${XDG_CACHE_HOME:-~/.cache}/straddle-wizard/skills-<commit>`.

When none matches, the Wizard shows the exact Git commands that fetch that commit from GitHub into its cache, and runs them only after you choose Fetch (or pass `--yes` to `install`, `update`, or `skill list`). It verifies the fetched content before using it and changes nothing else. `wizard status` never fetches.

## Guided run

```sh
cd your-project
npx @straddlecom/wizard
```

1. **Context.** The Wizard shows the directory, detected language, framework, any Straddle SDK and other payment providers, and the program it will run. Choose Continue, Change detected context, Privacy and data, or Cancel. Detected values are suggestions; corrected values are marked "(you)".
2. **Choices.** It asks what you want to build (charges, payouts, or both), direct, SaaS, or marketplace, which SDK, and which notification path (webhook, FIFO, or polling endpoint). It never infers these from the framework. "Not decided yet" leaves the question to the skill.
3. **Agent.** Pick an installed agent, or pass `--client`. The menu labels how much progress the Wizard can see for each: Claude Code progress is observed through hooks, Codex progress is unverified, and Cursor is a manual handoff.
4. **Readiness.** The Wizard finds or fetches the skills bundle, then checks the agent binary and login, the Straddle plugin, the API MCP credential route, `STRADDLE_API_KEY` (presence only), and the declared environment. Claude Code sessions always load the verified bundle with `claude --plugin-dir`, so nothing needs installing. Codex loads its own installed copy, so the Wizard checks that copy's content against the pinned snapshot, not just its version; when it differs or is missing, the Wizard prints the exact native install or update commands and runs them only when you choose to.
5. **Steps.** The default program runs Setup, Plan, Integrate, and Test. Each step opens your agent in the same terminal with `/straddle:<skill>`, followed by the language and framework you confirmed (marked detected or corrected) and your choices. Answer its questions and approve or deny its actions there; choosing Start in the Wizard is not approval of anything. Exit the agent when the skill prints its handoff. Integrate and Test run only an approved plan: `Plan state: Approved` in `straddle-integration-plan.md` (or, for Test, `straddle-migration-plan.md`), or your approval of the current plan in that step's own session. Each step is a fresh session, so an approval given in an earlier one, including Plan's, does not carry over; the Wizard shows the plan and this rule before both steps. When Integrate or Test stops because the plan is not approved, approve the current plan there and ask the agent to continue.
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
| `wizard install`, `update`, `remove` | Installs, updates, or removes the Straddle plugin with the client's own plugin commands. Install and update succeed only when the copy the client loads matches the pinned snapshot, and never replace a `straddle` marketplace registered from another place. |
| `wizard mcp add`, `mcp remove` | Registers or removes only `straddle-api` and `straddle-docs` with the client's own MCP commands. |
| `wizard status` | Bundle, clients, plugin and MCP state, key presence, environment, and the saved run. |

Options: `--dir <path>`, `--client claude|codex|cursor` (for guided runs, `resume`, and configuration commands), `--bundle <path>` (or `STRADDLE_WIZARD_BUNDLE`), `--exclude <glob>` (repeatable, or `STRADDLE_WIZARD_EXCLUDE=a,b`), `--yes` for fetching the skills and for configuration commands, and `--json` for `status` and `skill list`.

`wizard audit` runs the `straddle-audit` skill and prints the findings table from `straddle-audit-report.md`, with `file:line` and confidence for each finding. There is no `diagnose` command.

## Guarantees

- **No code edit before the plan.** Integrate and Test do not start until `straddle-integration-plan.md` (or, for Test, `straddle-migration-plan.md`) exists. In Claude Code, a per-session hook also denies the file-edit tools (Edit, Write, MultiEdit, NotebookEdit) on repository files until the plan exists. It does not cover shell commands that write files, which Claude Code's own permission prompts cover unless a managed policy allows them. Codex sessions get no such hook; the skill's own instructions and Codex's approval prompts apply there.
- **No Straddle request without configuration.** A missing `STRADDLE_API_KEY`, an environment other than Sandbox, or a `STRADDLE_BASE_URL` that disagrees with `STRADDLE_ENVIRONMENT` is shown as a configuration error before any step that can send Straddle requests. `STRADDLE_BASE_URL` is treated as the target when it is set, as the Straddle CLI and SDKs do. The run stops before sending any Straddle request; set the values in your shell and resume. The Wizard checks only these shell variables, not a saved Straddle CLI login.
- **No secrets.** The Wizard reads dependency manifests and file names in the selected repository, and hashes other files locally to report which ones changed. It never opens `.env*` files, keys, certificates, credential or CLI configuration files, or paths you pass with `--exclude`, and it does not follow symlinks. The same rules apply when it shows the plan or the audit report: a symlinked or excluded one is not opened. Directories it cannot read are skipped and named. It never reads, stores, or prints your API key; set it in your own shell.
- **No stored or inherited approval.** `.straddle-wizard/receipt.json` records the program, agent, context, choices, bundle identity, state (`ready`, `running`, `blocked`, `aborted`, `completed`), observed events, and reported markers. It has no approval field, and the Wizard treats it as untrusted input: a receipt whose run id, program, agent, step or choices are not the Wizard's own is set aside, not used. A resumed step starts a fresh agent session that asks for approval again. Claude Code sessions start with `--setting-sources ''` and a per-session `--settings` file whose default permission mode is `default`, so your user and project allow rules, deny rules, hooks, other plugins, and auto or accept-edits mode do not apply. Your organization's managed policy still applies and can allow edits, commands or MCP calls without a prompt; the Wizard does not read it, so its readiness screen does not promise a prompt. OAuth or keychain login keeps working; authentication configured in settings (`apiKeyHelper`, an `env` block for Bedrock or Vertex) does not apply in these sessions. Codex sessions start with `--sandbox workspace-write --ask-for-approval on-request`, which override a `danger-full-access` sandbox or `never` approval default for that session; the rest of your Codex configuration, including hooks, MCP servers and other plugins, still applies.
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
export STRADDLE_SKILLS_SOURCE=/path/to/straddle-skills   # checkout of straddle-build/skills at 4bb8afe
npm run typecheck
npm test
npm run build
```

Tests drive the real CLI against the real pinned bundle. Claude Code is replaced by a scripted process in `tests/fixtures/fake-claude.mjs`, so the test suite is simulated-adapter evidence, not native-client proof.
