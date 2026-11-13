/**
 * The packages a plugin imports from the app instead of bundling its own copy, since a second copy
 * of them would define its own elements, theme, and app state apart from the app's.
 */
export enum SharedModuleName {
    ElementVir = 'element-vir',
    Vira = 'vira',
    Common = '@agent-storm/common',
    CoreFrontend = '@agent-storm/core/frontend',
}

/**
 * Passed to `Symbol.for` to key the global that holds each {@link SharedModuleName}'s module, once
 * the first plugin loads.
 */
export const sharedModulesSymbolName = 'agent-storm:shared-modules';

/**
 * Passed to `Symbol.for` to key the global that holds each loaded plugin's browser module by plugin
 * id, which the plugins that depend on it import instead of bundling their own copy.
 */
export const pluginModulesSymbolName = 'agent-storm:plugin-modules';
