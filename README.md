# Straddle Wizard

Set up a Straddle integration in your project with Claude Code, Codex, or Cursor. Straddle Wizard checks your project and tools, then guides your coding agent through setup, planning, implementation, sandbox testing, and production readiness.

The integration instructions come from the versioned [Straddle plugin](https://github.com/straddle-build/skills). Wizard selects a compatible plugin release and resumes work from the plans and reports saved in your project.

## Install

Use Node.js 22.18 or later, which includes npm and npx. Check the available commands without starting an integration:

```sh
npx @straddlecom/wizard@latest --help
```

The output starts with `Straddle Wizard` and lists the guided run, individual tasks, and options. To install the `wizard` command globally:

```sh
npm install -g @straddlecom/wizard
wizard --version
```

Wizard includes the Straddle CLI on supported macOS, Linux, and Windows systems through npm's optional platform packages. Keep optional dependencies enabled. See [CLI installation and recovery](docs/usage.md#use-the-bundled-cli) if Wizard reports a missing binary.

## Start an integration

Open a terminal in the project where you want to add Straddle:

```sh
cd your-project
npx @straddlecom/wizard@latest
```

The guided run takes you through the following steps:

1. Confirm the detected language, framework, and existing payment providers.
2. Choose charges, payouts, or both; your integration type; an SDK; and a notification method. Leave a choice undecided if you need help during planning.
3. Choose your coding agent and Auto or Manual mode.
4. Review the plugin download and any setup commands Wizard proposes.
5. Work with your agent to approve the integration plan, implement it, test it in sandbox, and check production readiness.

The agent saves `straddle-integration-plan.md` and the step reports in your project. When Wizard detects an existing payment provider, it adds a migration step after planning. Each sandbox write requires a preview and approval in the agent session.

Planning can begin before you have an API key. Before implementation or testing sends Straddle requests, set a sandbox key from the [Straddle dashboard](https://dashboard.straddle.com) and declare the sandbox environment. In Bash or Zsh, replace the placeholder with your key:

```sh
export STRADDLE_API_KEY="YOUR_SANDBOX_API_KEY"
export STRADDLE_ENVIRONMENT=sandbox
```

Wizard reads the key from these shell variables, including when the CLI already has a saved token. For PowerShell and base URL configuration, see [Configure sandbox requests](docs/usage.md#configure-sandbox-requests).

## Choose how your agent runs

Auto starts your installed agent in the current terminal. Manual prints the message and setup steps for you to use in your own agent.

| Agent | Auto prerequisite | Progress in Auto |
| --- | --- | --- |
| Claude Code | `claude` on `PATH`, signed in | Checklist in the terminal status line |
| Codex | `codex` on `PATH`, signed in | Checklist on a local browser page |
| Cursor | `cursor-agent` on `PATH`, signed in | Saved reports after the session ends |

Manual also works when the agent is available only in an app. Choose the agent and mode at the prompts, or set them explicitly:

```sh
npx @straddlecom/wizard@latest --client codex --mode auto
```

Your agent uses its configured permissions. Wizard asks before running plugin or MCP configuration commands. See [Configure an agent](docs/usage.md#configure-an-agent) for the client-specific setup.

## Resume work

Check the saved run or continue from its first unfinished step:

```sh
npx @straddlecom/wizard@latest status
npx @straddlecom/wizard@latest resume
```

In Auto, Wizard reopens the previous session when its session ID is available. In Manual, it prints the next message to paste. The plan and report files determine where work resumes. Editing an approved plan requires approval again and makes reports for the earlier plan out of date.

To inspect a recorded session, open its local log:

```sh
npx @straddlecom/wizard@latest log
```

See [Resume and inspect a run](docs/usage.md#resume-and-inspect-a-run) for completion rules, fresh starts, and saved files.

## Run one task

Use a focused command when you already know the next step.

| Task | Command |
| --- | --- |
| Check project setup | `wizard setup` |
| Choose an integration approach | `wizard get-started` |
| Write an integration plan | `wizard plan` |
| Add Straddle beside another provider | `wizard migrate` |
| Implement the approved plan | `wizard integrate` |
| Test the integration in sandbox | `wizard test` |
| Review production readiness | `wizard go-live` |
| Review an existing integration | `wizard audit` |

The table assumes a global installation. With npx, replace `wizard` with `npx @straddlecom/wizard@latest`. For example:

```sh
npx @straddlecom/wizard@latest plan
```

Use `wizard skill list` to inspect the selected bundle, or `wizard skill run straddle-setup` to invoke a skill by name. The [usage guide](docs/usage.md) covers command options, plugin updates, MCP configuration, and local bundle testing.

## Contribute

See [Develop and test Wizard](docs/usage.md#develop-and-test-wizard) for the build commands and required skills fixture. The source branch includes changes after npm release `0.1.2`; [source-only behavior](docs/usage.md#source-only-behavior) identifies those differences.

Report reproducible problems in [GitHub issues](https://github.com/straddle-build/wizard/issues). Licensed under [Apache-2.0](LICENSE).
