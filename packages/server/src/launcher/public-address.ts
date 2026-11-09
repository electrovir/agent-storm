import {defaultPorts, PortEnvVar, readEnvPort} from 'agent-storm';
import {readTlsOptions} from '../tls-options.js';

/** Where the browser reaches agent-storm: the port the launcher owns, and its scheme. */
export async function readPublicAddress() {
    const port = readEnvPort(PortEnvVar.Backend) ?? defaultPorts[PortEnvVar.Backend];
    const tlsOptions = await readTlsOptions();
    return {
        port,
        tlsOptions,
        origin: `${tlsOptions ? 'https' : 'http'}://localhost:${port}`,
    };
}
