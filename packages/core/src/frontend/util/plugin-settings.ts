import {type Settings} from '@agent-storm/common';
import {assert, check} from '@augment-vir/assert';
import {
    getObjectTypedEntries,
    mapObjectValues,
    omitObjectKeys,
    typedObjectFromEntries,
    type PartialWithUndefined,
} from '@augment-vir/common';

/** The kinds of setting a plugin can define, each rendered as its own form field. */
export enum PluginSettingKind {
    Boolean = 'boolean',
    String = 'string',
    Number = 'number',
    Select = 'select',
    StringList = 'stringList',
}

export type PluginSettingOption = Readonly<{
    /** What is stored. */
    value: string;
    label: string;
}>;

/** One setting of a plugin. `default` is the value of a setting the user hasn't changed. */
export type PluginSettingField = Readonly<{
    label: string;
    description: string;
}> &
    (
        | Readonly<{
              kind: PluginSettingKind.Boolean;
              default: boolean;
          }>
        | Readonly<{
              kind: PluginSettingKind.String;
              default: string;
          }>
        | (Readonly<{
              kind: PluginSettingKind.Number;
              default: number;
          }> &
              PartialWithUndefined<{
                  min: number;
                  max: number;
              }>)
        | Readonly<{
              kind: PluginSettingKind.Select;
              options: ReadonlyArray<PluginSettingOption>;
              default: string;
          }>
        | Readonly<{
              kind: PluginSettingKind.StringList;
              default: ReadonlyArray<string>;
          }>
    );

export type PluginSettingFields = Readonly<Record<string, PluginSettingField>>;

/** What {@link definePluginSettings} returns. A plugin lists it as its `settings`. */
export type PluginSettingsDefinition<Fields extends PluginSettingFields = PluginSettingFields> =
    Readonly<{
        fields: Fields;
    }>;

type FixedKindValues = {
    [PluginSettingKind.Boolean]: boolean;
    [PluginSettingKind.String]: string;
    [PluginSettingKind.Number]: number;
    [PluginSettingKind.StringList]: ReadonlyArray<string>;
};

/** The type of a setting's value: its option values for a select, otherwise by its kind. */
export type PluginSettingValue<Field extends PluginSettingField> = Field extends {
    kind: PluginSettingKind.Select;
    options: infer Options extends ReadonlyArray<PluginSettingOption>;
}
    ? Options[number]['value']
    : FixedKindValues[Exclude<Field['kind'], PluginSettingKind.Select>];

/** The values of every setting in `Fields`, as a plugin reads them. */
export type PluginSettingValues<Fields extends PluginSettingFields> = Readonly<{
    [Key in keyof Fields]: PluginSettingValue<Fields[Key]>;
}>;

/** The keys of the selects whose `default` is not one of their options' values. */
type InvalidSelectDefaultKeys<Fields extends PluginSettingFields> = {
    [Key in keyof Fields]: Fields[Key] extends {
        kind: PluginSettingKind.Select;
        options: infer Options extends ReadonlyArray<PluginSettingOption>;
        default: infer Default;
    }
        ? [Default] extends [Options[number]['value']]
            ? never
            : Key
        : never;
}[keyof Fields];

/**
 * Defines the settings a plugin adds to the Settings modal, where the host renders a form for them,
 * and the types of their values. Works for built-in and external plugins alike: list the result as
 * the plugin's `settings`, then read the values with the app context's `readPluginSettings`.
 */
export function definePluginSettings<const Fields extends PluginSettingFields>(
    fields: Fields,
    ...errorParams: [InvalidSelectDefaultKeys<Fields>] extends [never]
        ? []
        : [
              `ERROR: the default of '${InvalidSelectDefaultKeys<Fields> & string}' is not one of its options.`,
          ]
): PluginSettingsDefinition<Fields> {
    assert.isEmpty(errorParams);
    getObjectTypedEntries(fields as PluginSettingFields).forEach(
        ([
            key,
            field,
        ]) => {
            if (
                field.kind === PluginSettingKind.Select &&
                !field.options.some((option) => option.value === field.default)
            ) {
                throw new Error(`The default of '${key}' is not one of its options.`);
            }
        },
    );
    return {
        fields,
    };
}

type KindValidators = {
    [Kind in PluginSettingKind]: (
        params: Readonly<{
            field: Extract<PluginSettingField, {kind: Kind}>;
            value: unknown;
        }>,
    ) => boolean;
};

const kindValidators: KindValidators = {
    [PluginSettingKind.Boolean]({value}) {
        return check.isBoolean(value);
    },
    [PluginSettingKind.String]({value}) {
        return check.isString(value);
    },
    [PluginSettingKind.Number]({field, value}) {
        return (
            check.isNumber(value) &&
            Number.isFinite(value) &&
            (field.min == undefined || value >= field.min) &&
            (field.max == undefined || value <= field.max)
        );
    },
    [PluginSettingKind.Select]({field, value}) {
        return check.isString(value) && field.options.some((option) => option.value === value);
    },
    [PluginSettingKind.StringList]({value}) {
        return check.isArray(value) && value.every((entry) => check.isString(entry));
    },
};

