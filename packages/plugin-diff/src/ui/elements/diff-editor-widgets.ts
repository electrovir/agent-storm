import {ViraButton, ViraEmphasis, ViraSize, type ViraColorVariant, type ViraIconSvg} from 'vira';
import {VirDiffWidgetTooltip} from './vir-diff-widget-tooltip.element.js';

/** Keeps a press from moving the editor's selection, which would move the mobile add button. */
export function keepSelectionOnPress(button: HTMLElement) {
    button.addEventListener('mousedown', (event) => {
        event.preventDefault();
    });
}

/** CodeMirror widgets build raw DOM, so the button's inputs get assigned by hand. */
export function buildWidgetButton({
    label,
    icon,
    color,
    onClick,
}: Readonly<{
    label: string;
    icon: ViraIconSvg;
    color: ViraColorVariant;
    onClick: (button: HTMLElement) => void;
}>) {
    const button = new ViraButton();
    button.assignInputs({
        icon,
        color,
        buttonSize: ViraSize.Small,
        buttonEmphasis: ViraEmphasis.Subtle,
    });
    button.setAttribute('aria-label', label);
    keepSelectionOnPress(button);
    button.addEventListener('click', () => {
        onClick(button);
    });
    return wrapInTooltip(button, label);
}

/** Wraps hand-built DOM in {@link VirDiffWidgetTooltip}. */
export function wrapInTooltip(element: HTMLElement, text: string) {
    const wrapper = new VirDiffWidgetTooltip();
    wrapper.assignInputs({
        text,
    });
    wrapper.append(element);
    return wrapper;
}
