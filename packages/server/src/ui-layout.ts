import {
    sharedTabLayoutShape,
    tabSelectionShape,
    type SharedTabLayout,
    type TabSelection,
    type UiLayout,
} from '@agent-storm/common';
import {
    PromiseQueue,
    typedObjectFromEntries,
    wrapInTry,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {createHash} from 'node:crypto';
import {readdir, rm, stat} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {defineShape, optionalShape, parseJsonWithShape} from 'object-shape-tester';
import {folderStatesDir, uiLayoutPath} from './file-paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

const appLayoutShape = defineShape({
    mainTabOrder: [''],
});

const folderStateShape = defineShape({
    /** The directory name is only a readable, collision-free key, so the path is kept here. */
    folder: '',
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

/** A folder's UI state lives in its own directory, so deleting the folder deletes just that. */
function toFolderStateDir(folder: string) {
    const hash = createHash('sha256').update(folder).digest('hex').slice(0, 12);
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

async function readFolderStates() {
    const dirNames = await readdir(folderStatesDir).catch((): string[] => []);
    const states = await Promise.all(
        dirNames.map((dirName) => readFolderState(join(folderStatesDir, dirName))),
    );
    return states.filter((state) => state != undefined);
}

/** A missing main tab order file is the default order. A malformed one throws. */
export async function loadUiLayout(): Promise<UiLayout> {
    const [
        appContents,
        folderStates,
    ] = await Promise.all([
        readFileIfExists(uiLayoutPath),
        readFolderStates(),
    ]);
    return {
        tabLayouts: typedObjectFromEntries(
            folderStates.map((state) => {
                return [
                    state.folder,
                    state.tabLayout,
                ];
            }),
        ),
        tabSelections: typedObjectFromEntries(
            folderStates.flatMap((state) => {
                return state.tabSelection
                    ? [
                          [
                              state.folder,
                              state.tabSelection,
                          ],
                      ]
                    : [];
            }),
        ),
        mainTabOrder:
            appContents == undefined
                ? []
                : parseJsonWithShape(appContents, appLayoutShape).mainTabOrder,
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
    layout,
    selection,
}: Readonly<
    PartialWithUndefined<{
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
        const stateDir = toFolderStateDir(folder);
        const existing = await readFolderState(stateDir);
        const tabLayout = layout || existing?.tabLayout;
        /** A selection means nothing without the layout it selects in. */
        if (!tabLayout) {
            return;
        }
        await writeFileAtomically({
            path: join(stateDir, folderStateFileName),
            contents: JSON.stringify(
                {
                    folder,
                    tabLayout,
                    tabSelection: selection || existing?.tabSelection,
                } satisfies typeof folderStateShape.runtimeType,
                undefined,
                4,
            ),
        });
    });
    return await loadUiLayout();
}

export async function saveMainTabOrder(order: ReadonlyArray<string>) {
    await changeUiLayout(async () => {
        await writeFileAtomically({
            path: uiLayoutPath,
            contents: JSON.stringify(
                {
                    mainTabOrder: [
                        ...order,
                    ],
                } satisfies typeof appLayoutShape.runtimeType,
                undefined,
                4,
            ),
        });
    });
    return await loadUiLayout();
}

export async function deleteFolderState(folder: string) {
    await changeUiLayout(async () => {
        await rm(toFolderStateDir(folder), {
            recursive: true,
            force: true,
        });
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
