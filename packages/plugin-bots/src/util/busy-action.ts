import {extractErrorMessage} from '@augment-vir/common';

/**
 * Makes an element's `act`, which runs an action unless the element is already busy, keeps it busy
 * meanwhile, and shows what the action threw as the element's error. A disabled `ViraButton` still
 * fires `click`, so every listener on a button disabled while busy goes through it.
 */
export function createBusyAction({
    host,
    updateState,
}: Readonly<{
    host: Readonly<{
        instanceState: Readonly<{
            isBusy: boolean;
        }>;
    }>;
    updateState: (
        state: Partial<{
            isBusy: boolean;
            error: string | undefined;
        }>,
    ) => void;
}>) {
    return async (action: () => Promise<unknown>) => {
        if (host.instanceState.isBusy) {
            return;
        }
        updateState({
            isBusy: true,
            error: undefined,
        });
        try {
            await action();
        } catch (error) {
            updateState({
                error: extractErrorMessage(error),
            });
        } finally {
            updateState({
                isBusy: false,
            });
        }
    };
}
