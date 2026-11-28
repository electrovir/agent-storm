import {resolve} from 'node:path';

/**
 * The Claude Code plugin that gives every AI thread Agent Storm's own skills. The build copies it
 * beside the server bundle.
 */
export const claudePluginDir = resolve(import.meta.dirname, 'claude-plugin');

/** The plugin's skill folders, which Codex reads directly. */
export const agentStormSkillsDir = resolve(claudePluginDir, 'skills');

/**
 * The name in the plugin's `plugin.json`. Claude Code qualifies the plugin's skills with it, as
 * `agent-storm:open-worktree`.
 */
export const claudePluginName = 'agent-storm';
