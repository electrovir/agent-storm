# @agent-storm/bot

Bots that run on a schedule, do their routine work in plain scripts, and only call an AI model when a step needs judgment. They run inside [Agent Storm](https://github.com/electrovir/agent-storm)'s Bots tab or on their own: from a terminal, a cron job, or a deployed container.

## Install

Install it at the root of the repo the bots live in. Agent Storm runs `npx --no -- agent-storm-bot` from there, so a copy nested in a workspace package won't be found.

```sh
npm i -D @agent-storm/bot @agent-storm/config
```

## Usage

Add bots to the repo's `.agent-storm/agent-storm.config.ts` (or `.js`, `.json`, `.yaml`, `.toml`), the same file Agent Storm reads the repo's folder settings from (see [`@agent-storm/config`](https://www.npmjs.com/package/@agent-storm/config)). Each key under `bots` is a bot's name (letters, digits, and dashes).

```TypeScript
import {BotAiEffort, BotAiProvider, defineBot} from '@agent-storm/bot';
import {defineAgentStormConfig} from '@agent-storm/config';

export default defineAgentStormConfig({
    bots: {
        'triage-alerts': defineBot({
            description: 'Triages new Sentry alerts posted in Slack.',
            interval: {
                minutes: 5,
            },
            ai: {
                provider: BotAiProvider.Codex,
                model: 'gpt-6-luna',
                effort: BotAiEffort.High,
            },
            async execute({agentStorm, run}) {
                const alerts = await readNewAlerts();
                if (!alerts.length) {
                    /** No AI this run. */
                    return undefined;
                }
                await run.report(`Found ${alerts.length} new alerts.`);
                return {
                    skill: 'triage-alerts',
                };
            },
        }),
        /**
         * A JSON, YAML, or TOML config lists bots this way: a module, relative to the config file,
         * whose default export is the bot.
         */
        release: '../packages/bots/src/release.bot.ts',
    },
});
```

`execute` is either a fixed `{prompt}` or `{skill}` that runs every time, or a setup function that does the scripted part and returns one only when the AI is needed. After an AI run, the setup function runs again (a couple of times at most) so it can act on what the AI left behind, such as a result file the prompt told it to write. A run that doesn't report anything, run AI, or ask something of Agent Storm (a question, thread, worktree, or notification) shows up in the Bots tab's history as "Nothing to do".

Each follow-up pass gets `run.aiStatus`: how the AI run before it ended. Besides finishing or failing, Agent Storm may have stopped it at one of the bot's `limits`: `maxAiRunDuration` caps each AI run, and `maxSpendPerDayUsd` caps what the bot's AI runs and the threads it starts cost over any 24 hours (which needs the Usage plugin). The Bots tab can override either. An AI run's `cwd` points it at a folder other than the repo root, and `isUnattended` declines every approval and question it raises instead of waiting on the user.

### Talking to Agent Storm

The `agentStorm` client handed to `execute` can ask the user a question, start a sidebar thread for the user to pick up, make a worktree, send a notification, or read when the user last used Agent Storm. `agentStorm.isInAgentStorm` says which world the bot is in.

Outside Agent Storm there's nobody to answer, so the config's `standalone` policy (or a bot's own, which wins) decides what those calls do instead of letting them crash:

| Call          | Options (`StandaloneQuestion` / `StandaloneThread`)                                                     | Default  |
| ------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `askQuestion` | `Ignore` (answers `undefined`), `FirstOption`, `Terminal` (prompts when a terminal is attached), `Fail` | `Ignore` |
| `startThread` | `Ignore`, `RunHeadless` (runs the prompt once through the agent CLI and waits), `Fail`                  | `Ignore` |

`createWorktree` still makes the worktree, with `git worktree add` beside the checkout, and `notify` just logs.

### Running in Agent Storm

Open the Bots tab. Nothing in a repo runs until you approve its config file, and editing that file or a bot file it names by path needs approving again. Each bot then gets an on/off switch, an interval, a model and API key override, a "Run now" button, its own shell tab where its runs print, its own AI Chat tab that every AI run is sent to, and a run history.

### Running on its own

```sh
npx -- agent-storm-bot triage-alerts
```

That runs the bot, waits out its interval, and runs it again until the process is stopped, which is what a long-running container (such as an ECS service) wants. Pass `--once` for a single run that exits, which is what a scheduled task (cron, EventBridge, a CI schedule) wants.

```sh
npx -- agent-storm-bot --once --provider claude --model claude-opus-5-5 triage-alerts --some-bot-arg
```

-   The `--` keeps npm from claiming the flags.
-   This command's own flags go before the bot's name. Everything after the name goes to the bot's `args`.
-   `--provider`, `--model`, and `--effort` override the bot's `ai`.
-   `--list` prints every bot in the config as JSON.
-   The bot exits with code 1 when its run fails.

The model runs through the `claude` or `codex` CLI, which must be installed and logged in (or given `ANTHROPIC_API_KEY` / `CODEX_API_KEY`) wherever the bot runs.
