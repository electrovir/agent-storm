import {AnyOrigin, defineService} from '@rest-vir/define-service';
import {defineShape} from 'object-shape-tester';

const ptyMessageShape = defineShape('');

export const ptyService = defineService({
    serviceName: 'agent-storm-pty',
    serviceOrigin: 'http://localhost:3000',
    requiredClientOrigin: AnyOrigin,
    endpoints: {},
    webSockets: {
        '/pty': {
            messageFromClientShape: ptyMessageShape,
            messageFromHostShape: ptyMessageShape,
        },
    },
});
