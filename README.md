# subagent-monitor

A Claude Code mod that adds a **Subagent changes** pane beside the chat. It lists every subagent the session starts and the files each one **added**, **modified** or **deleted**, with the lines that changed.

```
2 subagents · 2 added · 1 modified · 1 deleted

▾ general-purpose  Fix login bug  done  3 files
    A src/new.ts     +40 -0  L1-40
    M src/app.ts     +2 -1   L13-14, L40 (2 edits)
    D old/legacy.ts  deleted
```

- Click a subagent's row to collapse or expand it.
- Click an added or modified file to see the diff of its latest edit.
- A file the subagent created stays **A** through its later edits.
- Changes made in the main conversation are not listed, only subagents'.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install subagent-changes --marketplace haolun1996/subagent-monitor
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```
claude plugin install subagent-changes --marketplace haolun1996/subagent-monitor
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `haolun1996/subagent-monitor`, then Add plugin.

## Use

- The pane opens by itself when a session starts, if the terminal is wide enough (about 144 columns); otherwise run `/subagent-changes`.
- `/subagent-changes` opens the pane.
- `/subagent-changes clear` empties the log.

## How changes are detected

| Change | Source |
| --- | --- |
| Added / modified | The results of a subagent's `Write`, `Edit` and `NotebookEdit` calls, using the diffs the tools return. Line ranges cover only the changed lines, in the new file's numbering. |
| Deleted | A subagent's shell commands running `rm`, `unlink`, `rmdir` or `git rm`, when the file existed before the command and is gone after it. |

Not detected: deletions through globs (`rm *.log`) or variables, `mv`, scripts, and files changed by other shell commands (`sed -i`, build steps). Notebook edits show as modified without line ranges.

The log is kept for the session (it survives a mod reload) and holds the last 50 subagents.
