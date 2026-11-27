# @agent-storm/bot

Bots that run on a schedule, do their routine work in plain scripts, and only call an AI model when a step needs judgment. They run inside [Agent Storm](https://github.com/electrovir/agent-storm)'s Bots tab or on their own: from a terminal, a cron job, or a deployed container.

## Install

Install it at the root of the repo the bots live in. Agent Storm runs `npx --no -- agent-storm-bot` from there, so a copy nested in a workspace package won't be found.

```sh
npm i -D @agent-storm/bot
```

## Usage

Add an `agent-storm.config.ts` (or `.js`, `.json`, `.yaml`, `.toml`) at the repo root. Each key under `bots` is a bot's name (letters, digits, and dashes).

```TypeScript
import {BotAiEffort, BotAiProvider, defineAgentStormConfig, defineBot} from '@agent-storm/bot';

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
        /** A JSON, YAML, or TOML config lists bots this way: a module whose default export is the bot. */
        release: './packages/bots/src/release.bot.ts',
    },
});
```

`execute` is either a fixed `{prompt}` or `{skill}` that runs every time, or a setup function that does the scripted part and returns one only when the AI is needed. After an AI run, the setup function runs again (a couple of times at most) so it can act on what the AI left behind, such as a result file the prompt told it to write. A run that neither reports anything nor runs AI shows up in the Bots tab's history as "Nothing to do".

### Talking to Agent Storm

The `agentStorm` client handed to `execute` can ask the user a question, start a sidebar thread for the user to pick up, make a worktree, or send a notification. `agentStorm.isInAgentStorm` says which world the bot is in.

Outside Agent Storm there's nobody to answer, so the config's `standalone` policy (or a bot's own, which wins) decides what those calls do instead of letting them crash:

| Call          | Options (`StandaloneQuestion` / `StandaloneThread`)                                                     | Default  |
| ------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `askQuestion` | `Ignore` (answers `undefined`), `FirstOption`, `Terminal` (prompts when a terminal is attached), `Fail` | `Ignore` |
| `startThread` | `Ignore`, `RunHeadless` (runs the prompt once through the agent CLI and waits), `Fail`                  | `Ignore` |

`createWorktree` still makes the worktree, with `git worktree add` beside the checkout, and `notify` just logs.

### Running in Agent Storm

Open the Bots tab. Nothing in a repo runs until you approve its config file, and an edited file needs approving again. Each bot then gets an on/off switch, an interval, a model and API key override, a "Run now" button, its own shell tab where its runs print, an AI Chat tab per AI run, and a run history.

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
