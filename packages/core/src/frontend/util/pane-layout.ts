import {type TabState} from '@agent-storm/common';
import {getObjectTypedEntries, typedObjectFromEntries} from '@augment-vir/common';
import {checkValidShape, partialShape, type Shape} from 'object-shape-tester';

/**
 * A tab's stored state read through its pane's shape. Each key the tab hasn't set, or set to a
 * value the shape doesn't accept, is the shape's default. Keys the shape doesn't have are dropped.
 */
export function resolveTabState<const TabStateShape extends Shape>({
    tabStateShape,
    tabState,
}: Readonly<{
    tabStateShape: TabStateShape;
    tabState: Readonly<TabState> | undefined;
}>) {
    const ownValueShape = partialShape(tabStateShape);
    const defaults: Readonly<TabState> = tabStateShape.default;
    return typedObjectFromEntries(
        getObjectTypedEntries(defaults).map(
            ([
                key,
                defaultValue,
            ]) => {
                const value = tabState?.[key];
                const isValid =
                    value !== undefined &&
                    checkValidShape(
                        {
                            [key]: value,
                        },
                        ownValueShape,
                    );
                return [
                    key,
                    isValid ? value : defaultValue,
                ];
            },
        ),
    ) satisfies TabState as TabStateShape['runtimeType'];
}
