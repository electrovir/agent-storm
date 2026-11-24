// cspell:words savepoint
import {
    DriverAdapterError,
    type Error as DriverAdapterErrorPayload,
    type IsolationLevel,
    type SqlDriverAdapter,
    type SqlDriverAdapterFactory,
    type SqlQuery,
    type SqlResultSet,
    type Transaction,
    type TransactionOptions,
} from '@prisma/driver-adapter-utils';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {defineShape} from 'object-shape-tester';

/**
 * The file name the plugin build gives the bundled worker, beside the plugin's server bundle.
 *
 * @category Internal
 */
export const sqliteWorkerFileName = 'sqlite-worker.js';

/** @category Internal */
export const sqliteWorkerDataShape = defineShape({
    databasePath: '',
});

/** @category Internal */
export enum SqliteWorkerMethod {
    QueryRaw = 'query-raw',
    ExecuteRaw = 'execute-raw',
    ExecuteScript = 'execute-script',
    StartTransaction = 'start-transaction',
    Commit = 'commit',
    Rollback = 'rollback',
    Dispose = 'dispose',
}

/** @category Internal */
export type SqliteWorkerCalls = {
    [SqliteWorkerMethod.QueryRaw]: {
        params: {
            query: SqlQuery;
            transactionId: string | undefined;
        };
        result: SqlResultSet;
    };
    [SqliteWorkerMethod.ExecuteRaw]: {
        params: {
            query: SqlQuery;
            transactionId: string | undefined;
        };
        result: number;
    };
    [SqliteWorkerMethod.ExecuteScript]: {
        params: {
            script: string;
        };
        result: void;
    };
    [SqliteWorkerMethod.StartTransaction]: {
        params: {
            isolationLevel: IsolationLevel | undefined;
        };
        result: {
            transactionId: string;
            options: TransactionOptions;
        };
    };
    [SqliteWorkerMethod.Commit]: {
        params: {
            transactionId: string;
        };
        result: void;
    };
    [SqliteWorkerMethod.Rollback]: {
        params: {
            transactionId: string;
        };
        result: void;
    };
    [SqliteWorkerMethod.Dispose]: {
        params: undefined;
        result: void;
    };
};

/** @category Internal */
export type SqliteWorkerRequest<Method extends SqliteWorkerMethod = SqliteWorkerMethod> = {
    id: string;
    method: Method;
    params: SqliteWorkerCalls[Method]['params'];
};

/** @category Internal */
export type SqliteWorkerResponse =
    | {
          id: string;
          result: unknown;
      }
    | {
          id: string;
          driverAdapterError: DriverAdapterErrorPayload;
      }
    | {
          id: string;
          errorMessage: string;
      };

/**
 * Same as `new PrismaBetterSqlite3({url})` from `@prisma/adapter-better-sqlite3`, but every query
 * runs in a worker thread. better-sqlite3 blocks while SQLite reads or writes the disk, so on the
 * main thread a busy disk freezes everything else the process does.
 *
 * `workerPath` is the bundled worker (see {@link sqliteWorkerFileName}). The worker starts when
 * Prisma connects and stops on `$disconnect()`.
 *
 * @category Util
 */
export function createSqliteWorkerAdapter({
    databasePath,
    workerPath,
}: Readonly<{
    databasePath: string;
    workerPath: string;
}>): SqlDriverAdapterFactory {
    const adapterInfo = {
        provider: 'sqlite',
        adapterName: '@prisma/adapter-better-sqlite3',
    } as const;

    return {
        ...adapterInfo,
        connect() {
            const worker = new Worker(workerPath, {
                workerData: {
                    databasePath,
                } satisfies typeof sqliteWorkerDataShape.runtimeType,
            });
            const pendingCalls = new Map<
                string,
                {
                    resolve: (result: unknown) => void;
                    reject: (error: Error) => void;
                }
            >();

            /**
             * Set once the worker stops. Posting to a stopped worker is silently dropped, so a call
             * made after that would otherwise never settle.
             */
            const workerState: {
                exitError: Error | undefined;
            } = {
                exitError: undefined,
            };

            function rejectPendingCalls(error: Error) {
                pendingCalls.forEach((pendingCall) => pendingCall.reject(error));
                pendingCalls.clear();
            }

            worker.on('message', (response: SqliteWorkerResponse) => {
                const pendingCall = pendingCalls.get(response.id);
                pendingCalls.delete(response.id);
                if ('result' in response) {
                    pendingCall?.resolve(response.result);
                } else if ('driverAdapterError' in response) {
                    pendingCall?.reject(new DriverAdapterError(response.driverAdapterError));
                } else {
                    pendingCall?.reject(new Error(response.errorMessage));
                }
            });
            worker.on('error', rejectPendingCalls);
            worker.on('exit', (exitCode) => {
                workerState.exitError = new Error(`SQLite worker exited with code ${exitCode}.`);
                rejectPendingCalls(workerState.exitError);
            });

            function callWorker<const Method extends SqliteWorkerMethod>(
                method: Method,
                params: SqliteWorkerCalls[Method]['params'],
            ) {
                if (workerState.exitError) {
                    return Promise.reject(workerState.exitError);
                }
                const id = randomUUID();
                return new Promise<SqliteWorkerCalls[Method]['result']>((resolve, reject) => {
                    pendingCalls.set(id, {
                        resolve: resolve satisfies (
                            result: SqliteWorkerCalls[Method]['result'],
                        ) => void as (result: unknown) => void,
                        reject,
                    });
                    worker.postMessage({
                        id,
                        method,
                        params,
                    } satisfies SqliteWorkerRequest<Method>);
                });
            }

            function createQueryable(transactionId: string | undefined) {
                return {
                    ...adapterInfo,
                    queryRaw(query: SqlQuery) {
                        return callWorker(SqliteWorkerMethod.QueryRaw, {
                            query,
                            transactionId,
                        });
                    },
                    executeRaw(query: SqlQuery) {
                        return callWorker(SqliteWorkerMethod.ExecuteRaw, {
                            query,
                            transactionId,
                        });
                    },
                };
            }

            const adapter: SqlDriverAdapter = {
                ...createQueryable(undefined),
                async executeScript(script) {
                    await callWorker(SqliteWorkerMethod.ExecuteScript, {
                        script,
                    });
                },
                async startTransaction(isolationLevel) {
                    const {transactionId, options} = await callWorker(
                        SqliteWorkerMethod.StartTransaction,
                        {
                            isolationLevel,
                        },
                    );
                    const transaction = createQueryable(transactionId);
                    async function runSql(sql: string) {
                        await transaction.executeRaw({
                            sql,
                            args: [],
                            argTypes: [],
                        });
                    }
                    return {
                        ...transaction,
                        options,
                        async commit() {
                            await callWorker(SqliteWorkerMethod.Commit, {
                                transactionId,
                            });
                        },
                        async rollback() {
                            await callWorker(SqliteWorkerMethod.Rollback, {
                                transactionId,
                            });
                        },
                        async createSavepoint(name) {
                            await runSql(`SAVEPOINT ${name}`);
                        },
                        async rollbackToSavepoint(name) {
                            await runSql(`ROLLBACK TO ${name}`);
                        },
                        async releaseSavepoint(name) {
                            await runSql(`RELEASE SAVEPOINT ${name}`);
                        },
                    } satisfies Transaction;
                },
                async dispose() {
                    await callWorker(SqliteWorkerMethod.Dispose, undefined);
                    await worker.terminate();
                },
            };
            return Promise.resolve(adapter);
        },
    };
}
