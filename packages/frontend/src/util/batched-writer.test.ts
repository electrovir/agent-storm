import {assert} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {createBatchedWriter} from './batched-writer.js';

type Stored = {
    count: number;
    name: string;
};

function createStore(initial: Readonly<Stored>) {
    const store = {
        value: initial,
        writes: [] as ReadonlyArray<Stored>,
        errors: [] as ReadonlyArray<unknown>,
    };
    const writer = createBatchedWriter<Stored>({
        delay: {
            milliseconds: 1,
        },
        read() {
            return Promise.resolve(store.value);
        },
        write(value) {
            store.value = value;
            store.writes = [
                ...store.writes,
                value,
            ];
            return Promise.resolve(value);
        },
        onSaved() {},
        onError(error) {
            store.errors = [
                ...store.errors,
                error,
            ];
        },
    });
    return {
        store,
        writer,
    };
}

describe(createBatchedWriter.name, () => {
    it('applies every edit in one write on top of the stored value', async () => {
        const {store, writer} = createStore({
            count: 0,
            name: 'a',
        });
        writer.add((current) => {
            return {
                ...current,
                count: current.count + 1,
            };
        });
        /** Lands between the edits and the write, like a change from another window. */
        store.value = {
            ...store.value,
            name: 'b',
        };
        writer.add((current) => {
            return {
                ...current,
                count: current.count + 1,
            };
        });
        await writer.flush();
        assert.deepEquals(store.writes, [
            {
                count: 2,
                name: 'b',
            },
        ]);
    });

    it('writes on its own once edits stop arriving', async () => {
        const {store, writer} = createStore({
            count: 0,
            name: 'a',
        });
        writer.add((current) => {
            return {
                ...current,
                name: 'c',
            };
        });
        await wait({
            milliseconds: 20,
        });
        assert.deepEquals(store.value, {
            count: 0,
            name: 'c',
        });
    });

    it('does not write when nothing changed', async () => {
        const {store, writer} = createStore({
            count: 0,
            name: 'a',
        });
        await writer.flush();
        assert.isLengthExactly(store.writes, 0);
    });
});
