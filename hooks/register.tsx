import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRecord, ChangeKind, FileChange, Hunk } from '../types'

const PANE = 'subagent-changes'
const TITLE = 'Subagent changes'
const MAX_PREVIEW = 60
const MAX_HUNKS = 12
const MAX_AGENTS = 50

// Bump the shape tag when AgentRecord / FileChange change: it declines what an
// earlier version stored, which outlives a reload.
const agents = atom({ plugin: 'subagent-changes', key: 'agents' } as const, [], {
  shape: 'agents-2',
})
// Toggled rows: `${agentId}\u0000collapsed`, or `${agentId}\u0000${path}` for a
// file's diff.
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

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "2 added · 1 modified": the kinds of change in a list of files. */
const summarize = (files: readonly FileChange[]) => {
  const counts: Record<ChangeKind, number> = { added: 0, modified: 0, deleted: 0, renamed: 0 }
  for (const f of files) counts[f.kind] += 1
  const parts = (['added', 'modified', 'deleted', 'renamed'] as const)
    .filter(k => counts[k] > 0)
    .map(k => `${counts[k]} ${k}`)

  return parts.length === 0 ? 'no file changes' : parts.join(' · ')
}

/** The status line entry: running subagents and files changed, or nothing. */
const refreshStatus = (
  $: EngineInterface,
  list: readonly AgentRecord[],
) => {
  if (list.length === 0) return $.ui.status(undefined)
  const running = list.filter(a => !a.isDone).length
  const files = list.reduce((n, a) => n + a.files.length, 0)
  $.ui.status(
    `subagents: ${running > 0 ? `${running} running` : `${list.length} done`} · ${plural(files, 'file')} changed`,
  )
}

/** Applies a change to the agent list, then refreshes the status line. */
const change = async (
  $: EngineInterface,
  fn: (list: AgentRecord[]) => AgentRecord[],
) => {
  await update($, agents, list => fn([...list]).slice(-MAX_AGENTS))
  refreshStatus($, await read($, agents))
}

const newAgent = (id: string, description: string, type: string): AgentRecord => ({
  id,
  description,
  type,
  isDone: false,
  isStopped: false,
  startedAt: Date.now(),
  files: [],
})

/** Makes sure the agent has a record, asking the engine about one spawned before the mod loaded. */
const ensureAgent = async ($: EngineInterface, agentId: string) => {
  if ((await read($, agents)).some(a => a.id === agentId)) return
  const info = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)
  await change($, list =>
    list.some(a => a.id === agentId)
      ? list
      : [...list, newAgent(agentId, info?.description ?? '', info?.type ?? 'subagent')],
  )
}

/** Changes one agent's file list. */
const changeFiles = (
  $: EngineInterface,
  agentId: string,
  fn: (files: FileChange[]) => FileChange[],
) =>
  change($, list =>
    list.map(agent => (agent.id === agentId ? { ...agent, files: fn([...agent.files]) } : agent)),
  )

/** Adds or merges one added, modified or deleted change of one file. */
const record = async (
  $: EngineInterface,
  agentId: string,
  path: string,
  kind: Exclude<ChangeKind, 'renamed'>,
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

  await ensureAgent($, agentId)
  const shown = relative(path)
  await changeFiles($, agentId, files => {
    const prev = files.find(f => f.path === shown)
    // A file the agent created stays "added" through its later edits, and a
    // moved one "renamed"; a deletion wins; one deleted then written again
    // is "modified".
    const merged: ChangeKind =
      kind === 'deleted'
        ? 'deleted'
        : prev === undefined
          ? kind
          : prev.kind === 'added' || prev.kind === 'renamed'
            ? prev.kind
            : 'modified'
    const next: FileChange = {
      path: shown,
      kind: merged,
      ...(merged === 'renamed' && prev?.from !== undefined ? { from: prev.from } : {}),
      edits: (prev?.edits ?? 0) + 1,
      added: (prev?.added ?? 0) + added,
      removed: (prev?.removed ?? 0) + removed,
      hunks: [...(prev?.hunks ?? []), ...hunks].slice(-MAX_HUNKS),
      preview: kind === 'deleted' ? [] : preview.length > 0 ? preview : (prev?.preview ?? []),
      at: Date.now(),
    }

    return prev ? files.map(f => (f.path === shown ? next : f)) : [...files, next]
  })
}

