import { expect, mock, test } from 'claude-code/testing'

import { pickLang } from '../hooks/i18n'
import { clip, costOf, dotBarHeight, dotBarSvg, dotBarWidth, gitMarks, todoSteps, totalsPill, treeRows } from '../hooks/model'

const BAND = {
  plugin: 'sprout',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 110, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const PANE = {
  plugin: 'sprout',
  component: 'Pane',
  requestId: 'sprout',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 36 }, view: {} },
} as const

/** Stubs Claude Code's side, starts the session, and returns the mocked clock; `language` is Claude Code's setting. */
async function session($: any, on: any, language = 'français') {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('settings.read', () => ({ value: { language } }))
  on('session.start', () => ({ cwd: 'C:/work' }))
  on('session.cwd', () => ({ value: 'C:\\work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', ($: any, e: any) => ({ model: 'claude-sonnet-5-5', agentId: e.description === 'Second' ? 'ag2' : 'ag1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000 },
    }
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:/work' })
  return clock
}

const spawn = ($: any, description: string, id: string) =>
  $.agent.spawn({
    tool_use_id: id,
    prompt: 'do it',
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine' },
    parentModel: 'claude-sonnet-5-5',
  })

async function step($: any, agentId: string) {
  const stream = $.turn.step({ turnId: 't-' + agentId, index: 0, model: 'claude-sonnet-5-5', messageCount: 3, agentId, effort: 'medium' })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

test('the band stays hidden until a subagent starts', async ($, on) => {
  await session($, on)
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
    expect(await band.find({ key: 'sprout-open' })).toBeUndefined()
    await band.unmount()
  }
})

test('a running agent shows in the band, with its steps, files and the pane', async ($, on) => {
  const clock = await session($, on)
  await spawn($, 'Lecture des specs', 'tu1')
  await step($, 'ag1')
  await ($ as any).tool.call({ tool: 'mcp__sprout__step', agentId: 'ag1', done: 1, total: 4, note: 'lecture' })
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:\\work\\docs\\specs\\SPEC_A.md' })
  await ($ as any).tool.call({ tool: 'Edit', agentId: 'ag1', file_path: 'C:/work/docs/notes.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/main-thread.md' })
  await clock.advance(3_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: '1 agent en cours' })).toBeDefined()
    // Another mod's band content is kept below ours.
    expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
    // Desktop draws the dot bar as SVG; the terminal has no Svg and draws half blocks.
    if (surface === 'desktop') expect(await band.find({ type: 'Svg' })).toBeDefined()
    else expect(await band.find({ type: 'Text', text: /^▄+$/ })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: 'Lecture des specs' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'lecture' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '1/4 étapes' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^ctx 10% {2}· {2}104k tk {2}· {2}≈\$0\.\d\d {2}· {2}0:03$/ })).toBeDefined()
    expect(await pane.find({ key: 'open-C:/work/docs/specs/SPEC_A.md' })).toBeDefined()
    expect(await pane.find({ key: 'open-C:/work/docs/notes.md' })).toBeDefined()
    // Files read by the main conversation are not the agents' files.
    expect(await pane.find({ key: 'open-C:/work/main-thread.md' })).toBeUndefined()
    // A lone agent touched every file: filtering on it would change nothing, so no button.
    expect(await pane.find({ key: 'filter-ag1' })).toBeUndefined()
    await pane.unmount()
  }
})

