#!/usr/bin/env node

import {log} from '@augment-vir/common';
import {cleanup} from '../tui/main-tui.js';
import {runCli} from './run-cli.js';

try {
    runCli();
} catch (error: unknown) {
    cleanup();
    log.error('Fatal error:', error);
    process.exit(1);
}
