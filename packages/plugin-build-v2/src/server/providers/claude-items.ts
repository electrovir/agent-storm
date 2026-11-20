import {check} from '@augment-vir/assert';
import {ApprovalKind, ThreadItemKind, ThreadItemStatus} from '../../build-v2-api.js';
import {agentToolServerName} from '../agent-tool-server.js';
import {unpromptedAgentToolNames} from '../agent-tools.js';
import {type ProviderItem} from './provider-session.js';

/** A Claude tool call as a thread item, before its result arrives. */
export type ClaudeToolDescription = Pick<ProviderItem, 'kind' | 'title' | 'text'>;

/**
 * Claude's tools that only read, which run without asking, and Agent Storm's own tools that are
 * read-only or ask the user themselves. Every other tool, including any other MCP tool, asks
 * first.
 */
export const readOnlyClaudeTools = [
    'Read',
    'Glob',
    'Grep',
    'LS',
    'NotebookRead',
    'TodoWrite',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskUpdate',
    ...unpromptedAgentToolNames.map((name) => `mcp__${agentToolServerName}__${name}`),
];

function readString(input: Readonly<Record<string, unknown>>, key: string) {
    const value = input[key];
    return check.isString(value) ? value : '';
}

function prefixLines({text, prefix}: Readonly<{text: string; prefix: string}>) {
    return text ? text.split('\n').map((line) => `${prefix}${line}`) : [];
}

/** The removed lines as `-` lines, then the added lines as `+` lines. */
function formatReplacement({oldText, newText}: Readonly<{oldText: string; newText: string}>) {
    return [
        ...prefixLines({
            text: oldText,
            prefix: '-',
        }),
        ...prefixLines({
            text: newText,
            prefix: '+',
        }),
    ].join('\n');
}

function formatJson(value: unknown) {
    return JSON.stringify(value, undefined, 4);
}

/** How each of Claude's built-in tools shows in a thread, keyed by tool name. */
const claudeToolDescribers: Readonly<
    Record<string, (input: Readonly<Record<string, unknown>>) => ClaudeToolDescription>
> = {
    Bash(input) {
        return {
            kind: ThreadItemKind.Command,
            title: readString(input, 'command'),
            text: '',
        };
    },
    Edit(input) {
        return {
            kind: ThreadItemKind.FileChange,
            title: readString(input, 'file_path'),
            text: formatReplacement({
                oldText: readString(input, 'old_string'),
                newText: readString(input, 'new_string'),
            }),
        };
    },
    MultiEdit(input) {
        const edits = check.isArray(input.edits) ? input.edits : [];
        return {
            kind: ThreadItemKind.FileChange,
            title: readString(input, 'file_path'),
            text: edits
                .filter(check.isObject)
                .map((edit) => {
                    return formatReplacement({
                        oldText: readString(edit, 'old_string'),
                        newText: readString(edit, 'new_string'),
                    });
                })
                .join('\n'),
        };
    },
    Write(input) {
        return {
            kind: ThreadItemKind.FileChange,
            title: readString(input, 'file_path'),
            text: formatReplacement({
                oldText: '',
                newText: readString(input, 'content'),
            }),
        };
    },
    NotebookEdit(input) {
        return {
            kind: ThreadItemKind.FileChange,
            title: readString(input, 'notebook_path'),
            text: formatReplacement({
                oldText: '',
                newText: readString(input, 'new_source'),
            }),
        };
    },
    TodoWrite(input) {
        const todos = check.isArray(input.todos) ? input.todos : [];
        return {
            kind: ThreadItemKind.Plan,
            title: '',
            text: todos
                .filter(check.isObject)
                .map((todo) => {
                    return `${readString(todo, 'status') === 'completed' ? '[x]' : '[ ]'} ${readString(todo, 'content')}`;
                })
                .join('\n'),
        };
    },
};

/** The thread item for a Claude `tool_use` block. */
export function describeClaudeToolUse({
    name,
    input,
}: Readonly<{
    name: string;
    input: Readonly<Record<string, unknown>>;
}>): ClaudeToolDescription {
    return (
        claudeToolDescribers[name]?.(input) ?? {
            kind: ThreadItemKind.ToolCall,
            title: name,
            text: formatJson(input),
        }
    );
}

/** What a request to run a tool asks to allow, by the kind of item the tool shows as. */
export const claudeApprovalKinds: Readonly<Record<ThreadItemKind, ApprovalKind>> = {
    [ThreadItemKind.Command]: ApprovalKind.Command,
    [ThreadItemKind.FileChange]: ApprovalKind.FileChange,
    [ThreadItemKind.UserMessage]: ApprovalKind.Permission,
    [ThreadItemKind.AssistantMessage]: ApprovalKind.Permission,
    [ThreadItemKind.Reasoning]: ApprovalKind.Permission,
    [ThreadItemKind.ToolCall]: ApprovalKind.Permission,
    [ThreadItemKind.Plan]: ApprovalKind.Permission,
    [ThreadItemKind.Notice]: ApprovalKind.Permission,
};

/** The text of a `tool_result` block's `content`, which is a string or a list of content blocks. */
export function readClaudeToolResultText(content: unknown) {
    if (check.isString(content)) {
        return content;
    }
    return (check.isArray(content) ? content : [])
        .filter(check.isObject)
        .map((block) => readString(block, 'text'))
        .filter(Boolean)
        .join('\n');
}

/** A Claude tool call's item once its result arrives. */
export function completeClaudeToolItem({
    tool,
    output,
    isError,
    isDeclined,
}: Readonly<{
    tool: Readonly<ClaudeToolDescription>;
    output: string;
    isError: boolean;
    isDeclined: boolean;
}>): ClaudeToolDescription & Pick<ProviderItem, 'status'> {
    const status = isDeclined
        ? ThreadItemStatus.Declined
        : isError
          ? ThreadItemStatus.Failed
          : ThreadItemStatus.Completed;
    const text =
        tool.kind === ThreadItemKind.Command
            ? output
            : isError || tool.kind === ThreadItemKind.ToolCall
              ? [
                    tool.text,
                    output,
                ]
                    .filter(Boolean)
                    .join('\n\n')
              : tool.text;
    return {
        ...tool,
        status,
        text,
    };
}
