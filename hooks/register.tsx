import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRecord, ChangeKind, FileChange, Hunk } from '../types'

const PANE = 'subagent-changes'
const TITLE = 'Subagent changes'
const MAX_PREVIEW = 60
const MAX_HUNKS = 12

// Bump the shape tag when AgentRecord / FileChange change: it declines what an
// earlier version stored, which outlives a reload.
const agents = atom({ plugin: 'subagent-changes', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
// Expanded rows: an agent id, or `${agentId}\u0000${path}` for a file's diff.
const open = atom({ plugin: 'subagent-changes', key: 'open' } as const, [], {
  shape: 'open-1',
})

type Patch = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

let cwd = ''

const absolute = (path: string) =>
  path.startsWith('/') || cwd === '' ? path : `${cwd.replace(/\/$/, '')}/${path}`

const relative = (path: string) => {
  const root = cwd.replace(/\/$/, '') + '/'
  return cwd !== '' && path.startsWith(root) ? path.slice(root.length) : path
}

/** Adds or merges one change of one file into an agent's record. */
const record = async (
  $: EngineInterface,
  agentId: string,
  path: string,
  kind: ChangeKind,
  patches: readonly Patch[],
) => {
  const hunks: Hunk[] = []
  const preview: string[] = []
  let added = 0
  let removed = 0
  for (const p of patches) {
    const plus = p.lines.filter(l => l.startsWith('+')).length
    const minus = p.lines.filter(l => l.startsWith('-')).length
    added += plus
    removed += minus
    // The changed lines alone, in the new file's numbering: a hunk carries
    // unchanged context lines around them, and a removal marks where it was.
    let line = Math.max(p.newStart, 1)
    let first = Infinity
    let last = -Infinity
    for (const l of p.lines) {
      if (l.startsWith('+') || l.startsWith('-')) {
        first = Math.min(first, line)
        last = Math.max(last, line)
      }
      if (!l.startsWith('-') && !l.startsWith('\\')) line += 1
    }
    if (first === Infinity) continue
    hunks.push({ start: first, end: Math.max(first, last), added: plus, removed: minus })
    if (preview.length < MAX_PREVIEW) {
      preview.push(`@@ -${p.oldStart},${p.oldLines} +${p.newStart},${p.newLines} @@`)
      preview.push(...p.lines.slice(0, MAX_PREVIEW - preview.length))
    }
  }

  const known = (await read($, agents)).some(a => a.id === agentId)
  let description = ''
  let type = 'subagent'
  if (!known) {
    // Spawned before the mod loaded: ask the engine who it is.
    const info = (await $.agent.list()).find(a => a.id === agentId)
    description = info?.description ?? ''
    type = info?.type ?? 'subagent'
  }

  await update($, agents, list => {
    const base: AgentRecord[] = known
      ? list
      : [
          ...list,
          { id: agentId, description, type, isDone: false, startedAt: Date.now(), files: [] },
        ]

    return base.map(agent => {
      if (agent.id !== agentId) return agent
      const shown = relative(path)
      const prev = agent.files.find(f => f.path === shown)
      // A file the agent created stays "added" through its later edits; a
      // deletion wins; a file deleted then written again is "modified".
      const merged: ChangeKind =
        kind === 'deleted'
          ? 'deleted'
          : prev === undefined
            ? kind
            : prev.kind === 'added'
              ? 'added'
              : 'modified'
      const next: FileChange = {
        path: shown,
        kind: merged,
        edits: (prev?.edits ?? 0) + 1,
        added: (prev?.added ?? 0) + added,
        removed: (prev?.removed ?? 0) + removed,
        hunks: [...(prev?.hunks ?? []), ...hunks].slice(-MAX_HUNKS),
        preview: kind === 'deleted' ? [] : preview,
        at: Date.now(),
      }
      const files = prev
        ? agent.files.map(f => (f.path === shown ? next : f))
        : [...agent.files, next]

      return { ...agent, files }
    })
  })
}

const STRIP_QUOTES = /^(['"])(.*)\1$/

/** The paths a shell command means to delete: rm, unlink, rmdir, git rm. */
const deletionTargets = (command: string): string[] => {
  const targets: string[] = []
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'sudo') words.shift()
    let args: string[] = []
    if (words[0] === 'rm' || words[0] === 'unlink' || words[0] === 'rmdir') {
      args = words.slice(1)
    } else if (words[0] === 'git' && words[1] === 'rm') {
      args = words.slice(2)
    } else continue
    for (const raw of args) {
      if (raw.startsWith('-')) continue
      const word = raw.replace(STRIP_QUOTES, '$2')
      if (/[*?$`{}]/.test(word)) continue // globs and expansions: unknowable here
      targets.push(word)
    }
  }

  return targets
}

const patchesOf = (result: unknown): Patch[] => {
  const patch = (result as { structuredPatch?: unknown } | undefined)?.structuredPatch

  return Array.isArray(patch) ? (patch as Patch[]) : []
}

const isStaged = (result: unknown) =>
  (result as { staged?: boolean } | undefined)?.staged === true

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd().catch(() => '')
    await $.command.register({
      name: 'subagent-changes',
      description: 'Show the files each subagent added, modified or deleted (args: clear)',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'subagent-changes' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, () => [])
      await update($, open, () => [])

      return { text: 'Subagent change log cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Subagent changes pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined) {
      const id = started.agentId
      await update($, agents, list =>
        list.some(a => a.id === id)
          ? list
          : [
              ...list,
              {
                id,
                description: e.description ?? '',
                type: e.subagentType || 'general-purpose',
                isDone: false,
                startedAt: Date.now(),
                files: [],
              },
            ].slice(-50),
      )
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      await update($, agents, list =>
        list.map(a => (a.id === id ? { ...a, isDone: true } : a)),
      )
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    // Watching must never break the tool call: a failure here only skips the log.
    const safely = (work: Promise<unknown>) => work.catch(() => undefined)

    if (e.tool === 'Write' || e.tool === 'Edit') {
      const ran = await next(e)
      if (ran.result === undefined || ran.isError || isStaged(ran.result)) return ran
      const res = ran.result as { type?: string; filePath?: string }
      const kind: ChangeKind = e.tool === 'Write' && res.type === 'create' ? 'added' : 'modified'
      await safely(record($, agentId, res.filePath ?? e.file_path, kind, patchesOf(ran.result)))

      return ran
    }

    if (e.tool === 'NotebookEdit') {
      const ran = await next(e)
      if (ran.result === undefined || ran.isError) return ran
      await safely(record($, agentId, e.notebook_path, 'modified', []))

      return ran
    }

    if (e.tool === 'Bash') {
      const targets = deletionTargets(e.command)
      if (targets.length === 0) return next(e)
      const before = await Promise.all(
        targets.map(t => $.fs.exists(absolute(t)).catch(() => false)),
      )
      const ran = await next(e)
      for (const [i, t] of targets.entries()) {
        if (!before[i]) continue
        const gone = !(await $.fs.exists(absolute(t)).catch(() => true))
        if (gone) await safely(record($, agentId, absolute(t), 'deleted', []))
      }

      return ran
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const expanded = new Set(await read($, open))

    const toggle = (key: string) => () =>
      update($, open, keys =>
        keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key],
      )

    const badge = (kind: ChangeKind) =>
      kind === 'added' ? (
        <Text color="success" bold>A</Text>
      ) : kind === 'deleted' ? (
        <Text color="error" bold>D</Text>
      ) : (
        <Text color="warning" bold>M</Text>
      )

    const ranges = (f: FileChange) =>
      f.kind === 'deleted'
        ? ''
        : f.hunks.map(h => (h.start === h.end ? `L${h.start}` : `L${h.start}-${h.end}`)).join(', ')

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No subagents yet.</Text>
          <Text dimColor>Files a subagent adds, modifies or deletes show here.</Text>
        </Box>
      )
    }

    const totals = list.reduce(
      (t, a) => {
        for (const f of a.files) t[f.kind] += 1
        return t
      },
      { added: 0, modified: 0, deleted: 0 },
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {list.length} subagent{list.length === 1 ? '' : 's'} · {totals.added} added ·{' '}
          {totals.modified} modified · {totals.deleted} deleted
        </Text>
        {[...list].reverse().map(agent => {
          const isOpen = !expanded.has(`${agent.id}\u0000collapsed`)
          return (
            <Box flexDirection="column" marginTop={1}>
              <Button key={`agent-${agent.id}`} onPress={toggle(`${agent.id}\u0000collapsed`)}>
                {isOpen ? '▾' : '▸'} <Text bold>{agent.type}</Text>{' '}
                <Text>{agent.description || agent.id.slice(0, 8)}</Text>{' '}
                <Text color={agent.isDone ? 'subtle' : 'claude'}>
                  {agent.isDone ? 'done' : 'running'}
                </Text>{' '}
                <Text dimColor>
                  {agent.files.length} file{agent.files.length === 1 ? '' : 's'}
                </Text>
              </Button>
              {isOpen && agent.files.length === 0 && (
                <Text dimColor>   no file changes</Text>
              )}
              {isOpen &&
                agent.files.map(f => {
                  const key = `${agent.id}\u0000${f.path}`
                  const showDiff = expanded.has(key)
                  // A deleted file has no diff to open: a plain row, not a button.
                  if (f.kind === 'deleted') {
                    return (
                      <Box paddingLeft={2}>
                        <Text>
                          {badge(f.kind)} <Text>{f.path}</Text>{' '}
                          <Text dimColor>deleted</Text>
                        </Text>
                      </Box>
                    )
                  }
                  return (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Button key={`file-${key}`} onPress={toggle(key)}>
                        {badge(f.kind)} <Text>{f.path}</Text>
                        <Text>
                          {' '}
                          <Text color="diffAdded">+{f.added}</Text>{' '}
                          <Text color="diffRemoved">-{f.removed}</Text>
                        </Text>
                        <Text dimColor>
                          {' '}
                          {ranges(f)}
                          {f.edits > 1 ? ` (${f.edits} edits)` : ''}
                        </Text>
                      </Button>
                      {showDiff && f.preview.length === 0 && (
                        <Text dimColor>    no diff to show</Text>
                      )}
                      {showDiff &&
                        f.preview.map(line => (
                          <Text
                            mono
                            wrap="truncate-end"
                            color={
                              line.startsWith('@@')
                                ? 'suggestion'
                                : line.startsWith('+')
                                  ? 'diffAdded'
                                  : line.startsWith('-')
                                    ? 'diffRemoved'
                                    : 'subtle'
                            }
                          >
                            {'    '}
                            {line}
                          </Text>
                        ))}
                    </Box>
                  )
                })}
            </Box>
          )
        })}
      </Box>
    )
  })
}
