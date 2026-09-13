# agent-storm

## Notes

-   Don't create or use `.claude/launch.json` — rely on the user's running `npm start` instead.
-   Element-vir components emit custom events via `defineElementEvent` and `dispatch(new events.X(detail))`.

## Editing this repo

The user is usually running agent-storm itself from this checkout, and it restarts on file changes. Every write you make interrupts their session, so minimize the number of write operations rather than the size of each one.

-   Work out the complete set of changes first, then apply them together: batch all edits into a single message of parallel tool calls, and prefer one full-file `Write` over a sequence of `Edit`s to the same file.
-   Don't iterate against this working tree. If a change needs experimentation, type-check cycles, or trial and error, copy the relevant files to a scratch directory outside the repo (e.g. under `/tmp`), get it right there, then apply the verified result here in one pass.
