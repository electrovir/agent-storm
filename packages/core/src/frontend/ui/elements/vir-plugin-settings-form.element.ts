import {check} from '@augment-vir/assert';
import {mapObjectValues} from '@augment-vir/common';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    ViraForm,
    ViraFormFieldType,
    viraThemeByKeys,
    type ViraFormField,
    type ViraFormFields,
} from 'vira';
import {
    PluginSettingKind,
    type PluginSettingField,
    type PluginSettingFields,
    type PluginSettingsDefinition,
} from '../../util/plugin-settings.js';
import {defineAppElement} from '../define-app-element.js';

/** A form field's label with the setting's description beneath it. */
function createLabel(field: Readonly<PluginSettingField>) {
    return html`
        <span
            style=${css`
                display: flex;
                flex-direction: column;
            `}
        >
            <span>${field.label}</span>
            <span
                style=${css`
                    font-size: 12px;
                    font-weight: normal;
                    color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                `}
            >
                ${field.description}
            </span>
        </span>
    `;
}

/** How each kind of setting is shown as a form field, given its current value. */
const formFieldBuilders: {
    [Kind in PluginSettingKind]: (
        params: Readonly<{
            field: Extract<PluginSettingField, {kind: Kind}>;
            value: unknown;
        }>,
    ) => ViraFormField;
} = {
    [PluginSettingKind.Boolean]({field, value}) {
        return {
            type: ViraFormFieldType.Checkbox,
            label: createLabel(field),
            value: check.isBoolean(value) ? value : field.default,
        };
    },
    [PluginSettingKind.String]({field, value}) {
        return {
            type: ViraFormFieldType.Text,
            label: createLabel(field),
            value: check.isString(value) ? value : field.default,
        };
    },
    [PluginSettingKind.Number]({field, value}) {
        return {
            type: ViraFormFieldType.Number,
            label: createLabel(field),
            value: check.isNumber(value) ? value : field.default,
            min: field.min,
            max: field.max,
        };
    },
    [PluginSettingKind.Select]({field, value}) {
        return {
            type: ViraFormFieldType.Select,
            label: createLabel(field),
            value: check.isString(value) ? value : field.default,
            options: field.options,
        };
    },
    [PluginSettingKind.StringList]({field, value}) {
        return {
            type: ViraFormFieldType.TextArea,
            label: createLabel(field),
            value: (check.isArray(value) ? value : field.default).join('\n'),
            placeholder: 'One entry per line',
        };
    },
};

/**
 * How a form field's edited value becomes the setting's value. Undefined, like a cleared number,
 * resets the setting to its default.
 */
const settingValueReaders: {
    [Kind in PluginSettingKind]: (
        params: Readonly<{
            field: Extract<PluginSettingField, {kind: Kind}>;
            value: unknown;
        }>,
    ) => unknown;
} = {
    [PluginSettingKind.Boolean]({value}) {
        return value;
    },
    [PluginSettingKind.String]({value}) {
        return value;
    },
    /** Clamped, so a value typed past a bound is stored as the bound instead of being lost. */
    [PluginSettingKind.Number]({field, value}) {
        return check.isNumber(value)
            ? Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value))
            : undefined;
    },
    [PluginSettingKind.Select]({value}) {
        return value;
    },
    [PluginSettingKind.StringList]({value}) {
        return check.isString(value)
            ? value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(check.isTruthy)
            : undefined;
    },
};

/**
 * The form for a plugin's {@link PluginSettingsDefinition}. It doesn't store anything: each edit is
 * dispatched as `valueChange` with the setting's key and its new value.
 */
export const VirPluginSettingsForm = defineAppElement<{
    definition: PluginSettingsDefinition;
    /** The current value of each setting, by key. */
    values: Readonly<Record<string, unknown>>;
}>()({
    tagName: 'vir-plugin-settings-form',
    events: {
        valueChange: defineElementEvent<
            Readonly<{
                key: string;
                value: unknown;
            }>
        >(),
    },
    styles: css`
        :host {
            display: block;
        }
    `,
    render({inputs, dispatch, events}) {
        const fields: ViraFormFields = mapObjectValues(inputs.definition.fields, (key, field) => {
            return (
                formFieldBuilders[field.kind] satisfies (
                    params: Readonly<{field: any; value: unknown}>,
                ) => ViraFormField as (
                    params: Readonly<{field: PluginSettingField; value: unknown}>,
                ) => ViraFormField
            )({
                field,
                value: inputs.values[key],
            });
        });

        return html`
            <${ViraForm.assign({
                fields,
            })}
                ${listen(ViraForm.events.valueChange, (event) => {
                    const field: PluginSettingFields[string] | undefined =
                        inputs.definition.fields[event.detail.key];
                    if (!field) {
                        return;
                    }
                    dispatch(
                        new events.valueChange({
                            detail: {
                                key: event.detail.key,
                                value: (
                                    settingValueReaders[field.kind] satisfies (
                                        params: Readonly<{field: any; value: unknown}>,
                                    ) => unknown as (
                                        params: Readonly<{
                                            field: PluginSettingField;
                                            value: unknown;
                                        }>,
                                    ) => unknown
                                )({
                                    field,
                                    value: event.detail.value,
                                }),
                            },
                        }),
                    );
                })}
            ></${ViraForm}>
        `;
    },
});
