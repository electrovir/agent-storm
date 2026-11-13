import {FontRole, defaultSettings} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {getEnumValues, getObjectTypedValues} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {resolveFonts} from './typography.js';

const customTypography = {
    ...defaultSettings.typography,
    interface: {
        family: 'Example Sans',
        size: 14,
    },
    code: {
        family: 'Example Mono',
        size: 12,
    },
};

describe(resolveFonts.name, () => {
    it('leaves every role at the app default when nothing is set', () => {
        assert.deepEquals(
            getObjectTypedValues(resolveFonts(defaultSettings.typography)),
            getEnumValues(FontRole).map(() => {
                return {
                    familyCss: undefined,
                    sizePx: undefined,
                };
            }),
        );
        assert.strictEquals(resolveFonts(undefined)[FontRole.Code].sizePx, undefined);
    });

    it('makes the prompt and terminal follow the interface and code fonts', () => {
        const fonts = resolveFonts(customTypography);

        assert.deepEquals(fonts[FontRole.Prompt], fonts[FontRole.Interface]);
        assert.deepEquals(fonts[FontRole.Terminal], fonts[FontRole.Code]);
        assert.strictEquals(fonts[FontRole.Prompt].sizePx, 14);
    });

    it('uses a role own font when fonts are separate', () => {
        const fonts = resolveFonts({
            ...customTypography,
            separateFonts: true,
        });

        assert.deepEquals(fonts[FontRole.Prompt], {
            familyCss: undefined,
            sizePx: undefined,
        });
        assert.isTrue(fonts[FontRole.Interface].familyCss?.startsWith('"Example Sans", '));
    });

    it('clamps a size to the role limits', () => {
        const fonts = resolveFonts({
            ...customTypography,
            code: {
                family: '',
                size: 18,
            },
        });

        assert.strictEquals(fonts[FontRole.Terminal].sizePx, 18);
        assert.strictEquals(
            resolveFonts({
                ...customTypography,
                interface: {
                    family: '',
                    size: 99,
                },
            })[FontRole.Prompt].sizePx,
            20,
        );
    });
});
