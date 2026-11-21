import {defineAppElement} from '@agent-storm/core/frontend';
import {createFullDateInUserTimezone, toLocaleString} from 'date-vir';
import {css, html, nothing, unsafeCSS} from 'element-vir';
import {ViraRelativeTime, viraThemeByKeys} from 'vira';
import {type PlanLimitPoint, type PlanLimits, usageProviderLabels} from '../../usage-api.js';
import {providerColors} from '../../util/usage-chart.js';
import {VirUsageLineChart} from './vir-usage-line-chart.element.js';

function formatTime(at: number) {
    return toLocaleString(createFullDateInUserTimezone(at), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/** Each provider's plan-limit windows: how much is used, when it resets, and its history. */
export const VirUsagePlanLimits = defineAppElement<{
    planLimits: ReadonlyArray<Readonly<PlanLimits>>;
    history: ReadonlyArray<Readonly<PlanLimitPoint>>;
    /** Epoch milliseconds the history charts start at. */
    historyStartAt: number;
    isDark: boolean;
}>()({
    tagName: 'vir-usage-plan-limits',
    styles: css`
        :host {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 16px;
        }

        .provider {
            display: flex;
            flex-direction: column;
            gap: 16px;
            padding: 16px;
            border-radius: 8px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
        }

        .provider-header {
            display: flex;
            align-items: baseline;
            gap: 8px;

            & h3 {
                margin: 0;
                font-size: 16px;
            }
        }

        .muted {
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .problem {
            font-size: 13px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .window {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .window-header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 8px;
            font-size: 13px;

            & .percent {
                font-size: 16px;
                font-weight: bold;
                font-variant-numeric: tabular-nums;
            }
        }

        .meter {
            height: 8px;
            border-radius: 4px;
            overflow: hidden;
            background-color: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};

            & .meter-fill {
                height: 100%;
                border-radius: 4px;
            }
        }
    `,
    render({inputs}) {
        const now = Date.now();
        return inputs.planLimits.map((limits) => {
            const color = providerColors[limits.provider][inputs.isDark ? 'dark' : 'light'];
            return html`
                <section class="provider">
                    <div class="provider-header">
                        <h3>${usageProviderLabels[limits.provider]}</h3>
                        ${limits.planName
                            ? html`
                                  <span class="muted">${limits.planName} plan</span>
                              `
                            : nothing}
                        ${limits.checkedAt
                            ? html`
                                  <span class="muted">
                                      checked
                                      <${ViraRelativeTime.assign({
                                          time: createFullDateInUserTimezone(limits.checkedAt),
                                      })}></${ViraRelativeTime}>
                                  </span>
                              `
                            : html`
                                  <span class="muted">checking…</span>
                              `}
                    </div>
                    ${limits.problem
                        ? html`
                              <span class="problem">
                                  ${limits.windows.length
                                      ? 'The latest check failed, so these are older numbers: '
                                      : 'Plan limits are unavailable: '}
                                  ${limits.problem}
                              </span>
                          `
                        : nothing}
                    ${limits.windows.map((window) => {
                        return html`
                            <div class="window">
                                <div class="window-header">
                                    <span>${window.label}</span>
                                    <span class="percent">${Math.round(window.usedPercent)}%</span>
                                </div>
                                <div class="meter">
                                    <div
                                        class="meter-fill"
                                        style=${css`
                                            width: ${Math.min(
                                                100,
                                                Math.max(0, window.usedPercent),
                                            )}%;
                                            background-color: ${unsafeCSS(color)};
                                        `}
                                    ></div>
                                </div>
                                ${window.resetsAt
                                    ? html`
                                          <span class="muted">
                                              Resets
                                              <${ViraRelativeTime.assign({
                                                  time: createFullDateInUserTimezone(
                                                      window.resetsAt,
                                                  ),
                                              })}></${ViraRelativeTime}>
                                          </span>
                                      `
                                    : nothing}
                                <${VirUsageLineChart.assign({
                                    points: inputs.history
                                        .filter((point) => {
                                            return (
                                                point.provider === limits.provider &&
                                                point.windowId === window.windowId
                                            );
                                        })
                                        .map((point) => {
                                            return {
                                                at: point.recordedAt,
                                                percent: point.usedPercent,
                                            };
                                        }),
                                    startAt: inputs.historyStartAt,
                                    endAt: now,
                                    color,
                                    formatTime,
                                })}></${VirUsageLineChart}>
                            </div>
                        `;
                    })}
                </section>
            `;
        });
    },
});
