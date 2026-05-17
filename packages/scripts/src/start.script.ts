/**
 * Allocates free ports for the backend (rest-vir + Fastify) and the frontend (vite dev server),
 * then spawns runstorm with the chosen ports injected as env vars. Both processes (and any tooling
 * that reads `import.meta.env` for the vite case) see the same ports so they can talk to each
 * other.
 *
 * Honored env (override the auto-allocation): BACKEND_PORT port the backend listens on
 * FRONTEND_PORT port vite serves the frontend on
 *
 * Always exported into the child env (consumed by the workspaces): BACKEND_PORT read by
 * packages/server/src/index.ts FRONTEND_PORT read by packages/server/src/index.ts (CORS origin
 * guard) VITE_BACKEND_PORT read by packages/frontend/src/util/service-origin.ts at boot
 * VITE_FRONTEND_PORT read by packages/frontend/configs/vite.config.ts (vite's listen port)
 */
import {spawn} from 'node:child_process';
import {getPortPromise} from 'portfinder';

type Signals = NodeJS.Signals;

/**
 * Preferred starting ports. Picked from the upper IANA unassigned range — above the noisy dev-tool
 * defaults (3000/4000/5173/8000/8080/9000) and below the ephemeral range macOS uses for outbound
 * connections (49152+), with no nearby IANA-registered services. `getPortPromise` starts here and
 * walks upward if the port is occupied, so subsequent runs almost always land on the same pair
 * without surprises.
 */
const preferredBackendPort = 41880;
const preferredFrontendPort = 41881;

function envPort(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        return undefined;
    }
    return parsed;
}

async function pickFreePort(preferred: number, exclude?: number): Promise<number> {
    const startPort = exclude !== undefined && preferred === exclude ? preferred + 1 : preferred;
    const port = await getPortPromise({port: startPort});
    if (port === exclude) {
        return await getPortPromise({port: port + 1});
    }
    return port;
}

const backendPort = envPort('BACKEND_PORT') ?? (await pickFreePort(preferredBackendPort));
const frontendPort =
    envPort('FRONTEND_PORT') ?? (await pickFreePort(preferredFrontendPort, backendPort));

const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BACKEND_PORT: String(backendPort),
    FRONTEND_PORT: String(frontendPort),
    VITE_BACKEND_PORT: String(backendPort),
    VITE_FRONTEND_PORT: String(frontendPort),
};

console.log(
    `agent-storm ports: backend=${backendPort} frontend=${frontendPort}` +
        ` (override with BACKEND_PORT / FRONTEND_PORT env vars)`,
);

const child = spawn(
    'npx',
    [
        'runstorm',
        '--colors',
        'green,blue',
        '--names',
        'backend,frontend',
        'npm start --workspace @agent-storm/server',
        'npm start --workspace @agent-storm/frontend',
    ],
    {
        stdio: 'inherit',
        env: childEnv,
    },
);

function forward(signal: Signals): void {
    process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    });
}
forward('SIGINT');
forward('SIGTERM');
forward('SIGHUP');

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
    } else {
        process.exit(code ?? 0);
    }
});
