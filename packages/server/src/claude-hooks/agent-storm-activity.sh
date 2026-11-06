#!/bin/bash
# cspell:words argjson
# Records whether Claude still has work in flight in an agent-storm tab, so the tab can read as busy
# through a long silent tool run or while background tasks finish after the turn ends. agent-storm
# reads the file this writes and deletes it when the tab's conversation goes away.
# agent-storm copies this file to ~/.claude/ on startup, overwriting edits made there; change it in
# packages/server/src/claude-hooks/ instead.
#
# PreToolUse and PostToolUse run this on every tool call, so it stays a single jq call. It prints
# nothing: whatever a UserPromptSubmit hook prints is added to Claude's context.
[[ "$AGENT_STORM_CONVERSATION_ID" =~ ^[a-z0-9]+$ ]] || exit 0
input="$(cat)"
dir="${AGENT_STORM_DATA_DIR:-$HOME/.agent-storm}/conversations/claude-activity"
file="$dir/$AGENT_STORM_CONVERSATION_ID"
mkdir -p "$dir" || exit 0

# agent-storm samples the CPU time of Claude's process tree to tell a slow task from a hung one.
# Hooks don't say which process is Claude, so walk up from this script until one is named claude.
claude_pid=0
if [[ "$input" =~ \"hook_event_name\"\ *:\ *\"SessionStart\" ]]; then
    pid="$PPID"
    for _ in 1 2 3 4; do
        command_name="$(ps -o comm= -p "$pid")"
        if [[ "$command_name" == claude || "$command_name" == */claude ]]; then
            claude_pid="$pid"
            break
        fi
        pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
        [[ -n "$pid" && "$pid" != 1 ]] || break
    done
fi

# Stop doesn't fire when the user interrupts a turn; agent-storm watches for that key press itself.
# Compaction also fires SessionStart, mid-turn, so it must not reset anything. Monitors watch for
# events indefinitely, so they don't count as unfinished work.
jq -c \
    --argjson claudePid "$claude_pid" \
    --arg previousText "$(cat "$file" 2>/dev/null)" \
    '
    (($previousText | try fromjson catch null) // {}) as $previous
    | .hook_event_name as $event
    | ($event == "SessionStart" and .source != "compact") as $isFresh
    | {
        claudePid: (if $claudePid > 0 then $claudePid else ($previous.claudePid // 0) end),
        turnActive: (
            if $isFresh or $event == "Stop" or $event == "StopFailure" then false
            elif $event == "Notification" then
                if (.notification_type | IN("permission_prompt", "idle_prompt", "elicitation_dialog", "elicitation_url_dialog"))
                then false
                else ($previous.turnActive // false)
                end
            elif $event == "SessionStart" or .agent_id then ($previous.turnActive // false)
            else true
            end
        ),
        isAwaitingPermission: (
            if $event == "Notification" and (.notification_type | IN("permission_prompt", "elicitation_dialog", "elicitation_url_dialog")) then true
            elif $event == "Notification" or ($event == "SessionStart" and .source == "compact") then ($previous.isAwaitingPermission // false)
            else false
            end
        ),
        backgroundTaskCount: (
            if $isFresh then 0
            elif $event == "Stop" then [.background_tasks[]? | select(.type != "monitor")] | length
            else ($previous.backgroundTaskCount // 0)
            end
        ),
        updatedAt: (now * 1000 | floor)
    }
    ' <<<"$input" >"$file.$$" && mv -f "$file.$$" "$file"
rm -f "$file.$$"
exit 0
