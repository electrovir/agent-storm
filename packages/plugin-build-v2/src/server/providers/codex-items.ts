import {
    checkValidShape,
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    unknownShape,
    type Shape,
} from 'object-shape-tester';
import {ApprovalDecision, ThreadItemKind, ThreadItemStatus} from '../../build-v2-api.js';
import {type ProviderItem} from './provider-session.js';

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

/**
 * How each Codex item type shows in a thread, keyed by the item's `type`. Codex has more types than
 * these (user messages, image views, compaction markers); a thread leaves the rest out.
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
                    formatJson(item.error ?? item.result),
                ]
                    .filter(Boolean)
                    .join('\n\n'),
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
