import {PaneKind} from '@agent-storm/common';
import {Observable} from 'element-vir';
import {type FolderDataObservable} from './folder-data.js';

/** What a folder's pane is counted under in `keys`. */
export function paneRestartKey({
    folder,
    kind,
}: Readonly<{
    folder: string;
    kind: PaneKind;
}>) {
    return `${folder}:${kind}`;
}

export type PaneRestartsObservable = ReturnType<typeof createPaneRestarts>;

/**
 * Counters for pane restarts that happen outside the pane: a sidebar's "Restart panes" and "Change
 * AI", and saving the AI config. Each one also polls the folder list, which carries the restarted
 * panes' new state.
 */
export function createPaneRestarts(folderData: Readonly<Pick<FolderDataObservable, 'refresh'>>) {
    const observable = new Observable<{
        /** Keyed by {@link paneRestartKey}. Folded into the pane's terminal mount key. */
        keys: Readonly<Record<string, number | undefined>>;
        /** Bumped whenever the AI definitions may have changed, so AI panes load them again. */
        aiConfigRevision: number;
    }>({
        defaultValue: {
            keys: {},
            aiConfigRevision: 0,
        },
    });

    return Object.assign(observable, {
        async restart(pane: Readonly<Parameters<typeof paneRestartKey>[0]>) {
            const key = paneRestartKey(pane);
            observable.setValue({
                keys: {
                    ...observable.value.keys,
                    [key]: (observable.value.keys[key] || 0) + 1,
                },
                aiConfigRevision:
                    observable.value.aiConfigRevision + (pane.kind === PaneKind.Ai ? 1 : 0),
            });
            await folderData.refresh();
        },
        async bumpAiConfig() {
            observable.setValue({
                ...observable.value,
                aiConfigRevision: observable.value.aiConfigRevision + 1,
            });
            await folderData.refresh();
        },
    });
}
