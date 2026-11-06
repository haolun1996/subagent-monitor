export type ChangeKind = 'added' | 'modified' | 'deleted'

export type Hunk = {
  /** First line of the change in the new file (1-based). */
  start: number
  /** Last line of the change in the new file. */
  end: number
  added: number
  removed: number
}

export type FileChange = {
  path: string
  kind: ChangeKind
  /** How many tool calls touched it. */
  edits: number
  added: number
  removed: number
  /** The hunks of the latest edits, newest last. */
  hunks: Hunk[]
  /** Diff lines of the latest edit ('+', '-', ' ' prefixed). */
  preview: string[]
  at: number
}

export type AgentRecord = {
  id: string
  description: string
  type: string
  isDone: boolean
  startedAt: number
  files: FileChange[]
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-changes': {
      agents: Shaped<AgentRecord[]>
      open: Shaped<string[]>
    }
  }
}
