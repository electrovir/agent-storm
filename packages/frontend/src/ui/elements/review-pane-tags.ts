import {GitHubReviewState} from '@agent-storm/common';
import {html} from 'element-vir';
import {ViraEmphasis, ViraSize, ViraTag, type ViraThemeColorName} from 'vira';

export const reviewStateLabels: Record<GitHubReviewState, string> = {
    [GitHubReviewState.Approved]: 'Approved',
    [GitHubReviewState.ChangesRequested]: 'Changes requested',
    [GitHubReviewState.Commented]: 'Commented',
    [GitHubReviewState.Dismissed]: 'Dismissed',
    [GitHubReviewState.Pending]: 'Pending',
};

export function renderTag(text: string, color: ViraThemeColorName) {
    return html`
        <${ViraTag.assign({
            text,
            color,
            size: ViraSize.Small,
            emphasis: ViraEmphasis.Subtle,
        })}></${ViraTag}>
    `;
}
