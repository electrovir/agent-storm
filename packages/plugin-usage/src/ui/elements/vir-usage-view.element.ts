// cspell:word ultrafast

import {defineAppElement, isDarkMode, listenToDarkMode} from '@agent-storm/core/frontend';
import {assertWrap, check} from '@augment-vir/assert';
import {extractErrorMessage, getEnumValues} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {css, html, listen, nothing} from 'element-vir';
import {LucideRefreshCwIcon, ViraButton, ViraEmphasis, ViraSize, viraThemeByKeys} from 'vira';
import {
    type DailyUsage,
    type PlanLimitPoint,
    type PlanLimits,
    type UsageGroup,
    UsageProvider,
    usageProviderLabels,
    UsageSpeed,
    usageSpeedSuffixes,
} from '../../usage-api.js';
import {
    formatDay,
    formatTokenCount,
    formatUsd,
    listRecentDays,
    providerColors,
    toSpeedDailyValues,
    UsageMeasure,
    usageMeasureReaders,
} from '../../util/usage-chart.js';
import {usageClient} from '../../util/usage-client.js';
import {VirUsageBarChart} from './vir-usage-bar-chart.element.js';
import {renderCost, VirUsageBreakdown} from './vir-usage-breakdown.element.js';
import {VirUsagePlanLimits} from './vir-usage-plan-limits.element.js';

const dayCountOptions = [
    7,
    30,
    90,
];

const measureFormatters: Readonly<Record<UsageMeasure, (value: number) => string>> = {
    [UsageMeasure.Cost]: formatUsd,
    [UsageMeasure.Tokens]: formatTokenCount,
};

function sumTotals(daily: ReadonlyArray<Readonly<DailyUsage>>) {
    return daily.reduce(
        (sum, entry) => {
            return {
                inputTokens: sum.inputTokens + entry.totals.inputTokens,
                outputTokens: sum.outputTokens + entry.totals.outputTokens,
                cacheReadTokens: sum.cacheReadTokens + entry.totals.cacheReadTokens,
                cacheWriteTokens: sum.cacheWriteTokens + entry.totals.cacheWriteTokens,
                costUsd: sum.costUsd + entry.totals.costUsd,
                hasEstimatedCost: sum.hasEstimatedCost || entry.totals.hasEstimatedCost,
                hasUnpricedTokens: sum.hasUnpricedTokens || entry.totals.hasUnpricedTokens,
            };
        },
        {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            hasEstimatedCost: false,
            hasUnpricedTokens: false,
        },
    );
}

/** Every model's fast and ultrafast cost together. */
function renderFastCost(fastDaily: ReadonlyArray<Readonly<DailyUsage>>) {
    return fastDaily.length
        ? html`
              <td>${renderCost(sumTotals(fastDaily))}</td>
          `
        : html`
              <td>–</td>
          `;
}

function createUsageViewState() {
    return {
        dayCount: 30,
        usage: undefined as
            | Readonly<{
                  daily: ReadonlyArray<Readonly<DailyUsage>>;
                  groups: ReadonlyArray<Readonly<UsageGroup>>;
              }>
            | undefined,
        planLimits: [] as ReadonlyArray<Readonly<PlanLimits>>,
        history: [] as ReadonlyArray<Readonly<PlanLimitPoint>>,
        loadError: undefined as string | undefined,
        isRefreshing: false,
        isDark: isDarkMode(),
        stopListening: undefined as (() => void) | undefined,
    };
}

type UsageViewState = ReturnType<typeof createUsageViewState>;

/** Epoch milliseconds `dayCount` days ago. */
function findRangeStart(dayCount: number) {
    return (
        Date.now() -
        convertDuration(
            {
                days: dayCount,
            },
            {
                milliseconds: true,
            },
        ).milliseconds
    );
}

/** Loads the usage and plan-limit history of the view's selected range. */
async function loadUsage({
    state,
    updateState,
}: Readonly<{
    state: Readonly<Pick<UsageViewState, 'dayCount'>>;
    updateState: (newState: Partial<UsageViewState>) => void;
}>) {
    const dayCount = state.dayCount;
    try {
        const [
            usage,
            {points},
        ] = await Promise.all([
            usageClient.call('readUsage', {
                sinceDay: assertWrap.isDefined(listRecentDays(dayCount)[0]),
            }),
            usageClient.call('readPlanLimitHistory', {
                since: findRangeStart(dayCount),
            }),
        ]);
        /** A range picked while this loaded has its own load, which this mustn't undo. */
        if (state.dayCount === dayCount) {
            updateState({
                usage,
                history: points,
                loadError: undefined,
            });
        }
    } catch (error) {
        updateState({
            loadError: extractErrorMessage(error),
        });
    }
}

