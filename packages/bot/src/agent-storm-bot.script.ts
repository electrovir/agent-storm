#!/usr/bin/env node

/**
 * Node can't run this package's TypeScript source on its own, since its imports name the `.js`
 * files of the published build. Running from source, as in agent-storm's own checkout, goes through
 * tsx instead.
 */
if (import.meta.filename.endsWith('.ts')) {
    const {register} = await import('tsx/esm/api');
    register();
}

const {runAgentStormBotCli} = await import('./agent-storm-bot-cli.js');
await runAgentStormBotCli(import.meta);
