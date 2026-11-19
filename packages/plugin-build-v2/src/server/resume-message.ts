const resumeIntro =
    'Agent Storm restarted while you were working, which cut off your last turn. Pick up where you left off.';
const turnMessagesIntro =
    'The user sent these messages during that turn, which may not have reached you. Act on them if you have not already:';

/**
 * Turns a resume message back into the user messages it quotes, so a thread that restarts again
 * mid-resume does not nest one resume message inside the next. The return type is explicit because
 * this recurses.
 */
function unwrapResumeMessage(message: string): string[] {
    if (!message.startsWith(resumeIntro)) {
        return [message];
    }
    const quotedMessages = message.split(turnMessagesIntro)[1];
    if (quotedMessages == undefined) {
        return [];
    }
    return quotedMessages
        .split('\n\n')
        .filter((block) => block.trim())
        .map((block) => {
            return block
                .split('\n')
                .map((line) => line.replace(/^> ?/, ''))
                .join('\n');
        })
        .flatMap(unwrapResumeMessage);
}

/** The message that tells a thread a restart cut off its turn, quoting the turn's user messages. */
export function buildResumeMessage(turnMessages: ReadonlyArray<string>) {
    const userMessages = turnMessages.flatMap(unwrapResumeMessage);
    return [
        resumeIntro,
        ...(userMessages.length
            ? [
                  '',
                  turnMessagesIntro,
                  ...userMessages.flatMap((message) => {
                      return [
                          '',
                          message
                              .split('\n')
                              .map((line) => `> ${line}`)
                              .join('\n'),
                      ];
                  }),
              ]
            : []),
    ].join('\n');
}