/** Plan limits, daily cost and tokens, and where the tokens went. */
export const VirUsageView = defineAppElement()({
    tagName: 'vir-usage-view',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            padding: 24px;
            overflow-y: auto;
            height: 100%;
            box-sizing: border-box;
        }

        .content {
            display: flex;
            flex-direction: column;
            gap: 24px;
            width: 100%;
            max-width: 1200px;
            align-self: center;
        }

        h2 {
            margin: 0;
            font-size: 15px;
        }

        section {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .filters {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .error {
            color: ${viraThemeByKeys.red.foreground.header.foreground.value};
        }

        .muted {
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .tiles {
            display: flex;
            flex-wrap: wrap;
            gap: 32px;

            & .tile {
                display: flex;
                flex-direction: column;
                gap: 2px;

                & .tile-value {
                    font-size: 28px;
                    font-weight: bold;
                    font-variant-numeric: tabular-nums;
                }
            }
        }

        .charts {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
            gap: 24px;
        }

        details {
            font-size: 13px;

            & summary {
                cursor: pointer;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            & table {
                margin-top: 8px;
                border-collapse: collapse;
            }

            & th,
            & td {
                padding: 4px 12px 4px 0;
                text-align: right;
                font-variant-numeric: tabular-nums;
            }

            & th {
                font-weight: normal;
                color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            }

            & th:first-child,
            & td:first-child {
                text-align: left;
            }
        }
    `,
    state: createUsageViewState,
    init({state, updateState}) {
        async function loadPlanLimits() {
            try {
                const {planLimits} = await usageClient.call('readPlanLimits', {});
                updateState({
                    planLimits,
                });
            } catch (error) {
                updateState({
                    loadError: extractErrorMessage(error),
                });
            }
        }

        void loadUsage({
            state,
            updateState,
        });
        void loadPlanLimits();
        const removers = [
            usageClient.listen('usageRecorded', async () => {
                await loadUsage({
                    state,
                    updateState,
                });
            }),
            usageClient.listen('planLimitsChanged', async ({planLimits}) => {
                updateState({
                    planLimits,
                });
                await loadUsage({
                    state,
                    updateState,
                });
            }),
        ];
        const stopReconnectListener = usageClient.listenToReconnect(async () => {
            await Promise.all([
                loadUsage({
                    state,
                    updateState,
                }),
                loadPlanLimits(),
            ]);
        });
        const stopThemeListener = listenToDarkMode((isDark) => {
            updateState({
                isDark,
            });
        });
        updateState({
            isDark: isDarkMode(),
            stopListening() {
                stopThemeListener();
                stopReconnectListener();
                void Promise.all(removers.map(async (remove) => await remove()));
            },
        });
    },
    cleanup({state}) {
        state.stopListening?.();
    },
    render({state, updateState}) {
        const days = listRecentDays(state.dayCount);
        const daily = state.usage?.daily || [];
        const totals = sumTotals(daily);

        function createSeries(measure: UsageMeasure) {
            return toSpeedDailyValues({
                daily,
                days,
                measure,
            }).map(({provider, speed, values}) => {
                return {
                    label: [
                        usageProviderLabels[provider],
                        usageSpeedSuffixes[speed],
                    ]
                        .filter(check.isTruthy)
                        .join(' '),
                    color: providerColors[provider][speed][state.isDark ? 'dark' : 'light'],
                    values,
                };
            });
        }

        return html`
            <div class="content">
                <div class="filters">
                    ${dayCountOptions.map((dayCount) => {
                        return html`
                            <${ViraButton.assign({
                                text: `${dayCount} days`,
                                buttonSize: ViraSize.Small,
                                buttonEmphasis:
                                    dayCount === state.dayCount
                                        ? ViraEmphasis.Standard
                                        : ViraEmphasis.Subtle,
                            })}
                                ${listen('click', async () => {
                                    updateState({
                                        dayCount,
                                    });
                                    await loadUsage({
                                        state,
                                        updateState,
                                    });
                                })}
                            ></${ViraButton}>
                        `;
                    })}
                    <${ViraButton.assign({
                        text: 'Check plan limits',
                        icon: LucideRefreshCwIcon,
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        isDisabled: state.isRefreshing,
                    })}
                        ${listen('click', async () => {
                            if (state.isRefreshing) {
                                return;
                            }
                            updateState({
                                isRefreshing: true,
                            });
                            try {
                                const {planLimits} = await usageClient.call(
                                    'refreshPlanLimits',
                                    {},
                                );
                                updateState({
                                    planLimits,
                                });
                            } catch (error) {
                                updateState({
                                    loadError: extractErrorMessage(error),
                                });
                            } finally {
                                updateState({
                                    isRefreshing: false,
                                });
                            }
                        })}
                    ></${ViraButton}>
                </div>
                ${state.loadError
                    ? html`
                          <span class="error">${state.loadError}</span>
                      `
                    : nothing}
                <section>
                    <h2>Plan limits</h2>
                    <${VirUsagePlanLimits.assign({
                        planLimits: state.planLimits,
                        history: state.history,
                        historyStartAt: findRangeStart(state.dayCount),
                        isDark: state.isDark,
                    })}></${VirUsagePlanLimits}>
                </section>
                <section>
                    <h2>Spending in the last ${state.dayCount} days</h2>
                    <div class="tiles">
                        <div class="tile">
                            <span class="muted">Cost</span>
                            <span class="tile-value">${renderCost(totals)}</span>
                        </div>
                        <div class="tile">
                            <span class="muted">Tokens, including cache</span>
                            <span class="tile-value">
                                ${formatTokenCount(
                                    usageMeasureReaders[UsageMeasure.Tokens](totals),
                                )}
                            </span>
                        </div>
                    </div>
                    <div class="charts">
                        <section>
                            <h2>Daily cost</h2>
                            <${VirUsageBarChart.assign({
                                columnLabels: days.map(formatDay),
                                series: createSeries(UsageMeasure.Cost),
                                formatValue: measureFormatters[UsageMeasure.Cost],
                            })}></${VirUsageBarChart}>
                        </section>
                        <section>
                            <h2>Daily tokens</h2>
                            <${VirUsageBarChart.assign({
                                columnLabels: days.map(formatDay),
                                series: createSeries(UsageMeasure.Tokens),
                                formatValue: measureFormatters[UsageMeasure.Tokens],
                            })}></${VirUsageBarChart}>
                        </section>
                    </div>
                    <details>
                        <summary>Daily numbers</summary>
                        <table>
                            <thead>
                                <tr>
                                    <th>Day</th>
                                    ${getEnumValues(UsageProvider).flatMap((provider) => {
                                        return [
                                            html`
                                                <th>${usageProviderLabels[provider]} cost</th>
                                            `,
                                            html`
                                                <th>${usageProviderLabels[provider]} tokens</th>
                                            `,
                                        ];
                                    })}
                                    <th>Fast cost</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${days.toReversed().map((day) => {
                                    return html`
                                        <tr>
                                            <td>${formatDay(day)}</td>
                                            ${getEnumValues(UsageProvider).flatMap((provider) => {
                                                const entries = daily.filter((usage) => {
                                                    return (
                                                        usage.day === day &&
                                                        usage.provider === provider
                                                    );
                                                });
                                                if (!entries.length) {
                                                    return [
                                                        html`
                                                            <td>–</td>
                                                        `,
                                                        html`
                                                            <td>–</td>
                                                        `,
                                                    ];
                                                }
                                                const providerTotals = sumTotals(entries);
                                                return [
                                                    html`
                                                        <td>${renderCost(providerTotals)}</td>
                                                    `,
                                                    html`
                                                        <td>
                                                            ${formatTokenCount(
                                                                usageMeasureReaders[
                                                                    UsageMeasure.Tokens
                                                                ](providerTotals),
                                                            )}
                                                        </td>
                                                    `,
                                                ];
                                            })}
                                            ${renderFastCost(
                                                daily.filter((usage) => {
                                                    return (
                                                        usage.day === day &&
                                                        usage.speed !== UsageSpeed.Standard
                                                    );
                                                }),
                                            )}
                                        </tr>
                                    `;
                                })}
                            </tbody>
                        </table>
                    </details>
                </section>
                <section>
                    <h2>Where it went</h2>
                    <${VirUsageBreakdown.assign({
                        groups: state.usage?.groups || [],
                    })}></${VirUsageBreakdown}>
                </section>
            </div>
        `;
    },
});
