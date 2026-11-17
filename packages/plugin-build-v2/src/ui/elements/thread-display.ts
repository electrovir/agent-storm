import {type CSSResult} from 'element-vir';
import {
    createSizedIcon,
    LucideBrainIcon,
    LucideCircleAlertIcon,
    LucideFilePenIcon,
    LucideInfoIcon,
    LucideListTodoIcon,
    LucideLoaderIcon,
    LucideMessageCircleQuestionMarkIcon,
    LucideMessageSquareIcon,
    LucideShieldAlertIcon,
    LucideShieldQuestionMarkIcon,
    LucideTerminalIcon,
    LucideWrenchIcon,
    viraThemeByKeys,
    type ViraIconSvg,
    type ViraThemeColorName,
} from 'vira';
import {
    ApprovalKind,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
    type ThreadItem,
} from '../../build-v2-api.js';

/** How a thread's status shows in the sidebar's dot and the chat header's pill. */
export const threadStatusDisplays: Record<
    ThreadStatus,
    Readonly<{
        label: string;
        dotColor: CSSResult;
        tagColor: ViraThemeColorName;
        isPulsing: boolean;
        /** Idle threads show no pill. */
        hasTag: boolean;
    }>
> = {
    [ThreadStatus.Idle]: {
        label: 'Idle',
        dotColor: viraThemeByKeys.grey.foreground.placeholder.foreground.value,
        tagColor: 'grey',
        isPulsing: false,
        hasTag: false,
    },
    [ThreadStatus.Running]: {
        label: 'Working',
        dotColor: viraThemeByKeys.blue.foreground.body.foreground.value,
        tagColor: 'blue',
        isPulsing: true,
        hasTag: true,
    },
    [ThreadStatus.NeedsApproval]: {
        label: 'Pending approval',
        dotColor: viraThemeByKeys.yellow.foreground.header.foreground.value,
        tagColor: 'yellow',
        isPulsing: false,
        hasTag: true,
    },
    [ThreadStatus.Failed]: {
        label: 'Failed',
        dotColor: viraThemeByKeys.red.foreground.body.foreground.value,
        tagColor: 'red',
        isPulsing: false,
        hasTag: true,
    },
};

export const approvalKindLabels: Record<ApprovalKind, string> = {
    [ApprovalKind.Command]: 'Command approval',
    [ApprovalKind.FileChange]: 'File change approval',
    [ApprovalKind.Permission]: 'Permission approval',
    [ApprovalKind.Question]: 'Question',
};

export const approvalKindIcons: Record<ApprovalKind, ViraIconSvg> = {
    [ApprovalKind.Command]: LucideTerminalIcon,
    [ApprovalKind.FileChange]: LucideFilePenIcon,
    [ApprovalKind.Permission]: LucideShieldAlertIcon,
    [ApprovalKind.Question]: LucideMessageCircleQuestionMarkIcon,
};

function describeWithVerbs(verbs: Readonly<Record<ThreadItemStatus, string>>, fallback: string) {
    return (item: Readonly<ThreadItem>) => {
        return [
            verbs[item.status],
            item.title || fallback,
        ].join(' ');
    };
}

/** How each kind of thread item shows as a row of a work log. */
export const workItemDisplays: Record<
    ThreadItemKind,
    Readonly<{
        icon: ViraIconSvg;
        describe(item: Readonly<ThreadItem>): string;
        /** Whether the expanded body is Markdown rather than raw output. */
        isMarkdown: boolean;
    }>
