/**
 * Comment bodies are rendered from GitHub's own `bodyHTML` rather than by parsing the markdown
 * source in the browser. That gets code fences, tables, task lists, issue references, and
 * `@mentions` looking exactly like github.com for free, with no markdown dependency — but it means
 * putting remote HTML into the page, so it goes through this scrub first.
 *
 * GitHub already sanitizes `bodyHTML` server-side. This pass is deliberately not trusting that: it
 * is an allow-list over element names and attributes, so anything GitHub's own sanitizer might ever
 * let through still has to be on the list here to survive.
 */

/**
 * Elements GitHub-flavored markdown can legitimately produce. Everything else is unwrapped or
 * dropped. `DETAILS` / `SUMMARY` are here because collapsible sections are ordinary GFM and work
 * natively in the browser with no script. `INPUT` is here for task-list checkboxes only, and is
 * force-disabled below — GitHub emits them already disabled, and a checkbox in a comment has
 * nothing to submit to.
 */
const allowedTags: ReadonlyArray<string> = [
    'A',
    'ABBR',
    'B',
    'BLOCKQUOTE',
    'BR',
    'CODE',
    'DD',
    'DEL',
    'DETAILS',
    'DIV',
    'DL',
    'DT',
    'EM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HR',
    'I',
    'IMG',
    'INPUT',
    'KBD',
    'LI',
    'MARK',
    'OL',
    'P',
    'PRE',
    'S',
    'SPAN',
    'STRONG',
    'SUB',
    'SUMMARY',
    'SUP',
    'TABLE',
    'TBODY',
    'TD',
    'TFOOT',
    'TH',
    'THEAD',
    'TR',
    'UL',
];

/**
 * Tags whose _contents_ are dropped along with the tag, rather than being unwrapped in place. For
 * everything else, removing the tag but keeping its text is the friendlier failure mode: an unknown
 * wrapper shouldn't silently delete a paragraph.
 */
const strippedTags: ReadonlyArray<string> = [
    'SCRIPT',
    'STYLE',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'LINK',
    'META',
    'FORM',
    'BUTTON',
    'SELECT',
    'TEXTAREA',
    'SVG',
    'MATH',
    'TEMPLATE',
    'NOSCRIPT',
];

const allowedAttributes: Readonly<Record<string, ReadonlyArray<string>>> = {
    A: [
        'href',
        'title',
    ],
    IMG: [
        'src',
        'alt',
        'title',
    ],
    /** Whether a collapsible section starts expanded is part of what the author wrote. */
    DETAILS: ['open'],
    INPUT: [
        'type',
        'checked',
    ],
    TD: ['align'],
    TH: ['align'],
};

/** Anything that isn't plainly a fetch of a remote or in-page resource. */
function isSafeUrl(value: string): boolean {
    const trimmed = value.trim().toLowerCase();
    return (
        trimmed.startsWith('https://') ||
        trimmed.startsWith('http://') ||
        trimmed.startsWith('mailto:') ||
        trimmed.startsWith('#')
    );
}

function scrubElement(element: Element): void {
    /** Snapshot before mutating: `children` is live and would skip elements as they're removed. */
    Array.from(element.children).forEach(scrubElement);

    if (strippedTags.includes(element.tagName)) {
        element.remove();
        return;
    } else if (!allowedTags.includes(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes));
        return;
    }
    const allowed = allowedAttributes[element.tagName] || [];
    element.getAttributeNames().forEach((name) => {
        const value = element.getAttribute(name) || '';
        if (!allowed.includes(name) || ((name === 'href' || name === 'src') && !isSafeUrl(value))) {
            element.removeAttribute(name);
        }
    });
    if (element.tagName === 'A') {
        /** Links point at github.com, which refuses to be framed and shouldn't replace the app. */
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
    } else if (element.tagName === 'INPUT') {
        /**
         * Task-list checkboxes are the only inputs markdown produces. Anything else claiming to be
         * an input is turned into one, and every one of them is read-only — ticking a box here
         * wouldn't write back to GitHub, so an interactive box would just lie.
         */
        element.setAttribute('type', 'checkbox');
        element.setAttribute('disabled', '');
    }
}

/**
 * Scrub one of GitHub's rendered HTML strings down to the allow-list above. Returns a string so it
 * can go through lit's `unsafeHTML`; it is only "unsafe" in the sense that lit doesn't escape it.
 */
export function sanitizeGitHubHtml(html: string): string {
    if (!html) {
        return '';
    }
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    Array.from(parsed.body.children).forEach(scrubElement);
    return parsed.body.innerHTML;
}
