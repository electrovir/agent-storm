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
