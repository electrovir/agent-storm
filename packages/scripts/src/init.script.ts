import {nodePtyPrebuildsDir} from '@agent-storm/server/src/file-paths.js';
import {makeSpawnHelpersExecutable} from 'agent-storm';

await makeSpawnHelpersExecutable(nodePtyPrebuildsDir);
