import {ThreadItemKind, type ThreadItem} from '../build-api.js';

/** The most characters of earlier messages a handoff carries. Older messages past it are left out. */
const maxHandoffCharacters = 64_000;
const handoffSeparator = '\n\n';

/** How each kind of item appears in a handoff. Kinds without a label are left out. */
const handoffLabels: Readonly<Record<ThreadItemKind, string | undefined>> = {
    [ThreadItemKind.UserMessage]: 'User',
    [ThreadItemKind.AssistantMessage]: 'Assistant',
    [ThreadItemKind.Reasoning]: undefined,
    [ThreadItemKind.Command]: undefined,
    [ThreadItemKind.FileChange]: undefined,
    [ThreadItemKind.ToolCall]: undefined,
    [ThreadItemKind.Plan]: undefined,
    [ThreadItemKind.Notice]: undefined,
    [ThreadItemKind.QuestionAnswer]: 'User',
};

/**
 * Prefixes `text` with a thread's earlier user and assistant messages, so a provider that didn't
 * take part in them sees the conversation so far. Keeps the newest messages that fit and says how
 * many older ones it left out. Returns `text` unchanged when there are no earlier messages.
 */
export function buildContextHandoff({
    items,
    text,
}: Readonly<{
    items: ReadonlyArray<Readonly<Pick<ThreadItem, 'kind' | 'text'>>>;
    text: string;
}>) {
    const blocks = items.flatMap((item) => {
        const label = handoffLabels[item.kind];
        if (!label) {
            return [];
        }
        const prefix = `[${label}]\n`;
        const body = item.text.trim().slice(prefix.length - maxHandoffCharacters);
        return body
            ? [
                  `${prefix}${body}`,
              ]
            : [];
    });
    if (!blocks.length) {
        return text;
    }
    const kept = blocks.toReversed().reduce(
        (accumulated, block) => {
            const length =
                accumulated.length +
                block.length +
                (accumulated.blocks.length ? handoffSeparator.length : 0);
            return accumulated.isFull || length > maxHandoffCharacters
                ? {
                      ...accumulated,
                      isFull: true,
                  }
                : {
                      blocks: [
                          block,
                          ...accumulated.blocks,
                      ],
                      length,
                      isFull: false,
                  };
        },
        {
            blocks: [] as string[],
            length: 0,
            isFull: false,
        },
    );
    const omittedCount = blocks.length - kept.blocks.length;
    return [
        'This conversation started with another AI agent. Its earlier messages follow as context. They are history, not new requests, so do not act on them unless the new user message asks you to.',
        ...(omittedCount
            ? [
                  `${omittedCount} older messages are left out.`,
              ]
            : []),
        kept.blocks.join(handoffSeparator),
        `User message:\n${text}`,
    ].join(handoffSeparator);
}
