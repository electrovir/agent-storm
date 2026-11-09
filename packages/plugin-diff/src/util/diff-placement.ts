import {PaneKind} from '@agent-storm/common';
import {DefaultTabPosition, type PaneGroupView} from '@agent-storm/core/frontend';
import {isReviewFolder} from '@agent-storm/plugin-review';

/** A review folder's Diff tab leads the AI group. A Build folder's trails it. */
export function findDiffPlacement(view: Readonly<Pick<PaneGroupView, 'extensionInputs'>>) {
    return {
        group: PaneKind.Ai,
        position: isReviewFolder(view) ? DefaultTabPosition.Start : DefaultTabPosition.End,
    };
}
