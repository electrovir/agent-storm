// cspell:word subkeys
import {
    type SessionKey,
    type SessionStore,
    type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import {check} from '@augment-vir/assert';
import {type PrismaClient} from './generated/client.js';

/**
 * Keeps Claude's session transcripts in the plugin's database instead of `~/.claude/projects`.
 *
 * Entries are keyed by session id alone, ignoring the SDK's `projectKey`: that key comes from the
 * working directory, and a thread that moves to a worktree must still resume its session there.
 */
export function createClaudeSessionStore(prismaClient: PrismaClient): SessionStore {
    return {
        async append({sessionId, subpath}: Readonly<SessionKey>, entries) {
            await prismaClient.$transaction(async (transaction) => {
                const uuids = entries.map((entry) => entry.uuid).filter(check.isString);
                const [
                    existing,
                    {_max},
                ] = await Promise.all([
                    transaction.claudeTranscriptEntry.findMany({
                        where: {
                            sessionId,
                            subpath: subpath || '',
                            uuid: {
                                in: uuids,
                            },
                        },
                        select: {
                            uuid: true,
                        },
                    }),
                    transaction.claudeTranscriptEntry.aggregate({
                        where: {
                            sessionId,
                            subpath: subpath || '',
                        },
                        _max: {
                            order: true,
                        },
                    }),
                ]);
                const seenUuids = existing.map((row) => row.uuid);
                /** The SDK may resend entries it already appended, which it marks by `uuid`. */
                const newEntries = entries.filter((entry, index) => {
                    return (
                        !entry.uuid ||
                        (!seenUuids.includes(entry.uuid) &&
                            entries.findIndex((other) => other.uuid === entry.uuid) === index)
                    );
                });
                const firstOrder = (_max.order ?? -1) + 1;
                await transaction.claudeTranscriptEntry.createMany({
                    data: newEntries.map((entry, index) => {
                        return {
                            sessionId,
                            subpath: subpath || '',
                            order: firstOrder + index,
                            uuid: entry.uuid ?? null,
                            entry: JSON.stringify(entry),
                        };
                    }),
                });
            });
        },
        async load({sessionId, subpath}) {
            const rows = await prismaClient.claudeTranscriptEntry.findMany({
                where: {
                    sessionId,
                    subpath: subpath || '',
                },
                orderBy: {
                    order: 'asc',
                },
                select: {
                    entry: true,
                },
            });
            return rows.length
                ? rows.map((row) => JSON.parse(row.entry) as SessionStoreEntry)
                : null;
        },
        async listSubkeys({sessionId}) {
            const rows = await prismaClient.claudeTranscriptEntry.findMany({
                where: {
                    sessionId,
                    subpath: {
                        not: '',
                    },
                },
                distinct: [
                    'subpath',
                ],
                select: {
                    subpath: true,
                },
            });
            return rows.map((row) => row.subpath);
        },
        async delete({sessionId, subpath}) {
            await prismaClient.claudeTranscriptEntry.deleteMany({
                where: {
                    sessionId,
                    ...(subpath == undefined
                        ? {}
                        : {
                              subpath,
                          }),
                },
            });
        },
    };
}
