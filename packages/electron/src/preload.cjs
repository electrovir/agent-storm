/**
 * Seeds the agent-storm auth secret into the page's localStorage before any page scripts run, so
 * the auth modal is bypassed in desktop mode. The secret is read from disk by `main.mjs` and
 * forwarded here via `webPreferences.additionalArguments`, which appends to `process.argv`.
 *
 * Also exposes a tiny IPC bridge as `window.agentStorm`. The frontend uses this for two things:
 *   - feature-detect "we're in Electron" so PR-link clicks open an in-app BrowserWindow instead
 *     of falling through to the browser-only `window.open(_, '_blank')` new-tab path.
 *   - launch VS Code on a worktree path (`code <folder>`), which a plain web page can't do.
 *
 * Kept as CommonJS so it loads under all Electron preload configurations without ESM caveats.
 */
'use strict';

const {contextBridge, ipcRenderer} = require('electron');

const prefix = '--auth-secret=';
const arg = process.argv.find((value) => value.startsWith(prefix));
if (arg) {
    const secret = arg.slice(prefix.length);
    try {
        window.localStorage.setItem('agent-storm-auth-secret', secret);
    } catch (error) {
        console.error('agent-storm preload: failed to seed auth secret', error);
    }
}

contextBridge.exposeInMainWorld('agentStorm', {
    isElectron: true,
    openInVsCode: (folderPath) => ipcRenderer.invoke('agent-storm:open-in-vscode', folderPath),
});