test('finished agents, the file filter, and the band leaving a minute later', async ($, on) => {
  const clock = await session($, on)
  await spawn($, 'Premier', 'tu1')
  await spawn($, 'Second', 'tu2')
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/a.md' })
  await ($ as any).tool.call({ tool: 'mcp__sprout__step', agentId: 'ag1', done: 1, total: 4 })
  await ($ as any).tool.call({ tool: 'Write', agentId: 'ag2', file_path: 'C:/work/b.md', content: 'x' })
  await $.turn.complete({ turnId: 't1', agentId: 'ag1', reason: 'answer', answer: '## Résultat\n**3 fiches** lues', durationMs: 900, isAborted: false })
  await $.turn.complete({ turnId: 't2', agentId: 'ag2', reason: 'error', answer: '', durationMs: 900, isAborted: false })
  await clock.advance(1_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '2 agents terminés' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '→ Résultat' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'interrompu ou en erreur' })).toBeDefined()
  // An agent that answered without its last step report shows all its steps done.
  expect(await pane.find({ type: 'Text', text: '4/4 étapes' })).toBeDefined()
  expect(await pane.find({ key: 'open-C:/work/b.md' })).toBeDefined()
  await pane.press({ key: 'filter-ag1' })
  expect(await pane.find({ key: 'open-C:/work/a.md' })).toBeDefined()
  expect(await pane.find({ key: 'open-C:/work/b.md' })).toBeUndefined()
  await pane.press({ key: 'filter-all' })
  expect(await pane.find({ key: 'open-C:/work/b.md' })).toBeDefined()
  await pane.unmount()

  await clock.advance(62_000)
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await later.find({ key: 'sprout-open' })).toBeUndefined()
  await later.unmount()
})

test('a click selects a file for the next message, a double-click opens it', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  const runs: string[][] = []
  on('prompt.submit', ($: any, e: any) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('process.run', ($: any, e: any) => {
    if (String(e.argv[3] ?? '').startsWith('Start-Process')) runs.push([e.init?.env?.SPROUT_FILE])
    return { value: { exitCode: 1, stdout: '', stderr: '' } } as any
  })
  // Stubs first: the engine's side is registered before the session starts.
  const clock = await session($, on)
  await spawn($, 'Lecture', 'tu1')
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/docs/a.md' })
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/run.bat' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await pane.press({ key: 'open-C:/work/docs/a.md' })
  await clock.advance(400)
  expect(await pane.find({ type: 'Text', text: 'joint' })).toBeDefined()
  expect(await pane.find({ key: 'selected-clear' })).toBeDefined()
  expect(runs).toEqual([])

  await ($ as any).prompt.submit({ text: 'Que contient ce fichier ?' })
  expect(String(contexts[0]?.at(-1))).toContain('- "C:/work/docs/a.md"')
  // Handed over once: the selection empties.
  expect(await pane.find({ type: 'Text', text: 'joint' })).toBeUndefined()

  await pane.press({ key: 'open-C:/work/docs/a.md' })
  await pane.press({ key: 'open-C:/work/docs/a.md' })
  await clock.advance(400)
  expect(runs).toEqual([['C:\\work\\docs\\a.md']])
  expect(await pane.find({ type: 'Text', text: 'joint' })).toBeUndefined()

  // Never something Windows would run.
  await pane.press({ key: 'open-C:/work/run.bat' })
  await pane.press({ key: 'open-C:/work/run.bat' })
  await clock.advance(400)
  expect(runs.length).toBe(1)

  // Two different files pressed in a row: both are selected.
  await pane.press({ key: 'open-C:/work/docs/a.md' })
  await pane.press({ key: 'open-C:/work/run.bat' })
  await clock.advance(400)
  expect(await pane.find({ key: 'selected-clear' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '2 fichiers joints à votre prochain message' })).toBeDefined()
  await pane.unmount()
})

