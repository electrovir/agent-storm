#!/bin/bash
# Records which Claude session an agent-storm tab is on, so the `claude` wrapper in ~/.zshrc can
# resume that tab's own chat. agent-storm sets AGENT_STORM_CONVERSATION_ID per tab and deletes the
# file when the tab closes or starts a new conversation.
# agent-storm copies this file to ~/.claude/ on startup, overwriting edits made there; change it in
# packages/server/src/claude-hooks/ instead.
[[ "$AGENT_STORM_CONVERSATION_ID" =~ ^[a-z0-9]+$ ]] || exit 0
session_id="$(jq -r '.session_id // empty')"
[[ -n "$session_id" ]] || exit 0
dir="${XDG_STATE_HOME:-$HOME/.local/state}/agent-storm/claude"
mkdir -p "$dir" && printf '%s\n' "$session_id" > "$dir/$AGENT_STORM_CONVERSATION_ID"
exit 0
