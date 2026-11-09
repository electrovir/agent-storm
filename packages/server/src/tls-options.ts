import {extractErrorMessage, log, replaceExtension} from '@augment-vir/common';
import {readFile} from 'node:fs/promises';
import {loadSettings} from './settings.js';

/**
 * This server has to match whatever scheme the frontend is served over, because the browser builds
 * its URL from `location.protocol` (see `getBackendBaseUrl` in
 * `packages/core/src/frontend/util/service-origin.ts`). An http backend behind an https page fails
 * every request at the TLS handshake. `tlsCertPath` is the single switch for both, and the key is
 * the file of the same name beside the certificate — same convention as
 * `packages/frontend/configs/vite.config.ts`.
 */
export async function readTlsOptions() {
    const certPath = await loadSettings()
        .then((settings) => settings.tlsCertPath || '')
        .catch((error: unknown) => {
            log.warning(
                `Failed to load settings for TLS, serving without TLS: ${extractErrorMessage(error)}`,
            );
            return '';
        });
    if (!certPath) {
        return undefined;
    }
    const keyPath = replaceExtension({
        path: certPath,
        newExtension: '.key',
    });
    try {
        return {
            cert: await readFile(certPath),
            key: await readFile(keyPath),
        };
    } catch (error) {
        log.warning(
            `Serving over http: failed to read TLS cert "${certPath}" / key "${keyPath}": ${String(error)}`,
        );
        return undefined;
    }
}
