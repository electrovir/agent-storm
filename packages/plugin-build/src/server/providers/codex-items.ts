// cspell:word ultrafast

import {UsageSpeed} from '@agent-storm/plugin-usage/src/usage-api.js';
import {check} from '@augment-vir/assert';
import {
    checkValidShape,
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    unknownShape,
    type Shape,
} from 'object-shape-tester';
import {ApprovalDecision, ThreadItemKind, ThreadItemStatus} from '../../build-api.js';
import {type ProviderItem, type ProviderUsage} from './provider-session.js';

type CodexItemDescription = Pick<ProviderItem, 'kind' | 'title' | 'text'>;

const codexItemBaseShape = defineShape({
    id: '',
    type: '',
    status: optionalShape(enumShape(ThreadItemStatus), {
        alsoUndefined: true,
    }),
});

function describeWith<const ItemShape extends Shape>(
    shape: ItemShape,
    describe: (item: ItemShape['runtimeType']) => CodexItemDescription,
) {
    return (item: unknown) => {
        return checkValidShape(item, shape, {
            allowExtraKeys: true,
        })
            ? describe(item)
            : undefined;
    };
}

function formatJson(value: unknown) {
    return value == undefined ? '' : JSON.stringify(value, undefined, 4);
}

/** An MCP tool result without its images' base64 data, which would bury the rest of its text. */
function omitMcpResultImageData(result: unknown) {
    return check.isObject(result) && check.isArray(result.content)
        ? {
              ...result,
              content: result.content.map((block) => {
                  return check.isObject(block) && block.type === 'image'
                      ? {
                            type: block.type,
                            mimeType: block.mimeType,
                        }
                      : block;
              }),
          }
        : result;
}

/**
 * How each Codex item type shows in a thread, keyed by the item's `type`. Codex has more types than
 * these (user messages, compaction markers); a thread leaves the rest out.
 */
const codexItemDescribers: Readonly<
    Record<string, (item: unknown) => CodexItemDescription | undefined>
> = {
    agentMessage: describeWith(
        defineShape({
            text: '',
        }),
        ({text}) => {
            return {
                kind: ThreadItemKind.AssistantMessage,
                title: '',
                text,
            };
        },
    ),
    reasoning: describeWith(
        defineShape({
            summary: [
                '',
            ],
            content: [
                '',
            ],
        }),
        ({summary, content}) => {
            return {
                kind: ThreadItemKind.Reasoning,
                title: '',
                text: (summary.length ? summary : content).join('\n\n'),
            };
        },
    ),
    plan: describeWith(
        defineShape({
            text: '',
        }),
        ({text}) => {
            return {
                kind: ThreadItemKind.Plan,
                title: '',
                text,
            };
        },
    ),
    commandExecution: describeWith(
        defineShape({
            command: '',
            aggregatedOutput: nullableShape(''),
        }),
        ({command, aggregatedOutput}) => {
            return {
                kind: ThreadItemKind.Command,
                title: command,
                text: aggregatedOutput || '',
            };
        },
    ),
    fileChange: describeWith(
        defineShape({
            changes: [
                {
                    path: '',
                    diff: '',
                },
            ],
        }),
        ({changes}) => {
            return {
                kind: ThreadItemKind.FileChange,
                title: changes.map((change) => change.path).join(', '),
                text: changes.map((change) => change.diff).join('\n'),
            };
        },
    ),
    mcpToolCall: describeWith(
        defineShape({
            server: '',
            tool: '',
            arguments: unknownShape(),
            result: unknownShape(),
            error: unknownShape(),
        }),
        (item) => {
            return {
                kind: ThreadItemKind.ToolCall,
                title: `${item.server}.${item.tool}`,
                text: [
                    formatJson(item.arguments),
                    formatJson(item.error ?? omitMcpResultImageData(item.result)),
                ]
                    .filter(Boolean)
                    .join('\n\n'),
            };
        },
    ),
    imageView: describeWith(
        defineShape({
            path: '',
        }),
        ({path}) => {
            return {
                kind: ThreadItemKind.ToolCall,
                title: 'View image',
                text: path,
            };
        },
    ),
    dynamicToolCall: describeWith(
        defineShape({
            tool: '',
            arguments: unknownShape(),
        }),
        (item) => {
            return {
                kind: ThreadItemKind.ToolCall,
                title: item.tool,
                text: formatJson(item.arguments),
            };
        },
    ),
    webSearch: describeWith(
        defineShape({
            query: '',
        }),
        ({query}) => {
            return {
                kind: ThreadItemKind.ToolCall,
                title: 'Web search',
                text: query,
            };
        },
    ),
};

/**
 * The thread item for an item from Codex's `item/started` or `item/completed`, or undefined for an
 * item a thread doesn't show.
 */
export function describeCodexItem({
    item,
    isCompleted,
}: Readonly<{
    item: unknown;
    isCompleted: boolean;
}>): ProviderItem | undefined {
    if (
        !checkValidShape(item, codexItemBaseShape, {
            allowExtraKeys: true,
        })
    ) {
        return undefined;
    }
    const description = codexItemDescribers[item.type]?.(item);
    if (!description) {
        return undefined;
    }
    return {
        ...description,
        providerItemId: item.id,
        status:
            item.status ?? (isCompleted ? ThreadItemStatus.Completed : ThreadItemStatus.InProgress),
    };
}

/** What Codex's approval requests take for each of the user's answers. */
export const codexDecisions: Readonly<Record<ApprovalDecision, string>> = {
    [ApprovalDecision.Approve]: 'accept',
    [ApprovalDecision.ApproveForSession]: 'acceptForSession',
    [ApprovalDecision.Decline]: 'decline',
};

const tokenUsageBreakdownShape = defineShape({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
});

const tokenUsageNotificationShape = defineShape({
    threadId: '',
    turnId: '',
    tokenUsage: {
        last: tokenUsageBreakdownShape,
        total: tokenUsageBreakdownShape,
    },
});

/** Codex's faster service tiers, by id. */
const codexTierSpeeds: Readonly<Record<string, UsageSpeed | undefined>> = {
    priority: UsageSpeed.Fast,
    ultrafast: UsageSpeed.Ultrafast,
};

/**
 * What the model response a `thread/tokenUsage/updated` notification reports spent. Codex counts
 * cached input inside its input tokens and reasoning inside its output tokens.
 */
export function readCodexTokenUsage({
    params,
    model,
    speedTier,
}: Readonly<{
    params: unknown;
    model: string;
    /** The turn's service tier id. Unset for standard speed. */
    speedTier: string | undefined;
}>): ProviderUsage | undefined {
    if (
        !checkValidShape(params, tokenUsageNotificationShape, {
            allowExtraKeys: true,
        })
    ) {
        return undefined;
    }
    return {
        /** The thread's running total only grows, so it tells the turn's responses apart. */
        dedupeKey: [
            'codex-usage',
            params.threadId,
            params.turnId,
            params.tokenUsage.total.totalTokens,
        ].join(':'),
        model,
        /** Codex only offers tiers faster than standard, so an unknown one counts as fast. */
        speed: speedTier ? codexTierSpeeds[speedTier] || UsageSpeed.Fast : UsageSpeed.Standard,
        inputTokens: Math.max(
            0,
            params.tokenUsage.last.inputTokens - params.tokenUsage.last.cachedInputTokens,
        ),
        outputTokens: params.tokenUsage.last.outputTokens,
        cacheReadTokens: params.tokenUsage.last.cachedInputTokens,
        cacheWriteTokens: 0,
        reasoningTokens: params.tokenUsage.last.reasoningOutputTokens,
    };
}
