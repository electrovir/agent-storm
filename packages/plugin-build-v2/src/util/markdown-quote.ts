/**
 * Appends `quote` to the end of `message` as a Markdown block quote, with a blank line on each side
 * so the user can keep typing below it.
 */
export function appendMarkdownQuote({
    message,
    quote,
}: Readonly<{
    message: string;
    quote: string;
}>) {
    const quoteBlock = quote
        .trim()
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n');
    return [
        [
            message.trimEnd(),
            quoteBlock,
        ]
            .filter((part) => !!part)
            .join('\n\n'),
        '\n\n',
    ].join('');
}
