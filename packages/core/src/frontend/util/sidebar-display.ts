import {PaneStatus, PrStatus, type ReviewQueuePr} from '@agent-storm/common';
import {html} from 'element-vir';
import {
    createColoredIcon,
    createSizedIcon,
    LucideCheckIcon,
    LucideHourglassIcon,
    LucideLoaderIcon,
    LucideMinusIcon,
    LucideXIcon,
    Ring016Icon,
    Ring116Icon,
    Ring216Icon,
    Ring316Icon,
    Ring416Icon,
    Ring4Dot16Icon,
    tooltip,
    type TooltipOptions,
    ViraIcon,
    type ViraIconSvg,
    viraThemeByKeys,
    ViraThemeColorName,
} from 'vira';

const paneBusyIcon = createSizedIcon(LucideLoaderIcon, 12);
const paneIdleIcon = createSizedIcon(LucideMinusIcon, 12);
const paneExitedIcon = createSizedIcon(LucideXIcon, 12);
const paneStalledIcon = createSizedIcon(LucideHourglassIcon, 12);
const mergedCheckIcon = createColoredIcon(createSizedIcon(LucideCheckIcon, 14), {
    'vira-icon-stroke-color': viraThemeByKeys.green.foreground.header.foreground.value,
});

/** Every sidebar tooltip's hover delay, much shorter than the browser's own `title` delay. */
export const sidebarTooltipOptions: TooltipOptions = {
    delay: {
        milliseconds: 150,
    },
};

function createPrRingIcon(icon: Readonly<ViraIconSvg>, fill: ViraThemeColorName) {
    return createColoredIcon(icon, {
        'vira-icon-stroke-color': viraThemeByKeys.grey.foreground.decoration.foreground.value,
        'vira-icon-fill-color': viraThemeByKeys[fill].foreground.header.foreground.value,
    });
}

export const prStatusIcons: Record<PrStatus, ViraIconSvg | undefined> = {
    [PrStatus.None]: undefined,
    [PrStatus.AwaitingReview]: createPrRingIcon(Ring116Icon, ViraThemeColorName.yellow),
    [PrStatus.ReviewStarted]: createPrRingIcon(Ring116Icon, ViraThemeColorName.green),
    [PrStatus.ReReviewRequested]: createPrRingIcon(Ring116Icon, ViraThemeColorName.red),
    [PrStatus.UnresolvedComments]: createPrRingIcon(Ring216Icon, ViraThemeColorName.yellow),
    [PrStatus.ChangesRequested]: createPrRingIcon(Ring316Icon, ViraThemeColorName.red),
    [PrStatus.OthersRequestedChanges]: createPrRingIcon(Ring216Icon, ViraThemeColorName.red),
    [PrStatus.Approved]: createPrRingIcon(Ring316Icon, ViraThemeColorName.green),
    [PrStatus.AwaitingOtherReviews]: createPrRingIcon(Ring416Icon, ViraThemeColorName.yellow),
    [PrStatus.ChecksFailed]: createPrRingIcon(Ring416Icon, ViraThemeColorName.red),
    [PrStatus.ReadyToMerge]: createPrRingIcon(Ring4Dot16Icon, ViraThemeColorName.green),
    [PrStatus.Merged]: mergedCheckIcon,
    [PrStatus.Closed]: undefined,
};

/** Shown in place of a PR status that has no icon of its own. */
export const localChangesIcon = createPrRingIcon(Ring016Icon, ViraThemeColorName.grey);
export const localChangesTooltip = 'Has uncommitted or not pushed changes.';

export const prStatusTooltips: Record<PrStatus, string> = {
    [PrStatus.None]: '',
    [PrStatus.AwaitingReview]: 'PR awaiting your review.',
    [PrStatus.ReviewStarted]: 'You started reviewing this PR.',
    [PrStatus.ReReviewRequested]: 'You requested changes, and the PR awaits your review again.',
    [PrStatus.UnresolvedComments]: 'PR has unresolved comments.',
    [PrStatus.ChangesRequested]: 'You requested changes on this PR.',
    [PrStatus.OthersRequestedChanges]: 'Someone else requested changes on this PR.',
    [PrStatus.Approved]: 'You approved this PR.',
    [PrStatus.AwaitingOtherReviews]: 'PR is waiting on other reviews.',
    [PrStatus.ChecksFailed]: 'PR checks failed.',
    [PrStatus.ReadyToMerge]: 'PR is ready to merge.',
    [PrStatus.Merged]: 'PR was merged.',
    [PrStatus.Closed]: 'PR was closed without merging.',
};

const paneStatusColor: Record<PaneStatus, string> = {
    [PaneStatus.None]: String(viraThemeByKeys.grey.foreground.decoration.foreground.value),
    [PaneStatus.Busy]: String(viraThemeByKeys.pink.foreground.header.foreground.value),
    [PaneStatus.Stalled]: String(viraThemeByKeys.yellow.foreground.header.foreground.value),
    [PaneStatus.Idle]: String(viraThemeByKeys.grey.foreground.header.foreground.value),
    [PaneStatus.Exited]: String(viraThemeByKeys.red.foreground.header.foreground.value),
};

const paneStatusIcon: Record<PaneStatus, ViraIconSvg> = {
    [PaneStatus.None]: paneIdleIcon,
    [PaneStatus.Busy]: paneBusyIcon,
    [PaneStatus.Stalled]: paneStalledIcon,
    [PaneStatus.Idle]: paneIdleIcon,
    [PaneStatus.Exited]: paneExitedIcon,
};

/** Expects the rendering element's styles to define the `.chip` class. */
export function renderPaneChip(label: string, status: PaneStatus) {
    if (status === PaneStatus.None) {
        return html`
            <span class="chip" ${tooltip(`${label} pane: ${status}`, sidebarTooltipOptions)}></span>
        `;
    }
    const icon = paneStatusIcon[status];
    return html`
        <span
            class="chip"
            ?data-busy=${status === PaneStatus.Busy}
            style="color: ${paneStatusColor[status]};"
            ${tooltip(`${label} pane: ${status}`, sidebarTooltipOptions)}
        >
            <${ViraIcon.assign({
                icon,
            })}></${ViraIcon}>
        </span>
    `;
}

export type ReviewedRepo = Pick<ReviewQueuePr, 'owner' | 'repoName'>;

export function toRepoKey({owner, repoName}: Readonly<ReviewedRepo>) {
    return `${owner}/${repoName}`;
}
