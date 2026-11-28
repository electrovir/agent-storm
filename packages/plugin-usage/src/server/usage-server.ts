import {definePluginServer, type PluginCallHandlers} from '@agent-storm/core/server';
import {
    extractErrorMessage,
    getEnumValues,
    log,
    mapEnumToObject,
    type PartialWithUndefined,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {type AnyDuration, convertDuration} from 'date-vir';
import {type PlanLimits, type PlanLimitWindow, usageApi, UsageProvider} from '../usage-api.js';
import {type UsageRecordInput, type UsageServerExports} from '../usage-exports.js';
import {readClaudePlanLimits} from './claude-plan-limits.js';
import {readCodexPlanLimits} from './codex-plan-limits.js';
import {loadModelPrices, type ModelPrices} from './model-prices.js';
import {openUsageDatabase} from './usage-database.js';
import {createUsageStore} from './usage-store.js';

function toMilliseconds(duration: Readonly<AnyDuration>) {
    return convertDuration(duration, {
        milliseconds: true,
    }).milliseconds;
}

const planLimitReaders: Readonly<
    Record<
        UsageProvider,
        (cwd: string) => Promise<
            Readonly<{
                planName: string | undefined;
                windows: PlanLimitWindow[];
            }>
        >
    >
> = {
    [UsageProvider.Claude]: readClaudePlanLimits,
    [UsageProvider.Codex]: readCodexPlanLimits,
};

export default definePluginServer({
    api: usageApi,
    async start({emit, dataDir}) {
        const prismaClient = await openUsageDatabase(dataDir);
        const store = createUsageStore(prismaClient);
        await store.deleteOldPlanLimits();

        const state: {
            prices: ModelPrices;
            planLimits: Record<UsageProvider, PlanLimits>;
            /** Each provider's reading in progress. */
            planReads: PartialWithUndefined<Record<UsageProvider, Promise<void>>>;
            /** Each provider's reading waiting out the gap between readings. */
            planReadTimers: PartialWithUndefined<
                Record<UsageProvider, ReturnType<typeof setTimeout>>
            >;
            usageEventTimer: ReturnType<typeof setTimeout> | undefined;
            isStopped: boolean;
        } = {
            prices: {},
            planLimits: mapEnumToObject(UsageProvider, (provider) => {
                return {
                    provider,
                    planName: undefined,
                    windows: [],
                    problem: undefined,
                    checkedAt: 0,
                };
            }),
            planReads: {},
            planReadTimers: {},
            usageEventTimer: undefined,
            isStopped: false,
        };

        function listPlanLimits() {
            return {
                planLimits: getEnumValues(UsageProvider).map(
                    (provider) => state.planLimits[provider],
                ),
            };
        }

        /** Tells open windows about new usage, at most once every few seconds. */
        function announceUsage() {
            if (state.usageEventTimer || state.isStopped) {
                return;
            }
            state.usageEventTimer = setTimeout(
                () => {
                    state.usageEventTimer = undefined;
                    emit('usageRecorded', {});
                },
                toMilliseconds({
                    seconds: 3,
                }),
            );
        }

        async function recordUsages(records: ReadonlyArray<UsageRecordInput>) {
            if (!records.length) {
                return;
            }
            await store.recordUsages(records, state.prices);
            announceUsage();
        }

        async function readPlanLimitsNow(provider: UsageProvider) {
            const checkedAt = Date.now();
            try {
                const {planName, windows} = await wrapPromiseInTimeout(
                    {
                        seconds: 60,
                    },
                    planLimitReaders[provider](dataDir),
                );
                await store.recordPlanLimits({
                    provider,
                    windows,
                    recordedAt: checkedAt,
                });
                state.planLimits[provider] = {
                    provider,
                    planName,
                    windows,
                    problem: undefined,
                    checkedAt,
                };
            } catch (error) {
                state.planLimits[provider] = {
                    ...state.planLimits[provider],
                    problem: extractErrorMessage(error),
                    checkedAt,
                };
            }
            if (!state.isStopped) {
                emit('planLimitsChanged', listPlanLimits());
            }
        }

        /** Joins the provider's reading in progress, if any, instead of starting another. */
        async function readPlanLimits(provider: UsageProvider) {
            const reading = state.planReads[provider] || readPlanLimitsNow(provider);
            state.planReads[provider] = reading;
            try {
                await reading;
            } finally {
                state.planReads[provider] = undefined;
            }
        }

        const minPlanReadGap = toMilliseconds({
            minutes: 1,
        });

        function notifyRateLimitsChanged(provider: UsageProvider) {
            if (state.planReadTimers[provider] || state.isStopped) {
                return;
            }
            state.planReadTimers[provider] = setTimeout(
                async () => {
                    state.planReadTimers[provider] = undefined;
                    await readPlanLimits(provider);
                },
                Math.max(0, state.planLimits[provider].checkedAt + minPlanReadGap - Date.now()),
            );
        }

        async function readAllPlanLimits() {
            await Promise.all(getEnumValues(UsageProvider).map(readPlanLimits));
        }

        async function refreshPrices() {
            try {
                state.prices = await loadModelPrices(dataDir);
                await store.estimateMissingCosts(state.prices);
                announceUsage();
            } catch (error) {
                log.warning(`Usage failed to load model prices: ${extractErrorMessage(error)}`);
            }
        }

        const intervals = [
            setInterval(
                readAllPlanLimits,
                toMilliseconds({
                    minutes: 5,
                }),
            ),
            setInterval(
                refreshPrices,
                toMilliseconds({
                    hours: 6,
                }),
            ),
        ];

        void refreshPrices();
        void readAllPlanLimits();

        const calls: PluginCallHandlers<typeof usageApi> = {
            readPlanLimits() {
                return listPlanLimits();
            },
            async refreshPlanLimits() {
                await readAllPlanLimits();
                return listPlanLimits();
            },
            async readPlanLimitHistory({since}) {
                return {
                    points: await store.readPlanLimitHistory(since),
                };
            },
            async readUsage({sinceDay}) {
                return await store.readUsage(sinceDay);
            },
        };

        return {
            calls,
            exports: {
                async recordUsage(record) {
                    await recordUsages([
                        record,
                    ]);
                },
                notifyRateLimitsChanged,
                async readThreadsCost(params) {
                    return await store.readThreadsCost(params);
                },
            } satisfies UsageServerExports,
            async stop() {
                state.isStopped = true;
                intervals.forEach((interval) => clearInterval(interval));
                clearTimeout(state.usageEventTimer);
                getEnumValues(UsageProvider).forEach((provider) => {
                    clearTimeout(state.planReadTimers[provider]);
                });
                await prismaClient.$disconnect();
            },
        };
    },
});
