import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {addMissingClaudeHooks, hasAnyClaudeHook} from './install-claude-hooks.js';

describe(addMissingClaudeHooks.name, () => {
    it("adds agent-storm's hooks while keeping the user's own", () => {
        const userHook = {
            hooks: [
                {
                    type: 'command',
                    command: 'cat ~/notes.md',
                },
            ],
        };
        const updated = addMissingClaudeHooks({
            model: 'opus',
            hooks: {
                UserPromptSubmit: [
                    userHook,
                ],
            },
        });

        assert.isDefined(updated);
        assert.strictEquals(updated.model, 'opus');
        assert.deepEquals((updated.hooks as Record<string, unknown[]>).UserPromptSubmit, [
            userHook,
            {
                hooks: [
                    {
                        type: 'command',
                        command: 'bash ~/.claude/agent-storm-activity.sh',
                    },
                ],
            },
        ]);
    });

    it('changes nothing once every hook is installed', () => {
        const installed = addMissingClaudeHooks({});
        assert.isDefined(installed);

        assert.isUndefined(addMissingClaudeHooks(installed));
    });
});

describe(hasAnyClaudeHook.name, () => {
    it("finds one agent-storm hook among the user's own", () => {
        assert.isTrue(
            hasAnyClaudeHook({
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: 'cat ~/notes.md',
                                },
                            ],
                        },
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: 'bash ~/.claude/agent-storm-activity.sh',
                                },
                            ],
                        },
                    ],
                },
            }),
        );
    });

    it('is false for settings without them', () => {
        assert.isFalse(
            hasAnyClaudeHook({
                model: 'opus',
            }),
        );
    });
});
