/**
 * The env vars `start.script.ts` hands each service its listen port through.
 *
 * @category Internal
 */
export enum PortEnvVar {
    Backend = 'BACKEND_PORT',
    Frontend = 'FRONTEND_PORT',
}

/**
 * Fixed ports, from the upper IANA unassigned range: above the noisy dev-tool defaults
 * (3000/4000/5173/8000/8080/9000) and below the ephemeral range macOS uses for outbound connections
 * (49152+), with no nearby IANA-registered services. They never walk up past a busy port, so the
 * URL the user has open stays stable across restarts; a stale process squatting on one makes that
 * server fail loudly with `EADDRINUSE` instead of silently moving and leaving the browser pointed
 * at the wrong port.
 *
 * @category Internal
 */
export const defaultPorts: Readonly<Record<PortEnvVar, number>> = {
    [PortEnvVar.Backend]: 41_880,
    [PortEnvVar.Frontend]: 41_881,
};

/**
 * The port set in `envVar`, or `undefined` when it's unset or not a valid port number.
 *
 * @category Util
 */
export function readEnvPort(envVar: PortEnvVar) {
    const parsed = Number(process.env[envVar] || Number.NaN);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}
