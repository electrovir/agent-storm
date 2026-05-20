# agent-storm

## Notes

- Don't create or use `.claude/launch.json` — rely on the user's running `npm start` instead.
- Element-vir components emit custom events via `defineElementEvent` and `dispatch(new events.X(detail))`.
