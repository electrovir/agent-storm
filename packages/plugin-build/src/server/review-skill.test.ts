import {defaultSettings} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveReviewSkill} from './review-skill.js';

const settings = {
    ...defaultSettings,
    reviewSkill: '/review',
    folderReviewSkills: [
        {
            folder: '/repos/app',
            reviewSkill: '/review-branch local',
        },
    ],
};

describe(resolveReviewSkill.name, () => {
    it('prefers the nearest folder settings file', () => {
        assert.strictEquals(
            resolveReviewSkill({
                folderLayers: [
                    {},
                    {
                        reviewSkill: '/review-branch remote',
                    },
                ],
                settings,
                repoPath: '/repos/app',
            }),
            '/review-branch remote',
        );
    });

    it("falls back to the repo's value, then the global one", () => {
        assert.deepEquals(
            [
                '/repos/app',
                '/repos/other',
            ].map((repoPath) => {
                return resolveReviewSkill({
                    folderLayers: [],
                    settings,
                    repoPath,
                });
            }),
            [
                '/review-branch local',
                '/review',
            ],
        );
    });
});