> = {
    [ThreadItemKind.UserMessage]: {
        icon: LucideMessageSquareIcon,
        describe(item) {
            return item.title || 'Message';
        },
        isMarkdown: true,
    },
    [ThreadItemKind.AssistantMessage]: {
        icon: LucideMessageSquareIcon,
        describe(item) {
            return item.title || 'Response';
        },
        isMarkdown: true,
    },
    [ThreadItemKind.Notice]: {
        icon: LucideInfoIcon,
        describe(item) {
            return item.title || 'Notice';
        },
        isMarkdown: true,
    },
    [ThreadItemKind.Reasoning]: {
        icon: LucideBrainIcon,
        describe(item) {
            return item.status === ThreadItemStatus.InProgress ? 'Thinking' : 'Thought';
        },
        isMarkdown: true,
    },
    [ThreadItemKind.Plan]: {
        icon: LucideListTodoIcon,
        describe(item) {
            return item.title || 'Plan';
        },
        isMarkdown: true,
    },
    [ThreadItemKind.Command]: {
        icon: LucideTerminalIcon,
        describe: describeWithVerbs(
            {
                [ThreadItemStatus.InProgress]: 'Running',
                [ThreadItemStatus.Completed]: 'Ran',
                [ThreadItemStatus.Failed]: 'Failed',
                [ThreadItemStatus.Declined]: 'Declined',
            },
            'a command',
        ),
        isMarkdown: false,
    },
    [ThreadItemKind.FileChange]: {
        icon: LucideFilePenIcon,
        describe: describeWithVerbs(
            {
                [ThreadItemStatus.InProgress]: 'Editing',
                [ThreadItemStatus.Completed]: 'Edited',
                [ThreadItemStatus.Failed]: 'Failed to edit',
                [ThreadItemStatus.Declined]: 'Declined edit to',
            },
            'files',
        ),
        isMarkdown: false,
    },
    [ThreadItemKind.ToolCall]: {
        icon: LucideWrenchIcon,
        describe: describeWithVerbs(
            {
                [ThreadItemStatus.InProgress]: 'Calling',
                [ThreadItemStatus.Completed]: 'Called',
                [ThreadItemStatus.Failed]: 'Failed',
                [ThreadItemStatus.Declined]: 'Declined',
            },
            'a tool',
        ),
        isMarkdown: false,
    },
};

const statusIconSize = 12;
const workingIcon = createSizedIcon(LucideLoaderIcon, statusIconSize);
const approvalIcon = createSizedIcon(LucideShieldQuestionMarkIcon, statusIconSize);
const failedIcon = createSizedIcon(LucideCircleAlertIcon, statusIconSize);

/** How a thread's status shows in its sidebar row and in its project's folder row. */
export const sidebarStatusDisplays: Record<
    ThreadStatus,
    Readonly<{
        /** Idle threads show their relative time instead. */
        status?: Readonly<{
            /** Icon-only statuses show no label. */
            label: string | undefined;
            /** Explains an icon-only status on hover. */
            tooltip: string | undefined;
            icon: ViraIconSvg;
            isSpinning: boolean;
            color: ViraThemeColorName;
        }>;
        /** Receded rows dim until hovered. */
        shouldRecede: boolean;
        /** The dot on a collapsed project folder. */
        folderDot?: Readonly<{
            color: ViraThemeColorName;
            /** Screen-reader text for the dot. */
            label: string;
        }>;
    }>
> = {
    [ThreadStatus.Idle]: {
        shouldRecede: true,
    },
    [ThreadStatus.Running]: {
        status: {
            label: undefined,
            tooltip: 'The AI is working on this thread.',
            icon: workingIcon,
            isSpinning: true,
            color: 'pink',
        },
        shouldRecede: true,
        folderDot: {
            color: 'blue',
            label: ', working',
        },
    },
    [ThreadStatus.NeedsApproval]: {
        status: {
            label: 'Approval',
            tooltip: undefined,
            icon: approvalIcon,
            isSpinning: false,
            color: 'yellow',
        },
        shouldRecede: true,
        folderDot: {
            color: 'yellow',
            label: ', needs you',
        },
    },
    [ThreadStatus.Failed]: {
        status: {
            label: 'Failed',
            tooltip: undefined,
            icon: failedIcon,
            isSpinning: false,
            color: 'red',
        },
        shouldRecede: false,
        folderDot: {
            color: 'red',
            label: ', failed',
        },
    },
};
