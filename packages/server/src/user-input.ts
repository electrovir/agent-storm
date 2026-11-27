import {wrapInTry} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {writeFileAtomically} from 'agent-storm-util';
import {defineShape, parseJsonWithShape} from 'object-shape-tester';
import {lastUserInputPath} from './file-paths.js';

const lastUserInputShape = defineShape({
    /** Epoch milliseconds. */
    lastAt: 0,
});

const userInput: {
    /** Undefined until the first report since the server started. */
    lastAt: number | undefined;
    listeners: ReadonlyArray<() => void>;
} = {
    lastAt: undefined,
    listeners: [],
};

async function readSavedLastUserInputAt() {
    const contents = await readFileIfExists(lastUserInputPath);
    return contents
        ? wrapInTry(() => parseJsonWithShape(contents, lastUserInputShape).lastAt, {
              fallbackValue: undefined,
          })
        : undefined;
}

/** Epoch milliseconds of the user's last input in any open copy of the app, if they ever had one. */
export async function readLastUserInputAt() {
    return userInput.lastAt ?? (await readSavedLastUserInputAt());
}

export async function recordUserInput() {
    userInput.lastAt = Date.now();
    await writeFileAtomically({
        path: lastUserInputPath,
        contents: JSON.stringify({
            lastAt: userInput.lastAt,
        }),
    });
    userInput.listeners.forEach((listener) => listener());
}

/** Calls `listener` after each report of the user's input. Returns a function that stops it. */
export function listenToUserInput(listener: () => void) {
    userInput.listeners = [
        ...userInput.listeners,
        listener,
    ];
    return () => {
        userInput.listeners = userInput.listeners.filter((existing) => existing !== listener);
    };
}
