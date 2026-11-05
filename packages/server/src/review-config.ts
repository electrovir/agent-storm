import {reviewConfigShape, type ReviewConfig} from '@agent-storm/common';
import {PromiseQueue} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {parseJsonWithShape} from 'object-shape-tester';
import {reviewConfigPath} from './file-paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

/** A missing file is the default config. A malformed one throws rather than being replaced. */
export async function loadReviewConfig(): Promise<ReviewConfig> {
    const contents = await readFileIfExists(reviewConfigPath);
    /** The shape hands out one shared default object, so its array isn't given to callers. */
    return contents == undefined
        ? {
              ...reviewConfigShape.default,
              repos: [],
          }
        : parseJsonWithShape(contents, reviewConfigShape);
}

const reviewConfigWriteQueue = new PromiseQueue();

export async function saveReviewConfig(config: Readonly<ReviewConfig>) {
    await reviewConfigWriteQueue.add(async () => {
        await writeFileAtomically({
            path: reviewConfigPath,
            contents: JSON.stringify(config, undefined, 4),
        });
    });
}
