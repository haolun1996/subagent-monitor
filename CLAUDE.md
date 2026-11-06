# CLAUDE.md

This repository is a Claude Code mod (a plugin of function hooks) named `subagent-changes`, published as the marketplace `haolun1996/subagent-monitor`.

## Layout

- `.claude-plugin/plugin.json` — manifest; `types` points at the state contract.
- `.claude-plugin/marketplace.json` — makes the repo installable with `/plugin install subagent-changes --marketplace haolun1996/subagent-monitor`.
- `hooks/hooks.json` — names the one hooks module.
- `hooks/register.tsx` — all the logic:
  - `agent.spawn`: records each subagent (id, type, description).
  - `turn.complete` with `agentId`: marks it done.
  - `tool.call` with `agentId`: `Write`/`Edit` (from `structuredPatch`), `NotebookEdit`, and `Bash` deletions (`rm`, `unlink`, `rmdir`, `git rm`, checked with `$.fs.exists` before and after).
  - `ui.render` on the `Pane` `subagent-changes`: draws the list.
  - `/subagent-changes [clear]` command.
- `types/index.d.ts` — `PluginState` contract for `$.state` keys `agents` and `open`.
- `tests/changes.test.tsx` — run with `claude plugin test .`.
- `.claude-plugin/types/` — written by the engine; git-ignored, never edit or commit it.

## Rules

- No DOM or Node in the module: reach everything through `$`. Elements come from `$.ui.resolve(e)`.
- Keep drawn state in `$.state` atoms, not module variables (a reload resets those).
- When the shape of `AgentRecord` / `FileChange` changes, bump the atom's `shape` tag (`agents-1` → `agents-2`) so values stored by an older version are declined.
- Tracking must never break a tool call: wrap recording after `next(e)` in `safely(...)`.
- Do not rename the plugin: the `$.state` keys are namespaced by its name.

## Checks before committing

```
claude plugin validate .
tsc -p .
claude plugin test .
```
