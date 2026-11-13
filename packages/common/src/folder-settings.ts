import {check} from '@augment-vir/assert';
import {type FolderSettings} from './api.js';

/** The nearest folder settings file's non-empty value, picked out by `selectValue`. */
export function findNearestFolderSetting<T>(
    folderLayers: ReadonlyArray<Readonly<FolderSettings>>,
    selectValue: (folderSettings: Readonly<FolderSettings>) => T | undefined,
) {
    return folderLayers.map(selectValue).find((value) => {
        return check.isString(value) ? !!value.trim() : value != undefined;
    });
}
