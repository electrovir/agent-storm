import {nodePtyPrebuildsDir} from '@agent-storm/server/src/file-paths.js';
import {makeSpawnHelpersExecutable} from 'agent-storm';
import {generateBuiltInPluginPrismaClients} from './built-in-plugin-build.js';

await Promise.all([
    makeSpawnHelpersExecutable(nodePtyPrebuildsDir),
    generateBuiltInPluginPrismaClients(),
]);
