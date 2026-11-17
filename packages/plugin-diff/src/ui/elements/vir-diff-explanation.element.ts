import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';

/**
 * The manual-review skill's plain-text explanation of one file. Blank lines in it separate
 * paragraphs. The host's `beside` class makes it a column of its own beside the diff; `inline`
 * stacks it above the diff instead, for a phone.
 */
export const VirDiffExplanation = defineAppElement<{
    explanation: string | undefined;
}>()({
    tagName: 'vir-diff-explanation',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 8px;
            box-sizing: border-box;
            flex-shrink: 0;
            padding: 8px 10px;
            font-size: 12px;
            overflow-y: auto;
            overflow-wrap: anywhere;
            background: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        :host(.beside) {
            width: 280px;
            border-left: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        :host(.inline) {
            max-height: 30vh;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .label,
        .missing {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .label {
            font-size: 11px;
            font-weight: bold;
        }

        p {
            margin: 0;
        }
    `,
    render({inputs}) {
        const paragraphs = (inputs.explanation || '')
            .split(/\n\s*\n/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean);
        return html`
            <span class="label">AI explanation</span>
            ${paragraphs.length
                ? paragraphs.map((paragraph) => {
                      return html`
                          <p>${paragraph}</p>
                      `;
                  })
                : html`
                      <span class="missing">None was written for this file.</span>
                  `}
        `;
    },
});
