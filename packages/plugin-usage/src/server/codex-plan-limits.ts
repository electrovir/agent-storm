import {check} from '@augment-vir/assert';
import {extractErrorMessage} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {checkValidShape, defineShape, nullableShape, unknownShape} from 'object-shape-tester';
import {type PlanLimitWindow} from '../usage-api.js';

const codexWindowShape = defineShape({
    usedPercent: 0,
    /** Epoch seconds. */
    resetsAt: nullableShape(0),
    windowDurationMins: nullableShape(0),
});

const codexSnapshotShape = defineShape({
    planType: nullableShape(''),
    primary: nullableShape(codexWindowShape),
    secondary: nullableShape(codexWindowShape),
});

const codexResponseShape = defineShape({
    id: unknownShape(),
    result: unknownShape(),
    error: nullableShape(
        defineShape({
            message: '',
        }),
    ),
});

function labelWindow(windowDurationMins: number | null | undefined) {
    if (windowDurationMins == undefined) {
        return 'Window';
    }
    const days = windowDurationMins / (24 * 60);
    if (days === 7) {
        return 'Weekly';
    }
    const hours = windowDurationMins / 60;
    return Number.isInteger(hours) ? `${hours}-hour` : `${windowDurationMins}-minute`;
}

/**
 * The plan and windows in the result of `account/rateLimits/read`, or in the params of an
 * `account/rateLimits/updated` notification. Prefers the `codex` limit when the plan has several.
 */
export function parseCodexRateLimits(payload: unknown) {
    const snapshot: unknown =
        check.isObject(payload) &&
        check.isObject(payload.rateLimitsByLimitId) &&
        payload.rateLimitsByLimitId.codex
            ? payload.rateLimitsByLimitId.codex
            : check.isObject(payload)
              ? payload.rateLimits
              : undefined;
    if (
        !checkValidShape(snapshot, codexSnapshotShape, {
            allowExtraKeys: true,
        })
    ) {
        throw new Error('Codex answered with rate limits in an unknown format.');
    }
    return {
        planName: snapshot.planType || undefined,
        windows: [
            snapshot.primary
                ? {
                      ...snapshot.primary,
                      windowId: 'primary',
                  }
                : undefined,
            snapshot.secondary
                ? {
                      ...snapshot.secondary,
                      windowId: 'secondary',
                  }
                : undefined,
        ]
            .filter(check.isTruthy)
            .map((window): PlanLimitWindow => {
                return {
                    windowId: window.windowId,
                    label: labelWindow(window.windowDurationMins),
                    usedPercent: window.usedPercent,
                    resetsAt:
                        window.resetsAt == undefined
                            ? undefined
                            : convertDuration(
                                  {
                                      seconds: window.resetsAt,
                                  },
                                  {
                                      milliseconds: true,
                                  },
                              ).milliseconds,
                };
            }),
    };
}

/** Starts `codex app-server` just long enough to ask it for the plan's rate limits. */
export async function readCodexPlanLimits(cwd: string) {
    const child = spawn(
        /** Codex installs in too many places to pin a path, so it's found the way a shell finds it. */
        // eslint-disable-next-line sonarjs/no-os-command-from-path
        'codex',
        [
            'app-server',
        ],
        {
            cwd,
            stdio: [
                'pipe',
                'pipe',
                'ignore',
            ],
        },
    );
    const responses = new Map<number, (response: typeof codexResponseShape.runtimeType) => void>();
    const failure = Promise.withResolvers<never>();
    /** Only matters while a request races it. */
    failure.promise.catch(() => undefined);
    child.on('error', (error) => {
        failure.reject(new Error(`Codex failed to start: ${extractErrorMessage(error)}`));
    });
    child.on('exit', (exitCode) => {
        failure.reject(new Error(`Codex exited (code ${exitCode}).`));
    });
    createInterface({
        input: child.stdout,
    }).on('line', (line) => {
        try {
            const message: unknown = JSON.parse(line);
            if (
                checkValidShape(message, codexResponseShape, {
                    allowExtraKeys: true,
                }) &&
                check.isNumber(message.id)
            ) {
                responses.get(message.id)?.(message);
            }
        } catch {
            /** Codex logs lines that aren't JSON-RPC messages, which are ignored. */
        }
    });

    async function request(id: number, method: string, params: unknown) {
        const response = new Promise<typeof codexResponseShape.runtimeType>((resolve) => {
            responses.set(id, resolve);
        });
        child.stdin.write(
            `${JSON.stringify({
                id,
                method,
                params,
            })}\n`,
        );
        const {result, error} = await Promise.race([
            response,
            failure.promise,
        ]);
        if (error) {
            throw new Error(`Codex: ${error.message}`);
        }
        return result;
    }

    try {
        await request(1, 'initialize', {
            clientInfo: {
                name: 'agent-storm',
                title: 'Agent Storm',
                version: '0.0.0',
            },
            capabilities: null,
        });
        child.stdin.write(
            `${JSON.stringify({
                method: 'initialized',
            })}\n`,
        );
        return parseCodexRateLimits(await request(2, 'account/rateLimits/read', null));
    } finally {
        child.kill();
    }
}
