import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {readReviewExplanations} from './review-explanations.js';
import {setReviewHost} from './review-host.js';
import {testReviewHost} from './review-host.mock.js';

const exec = promisify(execFile);

setReviewHost(testReviewHost);

async function withRepo(branch: string, callback: (folder: string) => Promise<void>) {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'review-explanations-')));
    try {
        await exec('git', [
            'init',
            '--quiet',
            `--initial-branch=${branch}`,
            folder,
        ]);
        await callback(folder);
    } finally {
        await rm(folder, {
            recursive: true,
            force: true,
        });
    }
}

describe(readReviewExplanations.name, () => {
    it("reads the explanations the skill wrote for the checked-out review's head branch", async () => {
        await withRepo('review__feature/one', async (folder) => {
            const explanations = {
                'src/a.ts': 'Adds the parser.\n\nThe CLI calls it.',
            };
            await writeFile(
                join(folder, '.git', 'reviewer-review-explanations-feature-one.json'),
                JSON.stringify(explanations),
            );
            await writeFile(
                join(folder, '.git', 'reviewer-review-explanations-feature-two.json'),
                JSON.stringify({
                    'src/b.ts': 'Another review.',
                }),
            );
            assert.deepEquals(await readReviewExplanations(folder), explanations);
        });
    });
    it('answers with none off a review branch or for a malformed file', async () => {
        await withRepo('feature/one', async (folder) => {
            await writeFile(
                join(folder, '.git', 'reviewer-review-explanations-feature-one.json'),
                JSON.stringify({
                    'src/a.ts': 'Off the review branch.',
                }),
            );
            assert.deepEquals(await readReviewExplanations(folder), {});
        });
        await withRepo('review__feature/one', async (folder) => {
            await writeFile(
                join(folder, '.git', 'reviewer-review-explanations-feature-one.json'),
                JSON.stringify({
                    'src/a.ts': 1,
                }),
            );
            assert.deepEquals(await readReviewExplanations(folder), {});
        });
    });
});
