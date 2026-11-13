import {definePlugin} from '@agent-storm/core/frontend';
import {diffV2Pane} from './ui/elements/diff-v2-pane.js';

export const diffV2Plugin = definePlugin({
    id: 'diff-v2',
    name: 'Diff V2',
    description: 'A Diff tab drawn by @pierre/diffs.',
    panes: [
        diffV2Pane,
    ],
});
