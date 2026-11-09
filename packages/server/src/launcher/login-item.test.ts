import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {buildLaunchAgentPlist, buildSystemdUnit, type LoginItemParams} from './login-item.js';

const awkwardParams: LoginItemParams = {
    nodePath: '/a & b/<node>',
    launcherPath: '/100% "launcher".js',
    logPath: '/logs/launcher.log',
    env: {
        PATH: '/bin',
    },
};

describe(buildLaunchAgentPlist.name, () => {
    it('escapes paths for XML', () => {
        const plist = buildLaunchAgentPlist(awkwardParams);

        assert.isTrue(plist.includes('<string>/a &amp; b/&lt;node&gt;</string>'));
        assert.isFalse(plist.includes('<node>'));
    });
});

describe(buildSystemdUnit.name, () => {
    it('quotes paths and escapes specifiers', () => {
        const unit = buildSystemdUnit(awkwardParams);

        assert.isTrue(
            unit.includes(String.raw`ExecStart="/a & b/<node>" "/100%% \"launcher\".js"`),
        );
    });
});
