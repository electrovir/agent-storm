import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {checkValidShape} from 'object-shape-tester';
import {agentStormConfigShape, defineAgentStormConfig} from './agent-storm-config.js';

describe('agentStormConfigShape', () => {
    it('accepts folder settings beside bots', () => {
        assert.isTrue(
            checkValidShape(
                defineAgentStormConfig({
                    reviewSkill: '/review-branch local',
                    forges: {
                        github: {
                            trustedBotLogins: [
                                'repo-bot',
                            ],
                        },
                    },
                    bots: {
                        release: '../bots/release.bot.ts',
                        inline: {
                            description: 'Says hi.',
                        },
                    },
                }),
                agentStormConfigShape,
            ),
        );
    });
    it('rejects a bot that is neither a module path nor a bot', () => {
        assert.isFalse(
            checkValidShape(
                {
                    bots: {
                        broken: 5,
                    },
                },
                agentStormConfigShape,
            ),
        );
    });
});