test('the magnifier opens a search that filters the tree on Enter', async ($, on) => {
  await session($, on)
  await spawn($, 'Lecture', 'tu1')
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/docs/specs/SPEC_A.md' })
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/README.md' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ key: 'files-search' })).toBeUndefined()
    await pane.press({ key: 'search-toggle' })
    // Typing alone filters nothing: Enter does.
    await pane.input({ key: 'files-search', text: 'SPEC', kind: 'change' })
    expect(await pane.find({ key: 'open-C:/work/README.md' })).toBeDefined()
    await pane.input({ key: 'files-search', text: 'SPEC', kind: 'submit' })
    expect(await pane.find({ key: 'open-C:/work/docs/specs/SPEC_A.md' })).toBeDefined()
    expect(await pane.find({ key: 'open-C:/work/README.md' })).toBeUndefined()
    // The session folder's own name matches nothing: the search reads the shown, relative path.
    await pane.input({ key: 'files-search', text: 'work', kind: 'submit' })
    expect(await pane.find({ type: 'Text', text: 'Aucun fichier ne contient « work ».' })).toBeDefined()
    // The magnifier again closes the field and drops the filter.
    await pane.press({ key: 'search-toggle' })
    expect(await pane.find({ key: 'files-search' })).toBeUndefined()
    expect(await pane.find({ key: 'open-C:/work/README.md' })).toBeDefined()
    await pane.unmount()
  }
})

test('git status marks the touched files that changed', async ($, on) => {
  on('process.run', ($: any, e: any) => {
    const out = e.argv[1] === 'rev-parse' ? 'C:/work\n' : ' M docs/a.md\0?? new.md\0R  b.md\0old.md\0'
    return { value: { exitCode: 0, stdout: out, stderr: '' } } as any
  })
  await session($, on)
  await spawn($, 'Écriture', 'tu1')
  await ($ as any).tool.call({ tool: 'Edit', agentId: 'ag1', file_path: 'C:/work/docs/a.md', old_string: 'a', new_string: 'b' })
  await ($ as any).tool.call({ tool: 'Write', agentId: 'ag1', file_path: 'C:/work/new.md', content: 'x' })
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/README.md' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'M' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'U' })).toBeDefined()
  await pane.unmount()
})

test('git marks parse renames, and light-theme colours ride inside the SVGs', () => {
  expect(gitMarks('C:/work', ' M a.md\0A  b.md\0R  c.md\0old.md\0 R f.md\0was.md\0 D d.md\0?? e.md\0')).toEqual({
    'c:/work/f.md': 'M',
    'c:/work/a.md': 'M',
    'c:/work/b.md': 'A',
    'c:/work/c.md': 'M',
    'c:/work/d.md': 'D',
    'c:/work/e.md': 'U',
  })
  expect(dotBarSvg(1, '#7fb88f', false, 's')).toContain('prefers-color-scheme: light')
  expect(totalsPill(0.5, 1000).source).toContain('prefers-color-scheme: light')
})

test('an English-speaking Claude gets the mod in English', async ($, on) => {
  await session($, on, 'english')
  await spawn($, 'Reading', 'tu1')
  await ($ as any).tool.call({ tool: 'mcp__sprout__step', agentId: 'ag1', done: 1, total: 4 })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '1 agent running' })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '1/4 steps' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Used files' })).toBeDefined()
  await pane.unmount()
})

test('French only for a French setting or, without one, a French locale', () => {
  expect(pickLang('français', undefined)).toBe('fr')
  expect(pickLang('French', 'en_US.UTF-8')).toBe('fr')
  expect(pickLang('english', 'fr-FR')).toBe('en')
  expect(pickLang(undefined, 'fr-FR\r\n')).toBe('fr')
  expect(pickLang(undefined, 'fr_CA.UTF-8')).toBe('fr')
  expect(pickLang(undefined, 'de-DE')).toBe('en')
  expect(pickLang(undefined, undefined)).toBe('en')
})

test('/sprout opens the pane', async ($, on) => {
  const opened: unknown[] = []
  mock.clock(on)
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const answer = await ($ as any).command.run({ command: 'sprout', args: '' })
  expect(answer).toEqual({})
  expect(opened).toEqual(['sprout'])
})

