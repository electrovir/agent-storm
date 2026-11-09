// cspell:words ctype

import {type OnboardingStatus} from '@agent-storm/common';
import {getEnumValues} from '@augment-vir/common';
import {InstanceEnvVar, instanceName, launcherLogPath, PortEnvVar} from 'agent-storm';
import {delimiter, dirname} from 'node:path';
import {parseUrl} from 'url-vir';
import {loadAppState, updateAppState} from './app-state.js';
import {releaseLauncherPath} from './file-paths.js';
import {isGhAvailable} from './git.js';
import {areClaudeHooksInstalled} from './install-claude-hooks.js';
import {
    canInstallLoginItem,
    installLoginItem,
    isLoginItemInstalled,
    removeLoginItem,
} from './launcher/login-item.js';
import {launcherOriginEnvVar, releaseBuild} from './release-build.js';

/**
 * Only a release the launcher runs has a launcher to start at login. Named instances are for
 * testing beside the everyday one, so they never get a login item.
 */
function canStartAtLogin() {
    return (
        !!releaseBuild &&
        !!process.env[launcherOriginEnvVar] &&
        !instanceName &&
        canInstallLoginItem()
    );
}

/**
 * A login item doesn't get the user's shell environment, so it carries what the app reads. The
 * server's own port is the launcher's private one, so the login item gets the launcher's.
 */
function getLoginItemEnv() {
    const publicPort = parseUrl(process.env[launcherOriginEnvVar] || '').port;
    return [
        'SHELL',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        ...getEnumValues(InstanceEnvVar),
    ].reduce<Record<string, string>>(
        (env, key) => {
            const value = process.env[key];
            return value
                ? {
                      ...env,
                      [key]: value,
                  }
                : env;
        },
        {
            PATH: [
                dirname(process.execPath),
                process.env.PATH,
            ]
                .filter(Boolean)
                .join(delimiter),
            ...(publicPort
                ? {
                      [PortEnvVar.Backend]: publicPort,
                  }
                : {}),
        },
    );
}

export async function readOnboardingStatus(): Promise<OnboardingStatus> {
    const [
        appState,
        areHooksInstalled,
        isGitHubConnected,
        isLoginItemPresent,
    ] = await Promise.all([
        loadAppState(),
        areClaudeHooksInstalled(),
        isGhAvailable(),
        isLoginItemInstalled(),
    ]);
    return {
        shouldShowOnboarding: !appState.isOnboardingDone && !appState.repos.length,
        canInstallClaudeHooks: !instanceName,
        areClaudeHooksInstalled: areHooksInstalled,
        isGitHubConnected,
        canStartAtLogin: canStartAtLogin(),
        isStartAtLoginEnabled: canStartAtLogin() && isLoginItemPresent,
    };
}

export async function finishOnboarding() {
    await updateAppState((state) => {
        return state.isOnboardingDone
            ? undefined
            : {
                  ...state,
                  isOnboardingDone: true,
              };
    });
}

export async function setStartAtLogin(isEnabled: boolean) {
    if (!canStartAtLogin()) {
        throw new Error("This agent-storm can't start at login.");
    }
    if (isEnabled) {
        await installLoginItem({
            nodePath: process.execPath,
            launcherPath: releaseLauncherPath,
            logPath: launcherLogPath,
            env: getLoginItemEnv(),
        });
    } else {
        await removeLoginItem();
    }
}
