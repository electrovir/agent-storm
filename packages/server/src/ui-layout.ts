import {
    sharedTabLayoutShape,
    tabSelectionShape,
    toPaneGroupKey,
    type SharedTabLayout,
    type TabSelection,
    type UiLayout,
} from '@agent-storm/common';
import {type PaneGroupState} from '@agent-storm/core/server';
import {
    omitObjectKeys,
    PromiseQueue,
    typedObjectFromEntries,
    wrapInTry,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {writeFileAtomically} from 'agent-storm-util';
import {createHash} from 'node:crypto';
import {readdir, rm, stat} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {defineShape, optionalShape, parseJsonWithShape, recordShape} from 'object-shape-tester';
import {folderStatesDir, uiLayoutPath} from './file-paths.js';

const appLayoutShape = defineShape({
    mainTabOrder: [''],
    enabledActivities: optionalShape(
        recordShape({
            keys: '',
            values: false,
        }),
        {
            alsoUndefined: true,
        },
    ),
    rememberedSelections: optionalShape(
        recordShape({
            keys: '',
            values: '',
        }),
        {
            alsoUndefined: true,
        },
    ),
});

const folderStateShape = defineShape({
    /** The directory name is only a readable, collision-free key, so the path is kept here. */
    folder: '',
    /** Missing for the folder's own pane group. See {@link toPaneGroupKey}. */
    scope: optionalShape('', {
        alsoUndefined: true,
    }),
    tabLayout: sharedTabLayoutShape,
    /** The latest selection from any window. */
    tabSelection: optionalShape(tabSelectionShape, {
        alsoUndefined: true,
    }),
});

const folderStateFileName = 'state.json';

/**
 * Bumped on every change. Starts from the clock so a restarted server never reports a revision a
 * window already loaded.
 */
const revision = {
    value: Date.now(),
};

export function readUiLayoutRevision() {
    return revision.value;
}

/** A pane group's UI state lives in its own directory, so deleting it deletes just that. */
function toFolderStateDir({
    folder,
    scope,
}: Readonly<{
    folder: string;
    scope?: string | undefined;
}>) {
    const hash = createHash('sha256')
        .update(
            toPaneGroupKey({
                folder,
                scope,
            }),
        )
        .digest('hex')
        .slice(0, 12);
    return join(folderStatesDir, `${basename(folder)}-${hash}`);
}

async function doesPathExist(path: string) {
    return !!(await stat(path).catch(() => undefined));
}

/** A malformed state file reads as missing rather than being replaced, so it can be inspected. */
async function readFolderState(stateDir: string) {
    const contents = await readFileIfExists(join(stateDir, folderStateFileName));
    return contents == undefined
        ? undefined
        : wrapInTry(() => parseJsonWithShape(contents, folderStateShape), {
              fallbackValue: undefined,
          });
}

async function writeFolderState(state: Readonly<typeof folderStateShape.runtimeType>) {
    await writeFileAtomically({
        path: join(toFolderStateDir(state), folderStateFileName),
        contents: JSON.stringify(state, undefined, 4),
    });
}

async function readFolderStates() {
    const dirNames = await readdir(folderStatesDir).catch((): string[] => []);
    const states = await Promise.all(
        dirNames.map((dirName) => readFolderState(join(folderStatesDir, dirName))),
    );
    return states.filter((state) => state != undefined);
}

/** A missing app layout file is the default layout. A malformed one throws. */
export async function loadUiLayout(): Promise<UiLayout> {
    const [
        appContents,
        folderStates,
    ] = await Promise.all([
        readFileIfExists(uiLayoutPath),
        readFolderStates(),
    ]);
    const appLayout =
        appContents == undefined ? undefined : parseJsonWithShape(appContents, appLayoutShape);
    return {
        tabLayouts: typedObjectFromEntries(
            folderStates.map((state) => {
                return [
                    toPaneGroupKey(state),
                    state.tabLayout,
                ];
            }),
        ),
        tabSelections: typedObjectFromEntries(
            folderStates.flatMap((state) => {
                return state.tabSelection
                    ? [
                          [
                              toPaneGroupKey(state),
                              state.tabSelection,
                          ],
                      ]
                    : [];
            }),
        ),
        mainTabOrder: appLayout?.mainTabOrder || [],
        enabledActivities: appLayout?.enabledActivities || {},
        rememberedSelections: appLayout?.rememberedSelections || {},
    };
}

/** Every change runs inside the queue, so concurrent saves can't drop each other. */
const uiLayoutWriteQueue = new PromiseQueue();

async function changeUiLayout(change: () => Promise<void>) {
    await uiLayoutWriteQueue.add(async () => {
        await change();
        revision.value++;
    });
}

/** Saves whichever of `layout` and `selection` is given, keeping the other as stored. */
export async function saveTabLayout({
    folder,
    scope,
    layout,
    selection,
}: Readonly<
    PartialWithUndefined<{
        scope: string;
        layout: Readonly<SharedTabLayout>;
        selection: Readonly<TabSelection>;
    }> & {
        folder: string;
    }
>) {
    await changeUiLayout(async () => {
        /** A window that hasn't seen the folder's deletion yet mustn't bring its state back. */
        if (!(await doesPathExist(folder))) {
            return;
        }
        const stateDir = toFolderStateDir({
            folder,
            scope,
        });
        const existing = await readFolderState(stateDir);
        const tabLayout = layout || existing?.tabLayout;
        /** A selection means nothing without the layout it selects in. */
        if (!tabLayout) {
            return;
        }
        await writeFolderState({
            folder,
            scope: scope || undefined,
            tabLayout,
            tabSelection: selection || existing?.tabSelection,
        });
    });
    return await loadUiLayout();
}

/** Rewrites the app layout file with `change`'s fields replacing the stored ones. */
export async function changeAppLayout(
    change: (existing: Readonly<UiLayout>) => Partial<typeof appLayoutShape.runtimeType>,
) {
    await changeUiLayout(async () => {
        const existing = await loadUiLayout();
        await writeFileAtomically({
            path: uiLayoutPath,
            contents: JSON.stringify(
                {
                    ...omitObjectKeys(existing, [
                        'tabLayouts',
                        'tabSelections',
                    ]),
                    ...change(existing),
                } satisfies typeof appLayoutShape.runtimeType,
                undefined,
                4,
            ),
        });
    });
    return await loadUiLayout();
}

/** Saves whichever of `order` and `enabledActivities` is given, keeping the other as stored. */
export async function saveActivityBar({
    order,
    enabledActivities,
}: Readonly<
    PartialWithUndefined<{
        order: ReadonlyArray<string>;
        enabledActivities: Readonly<Record<string, boolean>>;
    }>
>) {
    return await changeAppLayout((existing) => {
        return {
            mainTabOrder: [
                ...(order || existing.mainTabOrder),
            ],
            enabledActivities: {
                ...(enabledActivities || existing.enabledActivities),
            },
        };
    });
}

/** An empty `value` removes `key`'s entry. */
export async function saveRememberedSelection({
    key,
    value,
}: Readonly<{
    key: string;
    value: string;
}>) {
    return await changeAppLayout((existing) => {
        return {
            rememberedSelections: value
                ? {
                      ...existing.rememberedSelections,
                      [key]: value,
                  }
                : omitObjectKeys(existing.rememberedSelections, [
                      key,
                  ]),
        };
    });
}

/** Deletes the state of the folder's own pane group and of every scoped one in it. */
export async function deleteFolderState(folder: string) {
    await changeUiLayout(async () => {
        const scopedStates = (await readFolderStates()).filter((state) => {
            return state.folder === folder;
        });
        await Promise.all(
            [
                {
                    folder,
                },
                ...scopedStates,
            ].map(async (state) => {
                await rm(toFolderStateDir(state), {
                    recursive: true,
                    force: true,
                });
            }),
        );
    });
}

/** Deletes the state of folders that are gone, such as ones deleted while the server was down. */
export async function pruneFolderStates() {
    const states = await readFolderStates();
    await Promise.all(
        states.map(async (state) => {
            if (!(await doesPathExist(state.folder))) {
                await deleteFolderState(state.folder);
            }
        }),
    );
}

/**
 * Moves each pane group's state to the scope `renameScope` returns for it, for a plugin whose id
 * changed.
 */
export async function renameFolderStateScopes(renameScope: (scope: string) => string) {
    await changeUiLayout(async () => {
        const states = await readFolderStates();
        await Promise.all(
            states.map(async (state) => {
                const scope = state.scope && renameScope(state.scope);
                if (scope === state.scope) {
                    return;
                }
                await writeFolderState({
                    ...state,
                    scope,
                });
                await rm(toFolderStateDir(state), {
                    recursive: true,
                    force: true,
                });
            }),
        );
    });
}

/**
 * Moves the state of the folder's own pane group to the pane group `scope`, as `changeLayout`
 * changes it. Undefined from `changeLayout` drops the state instead.
 */
export async function moveFolderState({
    folder,
    scope,
    changeLayout,
}: Readonly<{
    folder: string;
    scope: string;
    changeLayout(state: Readonly<PaneGroupState>): PaneGroupState | undefined;
}>) {
    await changeUiLayout(async () => {
        const stateDir = toFolderStateDir({
            folder,
        });
        const state = await readFolderState(stateDir);
        const changed =
            state &&
            changeLayout({
                tabLayout: state.tabLayout,
                tabSelection: state.tabSelection,
            });
        if (changed) {
            await writeFolderState({
                ...changed,
                folder,
                scope,
            });
        }
        await rm(stateDir, {
            recursive: true,
            force: true,
        });
    });
}
