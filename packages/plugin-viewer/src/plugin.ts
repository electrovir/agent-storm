import {viewerPaneId} from '@agent-storm/common';
import {definePlugin} from '@agent-storm/core/frontend';
import {viewerPane} from './ui/viewer-pane.js';

export const viewerPlugin = definePlugin({
    id: viewerPaneId,
    name: 'Viewer',
    description: 'Tabs showing an HTML, Markdown, or image file.',
    panes: [
        viewerPane,
    ],
});
