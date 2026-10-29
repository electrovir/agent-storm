import {defineBookPage} from 'element-book';
import {html} from 'element-vir';
import {LucidePlusIcon, LucideXIcon, ViraButton, ViraColorVariant, ViraSize} from 'vira';

export const buttonsPage = defineBookPage({
    parent: undefined,
    title: 'Buttons',
    descriptionParagraphs: ['Vira buttons in their default variations.'],
    defineExamples({defineExample}) {
        defineExample({
            title: 'Variants',
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Primary',
                        icon: LucidePlusIcon,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Secondary',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Danger',
                        icon: LucideXIcon,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Danger,
                    })}></${ViraButton}>
                `;
            },
        });
    },
});
