#!/usr/bin/env node

/**
 * Prints, as JSON, the folder settings that apply in the current folder, for tools that run without
 * Agent Storm.
 *
 * Tsx loads this package's own TypeScript source when it runs from source.
 */
const {register} = await import('tsx/esm/api');
register();

const {resolveAgentStormConfig} = await import('./resolve-agent-storm-config.js');
process.stdout.write(
    `${JSON.stringify(await resolveAgentStormConfig(process.cwd()), undefined, 4)}\n`,
);
