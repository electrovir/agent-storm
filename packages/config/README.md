# @agent-storm/config

The type, schema, and file path of a repo's [Agent Storm](https://github.com/electrovir/agent-storm) config.

## Install

```sh
npm i -D @agent-storm/config
```

## Usage

A repo's config lives in `.agent-storm/agent-storm.config.ts` (or `.js`, `.json`, `.yaml`, `.toml`). It holds the repo's folder settings and, at the repo root, its bots (see [`@agent-storm/bot`](https://www.npmjs.com/package/@agent-storm/bot)).

```TypeScript
import {defineAgentStormConfig} from '@agent-storm/config';

export default defineAgentStormConfig({
    reviewSkill: '/review-branch local',
    postWorktreeCmd: 'npm ci',
});
```

Agent Storm doesn't read a TS or JS config until you approve it in Settings, since reading it runs its code. A JSON, YAML, or TOML config applies right away, except for the commands it sets (`postWorktreeCmd` and `review.initCmd`), which also wait for approval.

## Read a folder's settings

`agent-storm-config` prints the folder settings that apply in the current folder as JSON, for tools that run without Agent Storm, such as Agent Storm's skills in plain Claude Code:

```sh
npx --yes --package=@agent-storm/config@latest agent-storm-config
```

```json
{
    "configPaths": ["/repo/.agent-storm/agent-storm.config.yaml"],
    "postWorktreeCmd": "npm ci",
    "reviewSkill": "/review-branch local",
    "skippedConfigPaths": []
}
```

Each setting comes from the nearest config file that sets it, and is empty when none does. It never runs a TS or JS config, since it has no way to ask for approval the way Agent Storm does. It lists those files in `skippedConfigPaths` instead. The commands it prints come from the repo unapproved, so show them to the user before running them.
