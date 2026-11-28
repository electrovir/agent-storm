import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {claudePluginDir, claudePluginName} from './agent-storm-skills.js';

describe('claudePluginName', () => {
    it("matches the plugin's manifest", async () => {
        const manifest: unknown = JSON.parse(
            await readFile(join(claudePluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
        );
        assert.hasKey(manifest, 'name');
        assert.strictEquals(manifest.name, claudePluginName);
    });
});
