import {agentStormService} from '@agent-storm/common';
import {type BivariantFunction, HttpStatus} from '@augment-vir/common';
import {
    type ClientFetch,
    type DefinableHttpMethod,
    type EndpointDefinition,
    type EndpointFetchOutput,
    type EndpointFetchParams,
    type EndpointResponseType,
    RestVirClient,
} from '@rest-vir/api';
import {clearStoredSecret, ensureSecret} from './auth.js';
import {notifyBackendFailure, notifyBackendSuccess} from './backend-watchdog.js';
import {getBackendBaseUrl} from './service-origin.js';

/**
 * Inject the bearer secret on every request. The browser can't read a static header into the
 * rest-vir client, so we wrap `fetch`: each call resolves the current secret and sets the
 * `Authorization` header before delegating to the real `fetch`.
 */
const authFetch: ClientFetch = async (url, requestInit) => {
    const headers = new Headers(requestInit.headers);
    headers.set('Authorization', `Bearer ${await ensureSecret()}`);
    return await fetch(url, {
        ...requestInit,
        headers,
    });
};

/**
 * Shared rest-vir client. `baseUrl` is the page-derived backend origin; `authFetch` adds the bearer
 * header to every request. Exposed so the terminal element can open the `/pty` WebSocket through
 * the same client (and thus the same base URL derivation).
 */
export const client = new RestVirClient(agentStormService, getBackendBaseUrl(), authFetch);

/**
 * Same as `client.fetch(endpoint)[method](params)`, but returns the `Ok` response data or throws,
 * and keeps the backend watchdog informed:
 *
 * - A thrown error means the fetch itself rejected (DNS / connection refused / abort — the backend
 *   process is gone). Count it toward the watchdog's recovery threshold and rethrow.
 * - Anything other than `Ok` means the server answered with an error (every endpoint declares only
 *   `Ok`, so a non-200 surfaces as `unexpectedError`): the backend is alive (notify success), a
 *   `401` clears the stored secret, and the thrown error names the method and path.
 */
export async function fetchApi<
    const Endpoint extends EndpointDefinition & {
        path: keyof (typeof agentStormService)['endpoints'];
    },
    const Method extends Extract<keyof NoInfer<Endpoint>['requests'], DefinableHttpMethod>,
>(
    endpoint: Endpoint,
    method: Method,
    ...params: EndpointFetchParams<NoInfer<Endpoint>, NoInfer<Method>>
): Promise<EndpointResponseType<Endpoint, Method, typeof HttpStatus.Ok>> {
    /**
     * The client's per-method fetch type can't be indexed by a generic method, so the pairing of
     * this endpoint's fetch with its own params is asserted once here. The signature above is what
     * callers are checked against.
     */
    const runFetch = client.fetch(endpoint)[method] satisfies BivariantFunction<
        any,
        Promise<unknown>
    > as (...fetchParams: typeof params) => Promise<EndpointFetchOutput<any, any, true>>;
    const result = await runFetch(...params).catch((error: unknown) => {
        notifyBackendFailure();
        throw error;
    });
    notifyBackendSuccess();
    if (result.Ok) {
        return result.Ok.responseData;
    }
    const errorOutput = result.unexpectedError;
    if (errorOutput?.status === HttpStatus.Unauthorized) {
        clearStoredSecret();
    }
    throw new Error(`${method} ${endpoint.path} failed: ${String(errorOutput?.responseData)}`);
}
