import {defineAppElement} from '@agent-storm/core/frontend';
import {getObjectTypedKeys} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {html} from 'element-vir';

function toShortDuration(milliseconds: number) {
    const totals = {
        day: convertDuration(
            {
                milliseconds,
            },
            {
                days: true,
            },
        ).days,
        hour: convertDuration(
            {
                milliseconds,
            },
            {
                hours: true,
            },
        ).hours,
        minute: convertDuration(
            {
                milliseconds,
            },
            {
                minutes: true,
            },
        ).minutes,
        second: convertDuration(
            {
                milliseconds,
            },
            {
                seconds: true,
            },
        ).seconds,
    };
    const unit = getObjectTypedKeys(totals).find((key) => totals[key] >= 1) || 'second';
    return new Intl.NumberFormat(undefined, {
        style: 'unit',
        unit,
        unitDisplay: 'narrow',
        maximumFractionDigits: 0,
    }).format(totals[unit]);
}

/** How long until `time` in its largest unit, such as `5m`, kept current. `0s` once it passes. */
export const VirBotsTimeUntil = defineAppElement<{
    /** Epoch milliseconds. */
    time: number;
}>()({
    tagName: 'vir-bots-time-until',
    state() {
        return {
            now: Date.now(),
            intervalId: undefined as ReturnType<typeof setInterval> | undefined,
        };
    },
    init({updateState}) {
        updateState({
            intervalId: setInterval(
                () => {
                    updateState({
                        now: Date.now(),
                    });
                },
                convertDuration(
                    {
                        seconds: 5,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        });
    },
    cleanup({state}) {
        clearInterval(state.intervalId);
    },
    render({inputs, state}) {
        return html`
            ${toShortDuration(Math.max(0, inputs.time - state.now))}
        `;
    },
});
