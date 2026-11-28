import {type AgentStormConfig} from '@agent-storm/config';
import {check} from '@augment-vir/assert';

/** The nearest folder settings file's non-empty value, picked out by `selectValue`. */
export function findNearestFolderSetting<T>(
    folderLayers: ReadonlyArray<Readonly<AgentStormConfig>>,
    selectValue: (folderSettings: Readonly<AgentStormConfig>) => T | undefined,
) {
    return folderLayers.map(selectValue).find((value) => {
        return check.isString(value) ? !!value.trim() : value != undefined;
    });
}
