import {defaultFileIcon, fileIconsByExtension, fileIconsByName} from './file-icon-map.generated.js';

/**
 * URL of the file-type icon for a path, matching what VS Code's Vir Icons theme shows for the same
 * file. Icons are fetched lazily by the browser as rows render, so the whole set costs nothing
 * until a file that uses one appears.
 *
 * Lookup follows VS Code's own order: the full file name first, then progressively shorter
 * extensions. `component.element.ts` prefers an `element.ts` icon over the plain `ts` one, which is
 * what makes framework-specific icons work.
 */
export function toFileIconUrl(path: string): string {
    const fileName = (path.split('/').at(-1) || '').toLowerCase();
    const byName = fileIconsByName[fileName];
    if (byName) {
        return `/file-icons/${byName}`;
    }

    const segments = fileName.split('.');
    /**
     * Start at 1 rather than 0: the whole name was already tried above, and a dotfile's leading
     * empty segment must not be treated as an extension.
     */
    const match = segments
        .slice(1)
        .map((_segment, index) => fileIconsByExtension[segments.slice(index + 1).join('.')])
        .find((icon) => icon);

    return `/file-icons/${match || defaultFileIcon}`;
}