/** Records a move: the file's entry follows it to its new path. */
const recordRename = async ($: EngineInterface, agentId: string, from: string, to: string) => {
  await ensureAgent($, agentId)
  const src = relative(from)
  const dst = relative(to)
  await changeFiles($, agentId, files => {
    const prev = files.find(f => f.path === src)
    const rest = files.filter(f => f.path !== src && f.path !== dst)
    const moved: FileChange = prev
      ? prev.kind === 'added'
        ? { ...prev, path: dst, edits: prev.edits + 1, at: Date.now() }
        : { ...prev, path: dst, kind: 'renamed', from: prev.from ?? src, edits: prev.edits + 1, at: Date.now() }
      : {
          path: dst,
          kind: 'renamed',
          from: src,
          edits: 1,
          added: 0,
          removed: 0,
          hunks: [],
          preview: [],
          at: Date.now(),
        }
    // Moved back where it started: no longer a rename.
    if (moved.kind === 'renamed' && moved.from === dst && moved.added + moved.removed === 0) {
      return rest
    }

    return [...rest, moved]
  })
}

const STRIP_QUOTES = /^(['"])(.*)\1$/

type ShellPlan = { deletes: string[]; moves: { sources: string[]; dest: string }[] }

/** What a shell command means to delete (rm, unlink, rmdir, git rm) and move (mv, git mv). */
const parseShell = (command: string): ShellPlan => {
  const plan: ShellPlan = { deletes: [], moves: [] }
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'sudo') words.shift()
    let verb: 'delete' | 'move' | undefined
    let args: string[] = []
    if (words[0] === 'rm' || words[0] === 'unlink' || words[0] === 'rmdir') {
      verb = 'delete'
      args = words.slice(1)
    } else if (words[0] === 'git' && words[1] === 'rm') {
      verb = 'delete'
      args = words.slice(2)
    } else if (words[0] === 'mv') {
      verb = 'move'
      args = words.slice(1)
    } else if (words[0] === 'git' && words[1] === 'mv') {
      verb = 'move'
      args = words.slice(2)
    }
    if (verb === undefined) continue
    const paths = args.filter(w => !w.startsWith('-')).map(w => w.replace(STRIP_QUOTES, '$2'))
    // Globs and expansions name files no one can know here.
    if (paths.some(p => /[*?$`{}]/.test(p))) continue
    if (verb === 'delete') plan.deletes.push(...paths)
    else if (paths.length >= 2) {
      plan.moves.push({ sources: paths.slice(0, -1), dest: paths[paths.length - 1] as string })
    }
  }

  return plan
}

const exists = ($: EngineInterface, path: string) =>
  $.fs.exists(absolute(path)).catch(() => false)

const isDir = ($: EngineInterface, path: string) =>
  $.fs
    .stat(absolute(path))
    .then(s => s.kind === 'dir')
    .catch(() => false)

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
      description: 'Show the files each subagent added, modified, deleted or renamed (args: clear)',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    refreshStatus($, await read($, agents))

    return next(e)
  })

  on('command.run', { command: 'subagent-changes' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await change($, () => [])
      await update($, open, () => [])

      return { text: 'Subagent change log cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Subagent changes pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id !== undefined) {
      await change($, list =>
        list.some(a => a.id === id)
          ? list
          : [...list, newAgent(id, e.description ?? '', e.subagentType || 'general-purpose')],
      ).catch(() => undefined)
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const before = (await read($, agents)).find(a => a.id === id)
      if (before !== undefined) {
        await change($, list =>
          list.map(a => (a.id === id ? { ...a, isDone: true, isStopped: e.isAborted } : a)),
        )
        // One toast per finish: a resumed agent that finishes again says so again.
        const name = before.description || before.type
        $.ui.toast(
          `${name} ${e.isAborted ? 'stopped' : 'finished'}: ${summarize(before.files)}`,
          { timeoutMs: 6000 },
        )
      }
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
      const kind = e.tool === 'Write' && res.type === 'create' ? 'added' : 'modified'
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
      const plan = parseShell(e.command)
      if (plan.deletes.length === 0 && plan.moves.length === 0) return next(e)

      // What stands before the command runs.
      const deletes = await Promise.all(
        plan.deletes.map(async path => ({ path, existed: await exists($, path) })),
      )
      const moves = await Promise.all(
        plan.moves.map(async m => {
          // Into a folder: several sources, a trailing slash, or a folder there
          // now. A folder the same command makes first (`mkdir d && mv f d`) is
          // only there afterwards: `inside` is tried then too.
          const intoDir =
            m.sources.length > 1 || m.dest.endsWith('/') || (await isDir($, m.dest))
          return Promise.all(
            m.sources.map(async src => {
              const inside = `${m.dest.replace(/\/+$/, '')}/${basename(src)}`
              return { src, inside, dst: intoDir ? inside : m.dest, existed: await exists($, src) }
            }),
          )
        }),
      )

      const ran = await next(e)

      for (const d of deletes) {
        if (d.existed && !(await exists($, d.path))) {
          await safely(record($, agentId, absolute(d.path), 'deleted', []))
        }
      }
      for (const m of moves.flat()) {
        if (!m.existed || (await exists($, m.src))) continue
        const dst = m.dst !== m.inside && (await exists($, m.inside)) ? m.inside : m.dst
        if (await exists($, dst)) {
          await safely(recordRename($, agentId, absolute(m.src), absolute(dst)))
        }
      }

      return ran
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const expanded = new Set(await read($, open))
    const viewing = e.props.view.agentId

    const toggle = (key: string) => () =>
      update($, open, keys =>
        keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key],
      )

    const showTranscript = (agentId: string | undefined) => async () => {
      const shown = await $.ui.view(agentId === undefined ? {} : { agentId })
      if ('deny' in shown && shown.deny) $.ui.toast(`Can't open the transcript: ${shown.deny}`)
    }

    const badge = (kind: ChangeKind) =>
      kind === 'added' ? (
        <Text color="success" bold>A</Text>
      ) : kind === 'deleted' ? (
        <Text color="error" bold>D</Text>
      ) : kind === 'renamed' ? (
        <Text color="suggestion" bold>R</Text>
      ) : (
        <Text color="warning" bold>M</Text>
      )

    const ranges = (f: FileChange) =>
      f.hunks.map(h => (h.start === h.end ? `L${h.start}` : `L${h.start}-${h.end}`)).join(', ')

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No subagents yet.</Text>
          <Text dimColor>Files a subagent adds, modifies, deletes or renames show here.</Text>
        </Box>
      )
    }

    const allFiles = list.flatMap(a => a.files)

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {plural(list.length, 'subagent')} · {summarize(allFiles)}
        </Text>
        {viewing !== undefined && (
          <Button key="back-to-main" onPress={showTranscript(undefined)}>
            ← Back to the main conversation
          </Button>
        )}
        {[...list].reverse().map(agent => {
          const isOpen = !expanded.has(`${agent.id}\u0000collapsed`)
          const isViewed = viewing === agent.id
          return (
            <Box flexDirection="column" marginTop={1}>
              <Button key={`agent-${agent.id}`} onPress={toggle(`${agent.id}\u0000collapsed`)}>
                {isOpen ? '▾' : '▸'} <Text bold>{agent.type}</Text>{' '}
                <Text>{agent.description || agent.id.slice(0, 8)}</Text>{' '}
                <Text color={agent.isDone ? (agent.isStopped ? 'warning' : 'subtle') : 'claude'}>
                  {agent.isDone ? (agent.isStopped ? 'stopped' : 'done') : 'running'}
                </Text>{' '}
                <Text dimColor>{plural(agent.files.length, 'file')}</Text>
              </Button>
              {isOpen && (
                <Box paddingLeft={2}>
                  {isViewed ? (
                    <Text dimColor>transcript shown</Text>
                  ) : (
                    <Button key={`transcript-${agent.id}`} onPress={showTranscript(agent.id)}>
                      <Text color="suggestion">view transcript</Text>
                    </Button>
                  )}
                </Box>
              )}
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
                  const label = (
                    <Text>
                      {badge(f.kind)}{' '}
                      {f.kind === 'renamed' && f.from !== undefined && (
                        <Text dimColor>{f.from} → </Text>
                      )}
                      <Text>{f.path}</Text>
                      {f.added + f.removed > 0 && (
                        <Text>
                          {' '}
                          <Text color="diffAdded">+{f.added}</Text>{' '}
                          <Text color="diffRemoved">-{f.removed}</Text>
                        </Text>
                      )}
                      <Text dimColor>
                        {' '}
                        {ranges(f)}
                        {f.edits > 1 ? ` (${f.edits} changes)` : ''}
                      </Text>
                    </Text>
                  )
                  // A pure move has no diff either.
                  if (f.preview.length === 0) {
                    return <Box paddingLeft={2}>{label}</Box>
                  }
                  return (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Button key={`file-${key}`} onPress={toggle(key)}>
                        {label}
                      </Button>
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
