import {query, type SDKControlGetUsageResponse} from '@anthropic-ai/claude-agent-sdk';
import {getObjectTypedEntries} from '@augment-vir/common';
import {type PlanLimitWindow} from '../usage-api.js';

/** The windows of `rate_limits` worth showing, by their key there. */
const claudeWindowLabels = {
    five_hour: '5-hour',
    seven_day: 'Weekly',
    seven_day_opus: 'Weekly Opus',
    seven_day_sonnet: 'Weekly Sonnet',
    seven_day_oauth_apps: 'Weekly apps',
} as const satisfies Partial<
    Record<keyof NonNullable<SDKControlGetUsageResponse['rate_limits']>, string>
>;

/** The windows in a Claude usage answer. */
export function parseClaudePlanWindows(
    rateLimits: Readonly<
        Pick<
            NonNullable<SDKControlGetUsageResponse['rate_limits']>,
            keyof typeof claudeWindowLabels | 'model_scoped'
        >
    >,
): PlanLimitWindow[] {
    const namedWindows = getObjectTypedEntries(claudeWindowLabels).flatMap(
        ([
            windowId,
            label,
        ]) => {
            const window = rateLimits[windowId];
            return window?.utilization == undefined
                ? []
                : [
                      {
                          windowId,
                          label,
                          usedPercent: window.utilization,
                          resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined,
                      },
                  ];
        },
    );
    const modelWindows = (rateLimits.model_scoped || []).flatMap((window) => {
        return window.utilization == undefined
            ? []
            : [
                  {
                      windowId: `model:${window.display_name}`,
                      label: `Weekly ${window.display_name}`,
                      usedPercent: window.utilization,
                      resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined,
                  },
              ];
    });
    return [
        ...namedWindows,
        ...modelWindows,
    ];
}

/**
 * Asks Claude Code for the plan's rate-limit usage, the way its `/usage` dialog does. Starts a
 * Claude process that never gets a prompt, so it spends no tokens.
 */
export async function readClaudePlanLimits(cwd: string) {
    const abortController = new AbortController();
    const claudeQuery = query({
        prompt: createNeverEndingPrompt(abortController.signal),
        options: {
            cwd,
            abortController,
            /**
             * Skips connecting MCP servers. This process closes right after reading the limits, and
             * closing it mid-way through refreshing Slack's OAuth token signs every session out of
             * Slack.
             */
            strictMcpConfig: true,
        },
    });
    try {
        await claudeQuery.initializationResult();
        const usage = await claudeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
        });
        if (!usage.rate_limits_available || !usage.rate_limits) {
            throw new Error(
                'Claude has no plan limits to show: it is signed in with an API key or the limits are unavailable.',
            );
        }
        return {
            planName: usage.subscription_type || undefined,
            windows: parseClaudePlanWindows(usage.rate_limits),
        };
    } finally {
        abortController.abort();
        claudeQuery.close();
    }
}

/** A prompt stream that stays open without a message until `signal` aborts. */
async function* createNeverEndingPrompt(signal: AbortSignal) {
    await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), {
            once: true,
        });
    });
    yield* [];
}
