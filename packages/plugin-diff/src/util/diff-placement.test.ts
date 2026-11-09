import {
    diffPaneId,
    PaneKind,
    PaneStatus,
    PrStatus,
    reviewPaneId,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {
    createDefaultTabLayout,
    listGroupIds,
    type PaneGroupExtensionInputs,
} from '@agent-storm/core/frontend';
import {createReviewExtensionInputs, reviewPane} from '@agent-storm/plugin-review';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {findDiffPlacement} from './diff-placement.js';

const pullRequest: ReviewQueuePr = {
    owner: 'acme',
    repoName: 'widgets',
    number: 1,
    title: 'A change',
    titleHtml: 'A change',
    url: 'https://example.com/acme/widgets/pull/1',
    bodyHtml: '',
    branchName: 'feature',
    headSha: 'abc123',
    isDraft: false,
    chainDepth: 0,
    prStatus: PrStatus.None,
    isViewerAuthor: false,
    isAwaitingViewerReview: true,
    hasViewerReviewed: false,
    panes: {
        [PaneKind.Ai]: PaneStatus.None,
        [PaneKind.Shell]: PaneStatus.None,
    },
    author: 'someone',
    authorAvatarUrl: '',
    isAuthorTrusted: true,
    assignees: [],
};

function createSession(id: string) {
    return {
        id,
        name: '',
        aiId: '',
        conversationId: '',
        isNewConversation: false,
    };
}

/** The Diff and Review tabs' placement, as the registered panes declare it. */
function listFolderGroupTabs(extensionInputs: PaneGroupExtensionInputs) {
    const layout = createDefaultTabLayout({
        sessions: {
            [PaneKind.Ai]: [
                createSession('ai1'),
                createSession('ai2'),
            ],
            [PaneKind.Shell]: [
                createSession('sh1'),
            ],
        },
        panes: [
            {
                id: diffPaneId,
                defaultPlacement: findDiffPlacement,
            },
            reviewPane,
        ],
        extensionInputs,
    });
    return listGroupIds(layout).map((groupId) => layout.groups[groupId]?.tabIds);
}

describe('Diff and Review default placement', () => {
    it('puts both tabs at the ends of a Build folder', () => {
        assert.deepEquals(listFolderGroupTabs({}), [
            [
                'ai:ai1',
                'ai:ai2',
                diffPaneId,
            ],
            [
                'shell:sh1',
                reviewPaneId,
            ],
        ]);
    });
    it('puts both tabs at the starts of a review folder', () => {
        assert.deepEquals(listFolderGroupTabs(createReviewExtensionInputs(pullRequest)), [
            [
                diffPaneId,
                'ai:ai1',
                'ai:ai2',
            ],
            [
                reviewPaneId,
                'shell:sh1',
            ],
        ]);
    });
});
