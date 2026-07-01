/**
 * Thin wrapper around `window.agentStorm`, the bridge exposed by `packages/electron/src/preload.cjs`
 * via `contextBridge.exposeInMainWorld`. The preload is only loaded in the desktop build, so the
 * global is undefined when this code runs in a plain browser tab — the helpers below paper over
 * that so callers don't need to feature-detect at every use site.
 *
 * `parseUrl` is intentionally not used here; the open helpers are no-ops for non-https URLs but
 * the URL parsing for that check lives at call sites that already validate `prUrl`.
 */

type AgentStormBridge = {
    isElectron: true;
    openInVsCode: (folderPath: string) => Promise<{ok: boolean; error?: string}>;
};

declare global {
    interface Window {
        agentStorm?: AgentStormBridge;
    }
}

export function isRunningInElectron(): boolean {
    return !!window.agentStorm?.isElectron;
}

/**
 * Behaves like `window.open(url, '_blank', 'noopener')` in a plain browser (new tab) and like
 * `window.open(url)` in Electron (new in-app BrowserWindow, since the main process'
 * `setWindowOpenHandler` returns `{action: 'allow'}` for https URLs). Callers should pre-validate
 * the URL — this function does not.
 */
export function openHttpUrl(url: string): void {
    if (isRunningInElectron()) {
        // Default `window.open` lands in Electron's window-open handler, which spawns a new
        // BrowserWindow inside the desktop app. That's what "embed it" means here: stays inside
        // agent-storm, doesn't punch out to the system browser.
        window.open(url);
    } else {
        window.open(url, '_blank', 'noopener');
    }
}

/**
 * Launches VS Code (`code <folderPath>`) via the Electron preload bridge. No-op in a browser tab;
 * the caller is expected to check `isRunningInElectron()` first and show a different UI affordance
 * when it isn't supported.
 */
export async function openInVsCode(folderPath: string): Promise<void> {
    const bridge = window.agentStorm;
    if (!bridge) {
        return;
    }
    const result = await bridge.openInVsCode(folderPath);
    if (!result.ok) {
        console.error('openInVsCode failed:', result.error);
    }
}
