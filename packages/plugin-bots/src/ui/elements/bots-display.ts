import {RuntimeMode} from '@agent-storm/plugin-build/src/build-api.js';
import {html} from 'element-vir';
import {ViraColorVariant, ViraEmphasis, ViraSize, ViraTag} from 'vira';
import {BotConfigApproval, BotRunStatus, BotRunTrigger, BotState} from '../../bots-api.js';

type TagDisplay = Readonly<{
    text: string;
    color: ViraColorVariant;
}>;

export const botStateTags: Readonly<Record<BotState, TagDisplay>> = {
    [BotState.Off]: {
        text: 'Off',
        color: ViraColorVariant.Muted,
    },
    [BotState.Idle]: {
        text: 'Idle',
        color: ViraColorVariant.Neutral,
    },
    [BotState.Running]: {
        text: 'Running',
        color: ViraColorVariant.Info,
    },
    [BotState.Waiting]: {
        text: 'Waiting on you',
        color: ViraColorVariant.Warning,
    },
    [BotState.Failed]: {
        text: 'Failed',
        color: ViraColorVariant.Danger,
    },
};

export const runStatusTags: Readonly<Record<BotRunStatus, TagDisplay>> = {
    [BotRunStatus.Running]: {
        text: 'Running',
        color: ViraColorVariant.Info,
    },
    [BotRunStatus.Succeeded]: {
        text: 'Done',
        color: ViraColorVariant.Positive,
    },
    [BotRunStatus.NothingToDo]: {
        text: 'Nothing to do',
        color: ViraColorVariant.Neutral,
    },
    [BotRunStatus.Failed]: {
        text: 'Failed',
        color: ViraColorVariant.Danger,
    },
    [BotRunStatus.Interrupted]: {
        text: 'Interrupted',
        color: ViraColorVariant.Warning,
    },
};

export const approvalTags: Readonly<Record<BotConfigApproval, TagDisplay>> = {
    [BotConfigApproval.Approved]: {
        text: 'Approved',
        color: ViraColorVariant.Positive,
    },
    [BotConfigApproval.Unapproved]: {
        text: 'Needs approval',
        color: ViraColorVariant.Warning,
    },
    [BotConfigApproval.Changed]: {
        text: 'Changed',
        color: ViraColorVariant.Warning,
    },
};

export const runTriggerLabels: Readonly<Record<BotRunTrigger, string>> = {
    [BotRunTrigger.Schedule]: 'Scheduled',
    [BotRunTrigger.Manual]: 'Run now',
};

export const runtimeModeLabels: Readonly<Record<RuntimeMode, string>> = {
    [RuntimeMode.Supervised]: 'Ask before acting',
    [RuntimeMode.AutoAcceptEdits]: 'Accept edits',
    [RuntimeMode.Auto]: 'Auto',
    [RuntimeMode.FullAccess]: 'Full access',
};

export function renderTag({text, color}: TagDisplay) {
    return html`
        <${ViraTag.assign({
            text,
            color,
            size: ViraSize.Small,
            emphasis: ViraEmphasis.Subtle,
        })}></${ViraTag}>
    `;
}
