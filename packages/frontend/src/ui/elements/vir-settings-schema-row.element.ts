import {defineAppElement, VirSettingsRow} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {type PartialWithUndefined} from '@augment-vir/common';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraCheckbox, ViraDropdown, ViraInput, ViraInputType} from 'vira';

/** The parts of a config property's JSON Schema that pick and label its row's control. */
export type SettingSchema = Readonly<
    {
        title: string;
    } & PartialWithUndefined<{
        description: string;
        type: unknown;
        enum: ReadonlyArray<string>;
    }>
>;

function hasType(schema: SettingSchema, type: string) {
    return check.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function parseList(text: string) {
    return text
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/**
 * A settings row whose control comes from a config property's JSON Schema: a dropdown for an enum,
 * a checkbox for a boolean, a comma-separated input for a string list, and a text input otherwise.
 */
export const VirSettingsSchemaRow = defineAppElement<
    {
        schema: SettingSchema;
        value: unknown;
        defaultValue: unknown;
    } & PartialWithUndefined<{
        errorMessage: string;
        isDisabled: boolean;
    }>
>()({
    tagName: 'vir-settings-schema-row',
    events: {
        valueChange: defineElementEvent<unknown>(),
    },
    state() {
        return {
            /** The list input's text, kept so typing a comma or a space isn't undone by re-joining. */
            listDraft: undefined as string | undefined,
        };
    },
    styles: css`
        :host {
            display: block;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        function emitValue(value: unknown) {
            dispatch(
                new events.valueChange({
                    detail: value,
                }),
            );
        }

        function renderControl() {
            if (inputs.schema.enum) {
                return html`
                    <${ViraDropdown.assign({
                        options: inputs.schema.enum.map((option) => {
                            return {
                                value: option,
                                label: option.charAt(0).toUpperCase() + option.slice(1),
                            };
                        }),
                        selected: check.isString(inputs.value)
                            ? [
                                  inputs.value,
                              ]
                            : [],
                        isDisabled: inputs.isDisabled,
                    })}
                        ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                            if (event.detail[0]) {
                                emitValue(event.detail[0]);
                            }
                        })}
                    ></${ViraDropdown}>
                `;
            } else if (hasType(inputs.schema, 'boolean')) {
                return html`
                    <${ViraCheckbox.assign({
                        value: inputs.value === true,
                        isDisabled: inputs.isDisabled,
                    })}
                        ${listen(ViraCheckbox.events.valueChange, (event) => {
                            emitValue(event.detail);
                        })}
                    ></${ViraCheckbox}>
                `;
            } else if (hasType(inputs.schema, 'array')) {
                const list = check.isArray(inputs.value) ? inputs.value.filter(check.isString) : [];
                const text =
                    state.listDraft != undefined &&
                    check.jsonEquals(parseList(state.listDraft), list)
                        ? state.listDraft
                        : list.join(', ');
                return html`
                    <${ViraInput.assign({
                        value: text,
                        placeholder: 'Comma separated',
                        showClearButton: true,
                        disableBrowserHelps: true,
                        disabled: inputs.isDisabled,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                listDraft: event.detail,
                            });
                            emitValue(parseList(event.detail));
                        })}
                    ></${ViraInput}>
                `;
            } else if (hasType(inputs.schema, 'number')) {
                return html`
                    <${ViraInput.assign({
                        value: check.isNumber(inputs.value) ? String(inputs.value) : '',
                        type: ViraInputType.Number,
                        disabled: inputs.isDisabled,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            const value = Number(event.detail);
                            if (event.detail && Number.isFinite(value)) {
                                emitValue(value);
                            }
                        })}
                    ></${ViraInput}>
                `;
            } else {
                return html`
                    <${ViraInput.assign({
                        value: check.isString(inputs.value) ? inputs.value : '',
                        showClearButton: true,
                        disableBrowserHelps: true,
                        disabled: inputs.isDisabled,
                        hasError: !!inputs.errorMessage,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            emitValue(event.detail);
                        })}
                    ></${ViraInput}>
                `;
            }
        }

        return html`
            <${VirSettingsRow.assign({
                rowTitle: inputs.schema.title,
                description: inputs.schema.description,
                isModified: !check.jsonEquals(inputs.value ?? null, inputs.defaultValue ?? null),
                errorMessage: inputs.errorMessage,
            })}
                ${listen(VirSettingsRow.events.reset, () => {
                    updateState({
                        listDraft: undefined,
                    });
                    emitValue(inputs.defaultValue);
                })}
            >
                ${renderControl()}
            </${VirSettingsRow}>
        `;
    },
});
