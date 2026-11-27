import {createArray} from '@augment-vir/common';

/**
 * Splits a Codex model id like `gpt-6.2-sol` into its numeric version and its variant. Ids that
 * don't follow that pattern give `undefined`.
 */
function parseCodexModelId(id: string) {
    const match = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(id);
    if (!match?.[1]) {
        return undefined;
    }
    return {
        version: match[1].split('.').map(Number),
        variant: match[2],
    };
}

/** Whether `version` is newer than `than`. A missing part counts as `0`. */
function isNewerVersion({
    version,
    than,
}: Readonly<{
    version: ReadonlyArray<number>;
    than: ReadonlyArray<number>;
}>) {
    const length = Math.max(version.length, than.length);
    const firstDifference = createArray(length, (index) => index).find((index) => {
        return (version[index] ?? 0) !== (than[index] ?? 0);
    });
    return (
        firstDifference != undefined &&
        (version[firstDifference] ?? 0) > (than[firstDifference] ?? 0)
    );
}

/**
 * Picks out the Codex models that a newer one replaces. Codex's model list doesn't mark old models,
 * so a model counts as old when the list has a newer version of the same variant (`gpt-6.2-sol`
 * replaces `gpt-6.1-sol`), or a newer version of anything when it has no variant (`gpt-5.5`).
 */
export function findLegacyCodexModelIds(modelIds: ReadonlyArray<string>) {
    const parsedModels = modelIds.map((id) => {
        return {
            id,
            parsed: parseCodexModelId(id),
        };
    });
    return parsedModels
        .filter(({parsed}) => {
            return parsedModels.some((other) => {
                return (
                    !!parsed &&
                    !!other.parsed &&
                    (parsed.variant == undefined || parsed.variant === other.parsed.variant) &&
                    isNewerVersion({
                        version: other.parsed.version,
                        than: parsed.version,
                    })
                );
            });
        })
        .map(({id}) => id);
}
