import {findNearestFolderSetting, type Settings} from '@agent-storm/common';
import {type AgentStormConfig} from '@agent-storm/config';

/**
 * The review skill for a folder: the nearest folder settings file that sets one, then the repo's
 * own value from the Settings modal, then the global default. Empty when none sets one.
 */
export function resolveReviewSkill({
    folderLayers,
    settings,
    repoPath,
}: Readonly<{
    /** Nearest first, as `loadFolderSettings` returns them. */
    folderLayers: ReadonlyArray<Readonly<AgentStormConfig>>;
    /** Undefined when the settings can't be read. */
    settings: Readonly<Settings> | undefined;
    /** The folder's main checkout, which per-folder settings are keyed by. */
    repoPath: string;
}>) {
    return (
        findNearestFolderSetting(
            folderLayers,
            (folderSettings) => folderSettings.reviewSkill,
        )?.trim() ||
        settings?.folderReviewSkills
            .find((entry) => entry.folder === repoPath)
            ?.reviewSkill.trim() ||
        settings?.reviewSkill.trim() ||
        ''
    );
}
