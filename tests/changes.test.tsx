import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-changes',
  component: 'Pane',
  requestId: 'subagent-changes',
  props: {
    title: 'Subagent changes',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a subagent edit, write and rm show as M, A and D with line ranges', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagent-changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({
    value: [{ id: 'ag1', description: 'Fix login', type: 'general-purpose', status: 'running' }],
  }))
  let exists = true
  on('fs.exists', () => ({ value: exists }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') {
      exists = false
      return { result: {} }
    }
    if (e.tool === 'Write') {
      return {
        result: {
          type: 'create', filePath: '/repo/src/new.ts', content: 'a\nb\n', originalFile: null,
          structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
        },
      }
    }
    return {
      result: {
        filePath: '/repo/src/app.ts', oldString: 'x', newString: 'y', originalFile: 'x',
        userModified: false, replaceAll: false,
        structuredPatch: [{ oldStart: 12, oldLines: 3, newStart: 12, newLines: 4, lines: [' k', '-x', '+y', '+z', ' k'] }],
      },
    }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'x', new_string: 'y', agentId: 'ag1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'a\nb\n', agentId: 'ag1' })
  await $.tool.call({ tool: 'Bash', command: 'rm -f old/legacy.ts', agentId: 'ag1' })
  // A main-loop call is not a subagent's: not listed.
  await $.tool.call({ tool: 'Write', file_path: '/repo/main.ts', content: '', })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Fix login/ }))?.text).toBe('Fix login')
  expect((await ui.find({ type: 'Text', text: /^src\/app\.ts$/ }))?.text).toBe('src/app.ts')
  expect((await ui.find({ type: 'Text', text: /L13-14/ }))?.text).toContain("L13-14")
  expect((await ui.find({ type: 'Text', text: /^src\/new\.ts$/ }))?.text).toBe('src/new.ts')
  expect((await ui.find({ type: 'Text', text: /^old\/legacy\.ts$/ }))?.text).toBe('old/legacy.ts')
  expect(await ui.find({ type: 'Text', text: /main\.ts/ })).toBe(undefined)
  // A deleted file is a plain row: no button to expand it.
  expect(await ui.find({ type: 'Button', text: /legacy/ })).toBe(undefined)
  expect((await ui.find({ type: 'Button', text: /src\/app\.ts/ }))?.type).toBe('Button')
  expect((await ui.find({ type: 'Text', text: /1 added · 1 modified · 1 deleted/ }))?.text).toContain('1 deleted')
  await ui.unmount()
})

test('a rename shows as R, a finish toasts a summary, and the transcript button opens the agent', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagent-changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag2' }))
  on('turn.complete', () => ({ text: '' }))
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const views: unknown[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.view', (_, e) => (views.push(e), { value: {} }))
  // Before the move: a.ts exists, docs/ is a folder; after: docs/a.ts exists.
  let moved = false
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/a.ts') && !e.path.includes('docs') ? !moved : moved }))
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('/docs')) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') moved = true
    return { result: {} }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'tidy', description: 'Tidy docs', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Bash', command: 'mv src/a.ts docs/', agentId: 'ag2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^src\/a\.ts → $/ }))?.text).toBe('src/a.ts → ')
  expect((await ui.find({ type: 'Text', text: /^docs\/a\.ts$/ }))?.text).toBe('docs/a.ts')
  expect(statuses.at(-1)).toBe('subagents: 1 running · 1 file changed')

  await ui.press({ key: 'transcript-ag2' })
  expect(views).toEqual([{ agentId: 'ag2' }])
  await ui.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'ag2', reason: 'answer' })
  expect(toasts.at(-1)).toBe('Tidy docs finished: 1 renamed')
  expect(statuses.at(-1)).toBe('subagents: 1 done · 1 file changed')
})

test('mkdir and mv in one command record the file inside the new folder', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagent-changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'ag3', description: 'Archive', type: 'general-purpose', status: 'running' }] }))
  on('ui.status', () => ({ value: undefined }))
  // archive/ does not exist until the command runs.
  let ran = false
  const after = new Set(['/repo/archive', '/repo/archive/notes.md'])
  on('fs.exists', (_, e) => ({ value: ran ? after.has(e.path) : e.path === '/repo/notes.md' }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('tool.call', () => ((ran = true), { result: {} }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'mkdir archive && mv notes.md archive', agentId: 'ag3' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^notes\.md → $/ }))?.text).toBe('notes.md → ')
  expect((await ui.find({ type: 'Text', text: /^archive\/notes\.md$/ }))?.text).toBe('archive/notes.md')
  await ui.unmount()
})
