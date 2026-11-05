/**
 * Whether a PR's head branch name is safe to put into a folder path, an AI prompt, or a git
 * argument. Much stricter than `git check-ref-format`: only letters, digits, `.`, `_`, `-`, and `/`
 * pass, and anything that could climb out of a folder or read as a command-line flag is rejected
 * outright rather than escaped.
 */
export function isSafeBranchName(branchName: string) {
    return (
        /^[\w./-]+$/.test(branchName) &&
        !branchName.startsWith('-') &&
        !branchName.includes('..') &&
        branchName.split('/').every((component) => {
            return (
                !!component &&
                !component.startsWith('.') &&
                !component.endsWith('.') &&
                !component.endsWith('.lock')
            );
        })
    );
}