/** Whether `value` is one `field` accepts, which is what separates a stored value from a default. */
export function isPluginSettingValueValid({
    field,
    value,
}: Readonly<{
    field: PluginSettingField;
    value: unknown;
}>) {
    return (
        kindValidators[field.kind] satisfies (
            params: Readonly<{field: any; value: unknown}>,
        ) => boolean as (params: Readonly<{field: PluginSettingField; value: unknown}>) => boolean
    )({
        field,
        value,
    });
}

type PluginWithSettings<Fields extends PluginSettingFields> = Readonly<{
    id: string;
    settings?: PluginSettingsDefinition<Fields> | undefined;
}>;

function readStoredValues({
    pluginId,
    settings,
}: Readonly<{
    pluginId: string;
    settings: Readonly<Pick<Settings, 'pluginSettings'>> | undefined;
}>): Readonly<Record<string, unknown>> {
    const stored = settings?.pluginSettings?.[pluginId];
    return check.isObject(stored) ? stored : {};
}

/**
 * Each setting's stored value, or its default when the stored one is missing or doesn't suit the
 * setting's definition. The server can't make that check for an external plugin, so this is where
 * stored values are validated.
 */
export function resolvePluginSettings<const Fields extends PluginSettingFields>({
    plugin,
    settings,
}: Readonly<{
    plugin: PluginWithSettings<Fields>;
    settings: Readonly<Pick<Settings, 'pluginSettings'>> | undefined;
}>) {
    const stored = readStoredValues({
        pluginId: plugin.id,
        settings,
    });
    const fields: PluginSettingFields = plugin.settings?.fields || {};
    return mapObjectValues(fields, (key, field) => {
        return isPluginSettingValueValid({
            field,
            value: stored[key],
        })
            ? stored[key]
            : field.default;
    }) satisfies Readonly<Record<string, unknown>> as PluginSettingValues<Fields>;
}

/**
 * Stores `value` as the plugin's setting `key`. An undefined `value` resets the setting to its
 * default, and a `value` the setting doesn't accept changes nothing. Only values that differ from
 * their default are saved, so a later change to a default still reaches the user and a plugin with
 * nothing changed has no entry.
 */
export function writePluginSetting<const Fields extends PluginSettingFields>({
    plugin,
    settings,
    key,
    value,
}: Readonly<{
    plugin: PluginWithSettings<Fields>;
    settings: Readonly<Settings>;
    key: string;
    value: unknown;
}>): Settings {
    const fields: PluginSettingFields = plugin.settings?.fields || {};
    const field = fields[key];
    if (
        !field ||
        (value !== undefined &&
            !isPluginSettingValueValid({
                field,
                value,
            }))
    ) {
        return settings;
    }
    const resolved: Readonly<Record<string, unknown>> = resolvePluginSettings({
        plugin,
        settings,
    });
    const changed = getObjectTypedEntries(fields).flatMap(
        ([
            fieldKey,
            fieldDefinition,
        ]) => {
            const fieldValue =
                fieldKey === key ? (value ?? fieldDefinition.default) : resolved[fieldKey];
            return check.deepEquals(fieldValue, fieldDefinition.default)
                ? []
                : [
                      [
                          fieldKey,
                          fieldValue,
                      ] as const,
                  ];
        },
    );
    const others = omitObjectKeys(settings.pluginSettings || {}, [plugin.id]);
    return {
        ...settings,
        pluginSettings: changed.length
            ? {
                  ...others,
                  [plugin.id]: typedObjectFromEntries(changed),
              }
            : others,
    };
}

/** Puts every one of the plugin's settings back to its default. */
export function restorePluginSettings({
    plugin,
    settings,
}: Readonly<{
    plugin: Readonly<Pick<PluginWithSettings<PluginSettingFields>, 'id'>>;
    settings: Readonly<Settings>;
}>): Settings {
    return {
        ...settings,
        pluginSettings: omitObjectKeys(settings.pluginSettings || {}, [plugin.id]),
    };
}

/** Whether any of the plugin's settings differs from its default. */
export function isPluginSettingsModified<const Fields extends PluginSettingFields>({
    plugin,
    settings,
}: Readonly<{
    plugin: PluginWithSettings<Fields>;
    settings: Readonly<Pick<Settings, 'pluginSettings'>>;
}>) {
    const resolved: Readonly<Record<string, unknown>> = resolvePluginSettings({
        plugin,
        settings,
    });
    const fields: PluginSettingFields = plugin.settings?.fields || {};
    return getObjectTypedEntries(fields).some(
        ([
            key,
            field,
        ]) => {
            return !check.deepEquals(resolved[key], field.default);
        },
    );
}
