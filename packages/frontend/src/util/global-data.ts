import {assertValidShape, defineShape, nullableShape} from 'object-shape-tester';

const globalConfigShape = defineShape({
    backendPort: nullableShape(-1),
});

export type InjectedGlobalData = typeof globalConfigShape.runtimeType;
declare const VITE_INJECTED_DATA: InjectedGlobalData;

export function readInjectedGlobalData(): InjectedGlobalData {
    if (typeof VITE_INJECTED_DATA === 'undefined') {
        return {
            backendPort: null,
        };
    }

    const globalConfig: InjectedGlobalData = VITE_INJECTED_DATA;
    assertValidShape(globalConfig, globalConfigShape);

    return globalConfig;
}
