import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {isReviewablePath} from './push-review.js';

describe(isReviewablePath.name, () => {
    it('skips test files and test baselines', () => {
        assert.deepEquals(
            [
                'packages/server/src/watch-mode.test.ts',
                'packages/frontend/src/ui/my-page.element-5.test.e2e.ts',
                'src/widget.spec.tsx',
                'packages/e2e/screenshots/ui/my-page.element.test.e2e.ts-screenshots/case/menu.png',
                'src/__snapshots__/widget.test.ts.snap',
            ].map(isReviewablePath),
            [
                false,
                false,
                false,
                false,
                false,
            ],
        );
    });

    it('keeps source files whose names only resemble tests', () => {
        assert.deepEquals(
            [
                'packages/server/src/watch-mode.ts',
                'src/test-util/mock-user.ts',
                'src/contest.ts',
                'docs/screenshots.md',
            ].map(isReviewablePath),
            [
                true,
                true,
                true,
                true,
            ],
        );
    });
});
