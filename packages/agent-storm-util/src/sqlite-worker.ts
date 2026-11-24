/**
 * The worker side of `createSqliteWorkerAdapter`: runs each request against one better-sqlite3
 * connection and posts back its result.
 */

import {assertWrap} from '@augment-vir/assert';
import {extractErrorMessage} from '@augment-vir/common';
import {PrismaBetterSqlite3} from '@prisma/adapter-better-sqlite3';
import {isDriverAdapterError, type Transaction} from '@prisma/driver-adapter-utils';
import {randomUUID} from 'node:crypto';
import {parentPort, workerData} from 'node:worker_threads';
import {assertWrapValidShape} from 'object-shape-tester';
import {
    sqliteWorkerDataShape,
    SqliteWorkerMethod,
    type SqliteWorkerCalls,
    type SqliteWorkerRequest,
    type SqliteWorkerResponse,
} from './sqlite-worker-adapter.js';

const port = assertWrap.isDefined(parentPort);
const adapter = await new PrismaBetterSqlite3({
    url: `file:${assertWrapValidShape(workerData, sqliteWorkerDataShape).databasePath}`,
}).connect();
/**
 * With WAL (set by `applySqliteMigrations`), this drops the disk sync on each commit. An OS crash
 * can lose the newest commits but can't corrupt the database.
 */
await adapter.executeScript('PRAGMA synchronous = NORMAL');
const transactions = new Map<string, Transaction>();

function getTransaction(transactionId: string) {
    return assertWrap.isDefined(
        transactions.get(transactionId),
        `No open SQLite transaction ${transactionId}.`,
    );
}

function getQueryable(transactionId: string | undefined) {
    return transactionId == undefined ? adapter : getTransaction(transactionId);
}

const handlers: {
    [Method in SqliteWorkerMethod]: (
        params: SqliteWorkerCalls[Method]['params'],
    ) => Promise<SqliteWorkerCalls[Method]['result']>;
} = {
    async [SqliteWorkerMethod.QueryRaw]({query, transactionId}) {
        return await getQueryable(transactionId).queryRaw(query);
    },
    async [SqliteWorkerMethod.ExecuteRaw]({query, transactionId}) {
        return await getQueryable(transactionId).executeRaw(query);
    },
    async [SqliteWorkerMethod.ExecuteScript]({script}) {
        await adapter.executeScript(script);
    },
    async [SqliteWorkerMethod.StartTransaction]({isolationLevel}) {
        const transaction = await adapter.startTransaction(isolationLevel);
        const transactionId = randomUUID();
        transactions.set(transactionId, transaction);
        return {
            transactionId,
            options: transaction.options,
        };
    },
    async [SqliteWorkerMethod.Commit]({transactionId}) {
        await getTransaction(transactionId).commit();
        transactions.delete(transactionId);
    },
    async [SqliteWorkerMethod.Rollback]({transactionId}) {
        await getTransaction(transactionId).rollback();
        transactions.delete(transactionId);
    },
    async [SqliteWorkerMethod.Dispose]() {
        await adapter.dispose();
    },
};

port.on('message', async (request: SqliteWorkerRequest) => {
    try {
        const result = await (
            handlers[request.method] satisfies (params: never) => Promise<unknown> as (
                params: SqliteWorkerRequest['params'],
            ) => Promise<unknown>
        )(request.params);
        port.postMessage({
            id: request.id,
            result,
        } satisfies SqliteWorkerResponse);
    } catch (error) {
        port.postMessage(
            (isDriverAdapterError(error)
                ? {
                      id: request.id,
                      driverAdapterError: error.cause,
                  }
                : {
                      id: request.id,
                      errorMessage: extractErrorMessage(error),
                  }) satisfies SqliteWorkerResponse,
        );
    }
});