test('/sprout clear empties the pane', async ($, on) => {
  await session($, on)
  await spawn($, 'Lecture', 'tu1')
  await ($ as any).tool.call({ tool: 'Read', agentId: 'ag1', file_path: 'C:/work/a.md' })
  await ($ as any).command.run({ command: 'sprout', args: 'clear' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Lecture' })).toBeUndefined()
  expect(await pane.find({ key: 'open-C:/work/a.md' })).toBeUndefined()
  await pane.unmount()
})

test('prices follow the official table, unknown models have no cost', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
  expect(costOf('claude-opus-5-5', u)).toBe(4 + 20 + 0.2 + 8)
  expect(costOf('claude-sonnet-5-5[1m]', u)).toBe(2 + 10 + 0.1 + 4)
  expect(costOf('claude-fable-5-1', u)).toBe(10 + 50 + 0.25 + 20)
  expect(costOf('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1_000_000 })).toBe(0.005 + 0.5)
  expect(costOf('some-other-model', u)).toBe(null)
})

test('the tree merges single-folder chains and keeps outside paths whole', () => {
  const at = { agents: ['a'], reads: 1, writes: 0, lastAt: 0 }
  const rows = treeRows(
    [
      { ...at, path: 'C:/work/docs/specs/SPEC_A.md' },
      { ...at, path: 'C:/work/docs/specs/SPEC_B.md' },
      { ...at, path: 'C:/work/README.md' },
      { ...at, path: 'D:/other/x.txt' },
    ],
    'c:\\work',
  )
  expect(rows.map(r => `${r.depth}:${r.name}`)).toEqual(['0:D:/other', '1:x.txt', '0:docs/specs', '1:SPEC_A.md', '1:SPEC_B.md', '0:README.md'])
})

test('the dot bar twinkles only while live and is stable for a seed', () => {
  expect(dotBarSvg(0.5, '#fff', true, 's')).toContain('@keyframes')
  expect(dotBarSvg(0.5, '#fff', false, 's')).not.toContain('@keyframes')
  expect(dotBarSvg(0.5, '#fff', true, 's')).toBe(dotBarSvg(0.5, '#fff', true, 's'))
  // A failed bar tints its unlit track too.
  expect(dotBarSvg(0, '#c45a6a', false, 's', 4, 4, '#c45a6a')).not.toContain('#888')
  // Dots keep their size: 4 rows fill 8px, a 5th row adds one pitch; widths grow with the columns (card 55, band 92).
  expect([dotBarHeight(4), dotBarHeight(5)]).toEqual([8, 11])
  expect([dotBarWidth(46), dotBarWidth(55), dotBarWidth(66), dotBarWidth(92)]).toEqual([100, 120, 144, 200])
  expect(dotBarSvg(1, '#fff', false, 's', 66, 5).match(/<rect /g)?.length).toBe(66 * 5)
})

test('an agent that never calls step gets its steps from its todo list', () => {
  const a = { id: 'x', description: '', type: 't', model: 'm', status: 'running', startedAt: 0, contextTokens: 0, contextWindow: 0, tokens: 0, costUsd: 0, requests: 0 } as const
  const todos = [
    { content: 'lire', status: 'completed', activeForm: 'Lecture' },
    { content: 'écrire', status: 'in_progress', activeForm: 'Écriture' },
    { content: 'tester', status: 'pending', activeForm: 'Tests' },
  ]
  const fromList = todoSteps(a, 'TodoWrite', { todos })
  expect([fromList.stepDone, fromList.stepTotal, fromList.stepNote]).toEqual([1, 3, 'Écriture'])
  let t = todoSteps(todoSteps(a, 'TaskCreate', { subject: 'a' }), 'TaskCreate', { subject: 'b' })
  t = todoSteps(t, 'TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Lecture' })
  t = todoSteps(t, 'TaskUpdate', { taskId: '1', status: 'completed' })
  expect([t.stepDone, t.stepTotal, t.stepNote]).toEqual([1, 2, 'Lecture'])
  // Steps reported through the tool win over the todo list.
  expect(todoSteps({ ...a, stepSource: 'step', stepTotal: 5 }, 'TodoWrite', { todos }).stepTotal).toBe(5)
})

test('clip cuts a text to its maximum, ellipsis included', () => {
  expect(clip('x'.repeat(80), 60)).toBe('x'.repeat(59) + '…')
  expect(clip('court', 60)).toBe('court')
})
