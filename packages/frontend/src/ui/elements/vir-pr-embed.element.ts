import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {render as litRender} from 'lit-html';
import {isRunningInElectron, openHttpUrl} from '../../util/electron-bridge.js';

/**
 * Fullscreen overlay that embeds the active PR's GitHub page inside the app.
 *
 * Implementation note: Electron's `<webview>` tag is unreliable when mounted inside a shadow
 * root — element-vir always renders into shadow DOM, so the overlay (and the webview inside it)
 * is portalled into a div appended to `document.body` instead. That keeps the webview in light
 * DOM where Electron actually wires it up to a real out-of-process webContents.
 *
 * Owned by `vir-app`: the parent flips `url` on/off and listens for `closed` to clear it.
 */
export const VirPrEmbed = defineElement<{
    /** PR URL to embed, or null/empty to hide the overlay. */
    url: string | null;
}>()({
    tagName: 'vir-pr-embed',
    events: {
        closed: defineElementEvent<void>(),
    },
    state() {
        return {
            /** The light-DOM portal div. Created in `init`, removed in `cleanup`. */
            portal: undefined as HTMLDivElement | undefined,
        };
    },
    // The host stays empty in shadow DOM — all content lives in the body-level portal below.
    styles: css`
        :host {
            display: none;
        }
    `,
    init({state, updateState}) {
        const portal = document.createElement('div');
        portal.dataset.agentStormPortal = 'pr-embed';
        document.body.appendChild(portal);
        updateState({portal});
    },
    cleanup({state}) {
        state.portal?.remove();
    },
    render({inputs, state, dispatch, events}) {
        const url = inputs.url ?? '';
        if (state.portal) {
            litRender(
                renderOverlay(url, () => dispatch(new events.closed())),
                state.portal,
            );
        }
        return html``;
    },
});

function renderOverlay(url: string, onClose: () => void) {
    if (!url) {
        return html``;
    }

    // Inline styles because the overlay lives in document.body, outside any shadow root —
    // the element's `styles` block doesn't reach here.
    const overlayStyle = [
        'position: fixed',
        'inset: 0',
        'z-index: 2000',
        'display: flex',
        'flex-direction: column',
        'background: var(--bg, #000)',
    ].join(';');

    const closeStyle = [
        'position: absolute',
        'top: 12px',
        'right: 12px',
        'width: 36px',
        'height: 36px',
        'border-radius: 50%',
        'border: 1px solid var(--border, #444)',
        'background: var(--bg, #111)',
        'color: var(--fg, #eee)',
        'font-size: 22px',
        'line-height: 1',
        'cursor: pointer',
        'display: inline-flex',
        'align-items: center',
        'justify-content: center',
        'z-index: 1',
        'font-family: var(--font-body, system-ui)',
    ].join(';');

    const webviewStyle = [
        'flex: 1 1 auto',
        'width: 100%',
        'height: 100%',
        'border: 0',
        'display: inline-flex',
    ].join(';');

    const closeButton = html`
        <button
            type="button"
            title="Close"
            aria-label="Close PR view"
            style=${closeStyle}
            ${listen('click', onClose)}
        >
            ×
        </button>
    `;

    if (isRunningInElectron()) {
        // `persist:agent-storm-github` → cookies survive across app restarts, so logging in
        // once stays good forever (until the user signs out). Electron sessions are isolated
        // from the system browser by design — there's no clean way to inherit a Chrome/Firefox
        // login here — so first open prompts a login and subsequent opens go straight in.
        //
        // `useragent` is set to a current Chrome string because GitHub serves a degraded /
        // unstyled experience to user-agents it doesn't recognise; the default Electron UA
        // includes "Electron/<ver>" and trips that codepath.
        //
        // `allowpopups` lets GitHub's OAuth / SSO flows open the second window they need.
        const chromeUserAgent =
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
        return html`
            <div style=${overlayStyle}>
                ${closeButton}
                <webview
                    src=${url}
                    partition="persist:agent-storm-github"
                    useragent=${chromeUserAgent}
                    allowpopups
                    style=${webviewStyle}
                ></webview>
            </div>
        `;
    }

    const fallbackStyle = [
        'margin: auto',
        'padding: 24px',
        'text-align: center',
        'color: var(--fg-muted, #888)',
        'font-family: var(--font-body, system-ui)',
        'font-size: 14px',
    ].join(';');

    return html`
        <div style=${overlayStyle}>
            ${closeButton}
            <div style=${fallbackStyle}>
                <p>
                    GitHub blocks in-tab embedding, so the PR can't render inside a browser dev
                    build.
                </p>
                <p>
                    <a
                        href=${url}
                        target="_blank"
                        rel="noopener"
                        style="color: var(--accent-solid, #6af); text-decoration: none"
                        ${listen('click', (event: Event) => {
                            event.preventDefault();
                            openHttpUrl(url);
                        })}
                    >
                        Open ${url} in a new tab
                    </a>
                </p>
            </div>
        </div>
    `;
}
