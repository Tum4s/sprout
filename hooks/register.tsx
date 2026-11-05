import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRun, FileTouch } from '../types'
import {
  addCost,
  allTokens,
  blockBar,
  botSvg,
  contextPct,
  costOf,
  dotBarHeight,
  dotBarSvg,
  dotBarWidth,
  elapsed,
  clip,
  firstLine,
  fmtCost,
  gitMarks,
  type GitMark,
  fmtTime,
  fmtTokens,
  modelName,
  normPath,
  progressOf,
  todoSteps,
  toolLabel,
  treeRows,
  type Usage,
} from './model'
import { pickLang, WORDS, type Words } from './i18n'

const PANE = 'sprout'
// The band stays this long after the last agent of a wave finishes.
const BAND_LINGER_MS = 60_000
// Dot bars: 5 rows and 200px in the band (as the app's Ultracode slider), 4 rows on the pane's cards.
const BAND_COLS = 92 // exactly 200px wide
const BAND_ROWS = 5
// A card's bar follows the pane's width: dot columns per body cell, within bounds (40 dots ≈ 87px, 220 ≈ 480px).
// ponytail: assumes a desktop cell of about 8px, so the bar takes about 40% of a card; retune if it looks off.
const CARD_COLS_PER_CELL = 1.3
const CARD_COLS_MIN = 40
const CARD_COLS_MAX = 220
// All the cards' dots together, so the pane's drawing stays under the engine's 100,000 characters (about 45 a dot):
// with many cards the bars stop growing sooner.
const CARD_DOTS_MAX = 1200
const CARD_ROWS = 4
// A file touched this recently is drawn at full strength, the others dim.
const RECENT_MS = 5_000
const MAX_CARDS = 6
// The mascot, drawn on each agent card and in the band (desktop), in pixels.
const BOT_SIZE = 24
// A card's description line (current step or final answer), in characters.
const DETAIL_MAX = 60
const MAX_FILE_ROWS = 60
// A second press on the same file within this delay opens it instead of selecting it.
const DOUBLE_PRESS_MS = 350
// Files a double-click opens, in Notepad: text kinds only.
const OPENABLE = /\.(md|txt|json|csv|log|xml|ya?ml|toml|ini|sql|src|tsx?|py|css|html?)$/i
// Added to each subagent's brief, so its card gets a progress bar without anyone asking for it.
const STEP_BRIEF =
  '\n\n(Progress panel: if the ToolSearch tool is available, your FIRST action is to load the tool with query ' +
  '"select:mcp__sprout__step" and call mcp__sprout__step with your plan as `total` (3-8 steps) and `done: 0`, ' +
  'then again EACH time a step finishes, with `done` and a few-word `note` of the next step. Without ToolSearch, ' +
  'ignore this note. The tool only draws a progress bar for the user, so there is no need to mention it.)'
// Prompts nobody typed: a selection waits for the person's own next message instead.
const NOT_TYPED = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
])
// Outline folder pictogram (tab + body) in light grey, drawn before each folder of the tree on the desktop.
const FOLDER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="12" viewBox="0 0 14 12"><path d="M1.5 2.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="#9aa0a6" stroke-width="1.2" stroke-linejoin="round"/></svg>'
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Theme keys, so text colours follow the person's light or dark theme.
const RUN = 'claude'
const DONE = 'success'
const FAIL = 'error'
const READ = 'suggestion'
const WRITE = 'warning'
// The same marks as SVG for the desktop, theme-like blue and orange: a ring for read, a disc for written.
const MARK_READ = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.2" fill="none" stroke="#6e9cf0" stroke-width="1.4"/></svg>'
const MARK_WRITE = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.9" fill="#e8a33d"/></svg>'
// The dot bars are SVG and need real colours: Claude's orange while running, green once done, grey for context.
const BAR_LIVE = '#d97757'
// The pane's orange texts on the desktop: Claude's orange, a touch muted (it glared on the dark theme). The API tells
// no theme, so one colour serves both; it still reads on white.
const RUN_SOFT = '#c8795e'
// The hover group of the band and the running agents' cards: hovering one lights the others.
const LIVE_SCOPE = 'sprout-live'
const BAR_DONE = '#7fb88f'
const BAR_CTX = '#808a96'
// The failed bot's body: a failed bar, track included, takes its red.
const BAR_FAIL = '#c45a6a'

const agents = atom({ plugin: 'sprout', key: 'agents' } as const, [])
const files = atom({ plugin: 'sprout', key: 'files' } as const, [])
const now = atom({ plugin: 'sprout', key: 'now' } as const, 0)
const waveStart = atom({ plugin: 'sprout', key: 'waveStart' } as const, 0)
const filter = atom({ plugin: 'sprout', key: 'filter' } as const, null)
const selected = atom({ plugin: 'sprout', key: 'selected' } as const, [])
const query = atom({ plugin: 'sprout', key: 'query' } as const, '')
const searching = atom({ plugin: 'sprout', key: 'searching' } as const, false)
const git = atom({ plugin: 'sprout', key: 'git' } as const, {})
// Git's marks drawn after a file's name, as an editor's file tree shows them.
const GIT_COLOR: Record<GitMark, string> = { M: WRITE, A: DONE, U: DONE, D: FAIL }

/** Session folder, set at session start; files under it are shown relative to it. */
let root = ''
/** A file's first press, waiting to see whether a second one makes it a double-click. */
let pendingPress: { path: string; timer: Timer } | null = null
/** Numbers each `git status` run, so a slower, older run never overwrites a newer one. */
let gitRun = 0
/** The words in the person's language, set at session start. */
let t: Words = WORDS.en

const lastEnd = (list: AgentRun[]): number => Math.max(0, ...list.map(a => a.endedAt ?? 0))

/** Apply `fn` to the agent whose loop id is `agentId`. */
async function patchAgent($: EngineInterface, agentId: string, fn: (a: AgentRun) => AgentRun): Promise<void> {
  await update($, agents, list => list.map(a => (a.agentId === agentId ? fn(a) : a)))
}

/** Adds the file to, or takes it out of, the selection handed to Claude with the person's next message. */
async function toggleSelected($: EngineInterface, path: string): Promise<void> {
  await update($, selected, list => (list.includes(path) ? list.filter(p => p !== path) : [...list, path]))
}

/** Windows' own folder, for its programs by absolute path (a bare name could resolve to one in the session folder). */
async function systemRoot($: EngineInterface): Promise<string> {
  return (await $.env.get('SystemRoot').catch(() => undefined)) ?? 'C:\\Windows'
}

/**
 * Opens a text file in Notepad, which shows any file as text: the file's default app could run it instead (a .py
 * runs with py.exe, an .html runs its scripts). Start-Process returns at once, and the path travels in an
 * environment variable, never inside the command.
 */
async function openFile($: EngineInterface, path: string): Promise<void> {
  const name = path.slice(path.lastIndexOf('/') + 1)
  // A network path would hand Windows credentials to that server: local files only.
  if (!OPENABLE.test(name) || path.startsWith('//')) {
    $.ui.toast(t.textOnly(name))
    return
  }
  // ponytail: Windows only (Notepad); a text viewer per system (open -t, xdg-open) when macOS and Linux matter.
  try {
    const system = await systemRoot($)
    const opened = await $.process.run(
      [
        `${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath "$env:SystemRoot\\System32\\notepad.exe" -ArgumentList ('"' + $env:SPROUT_FILE + '"')`,
      ],
      { env: { SPROUT_FILE: path.replace(/\//g, '\\') } },
    )
    if (opened.exitCode !== 0) $.ui.toast(t.cantOpen(name))
  } catch {
    $.ui.toast(t.cantOpen(name))
  }
}

/** One press selects the file (or unselects it); two quick presses open it. */
function pressFile($: EngineInterface, path: string): void {
  if (pendingPress?.path === path) {
    pendingPress.timer.cancel()
    pendingPress = null
    void openFile($, path)
    return
  }
  if (pendingPress) {
    // Another file pressed before the delay ran out: its single press still counts.
    pendingPress.timer.cancel()
    void toggleSelected($, pendingPress.path)
  }
  const timer = $.clock.after(DOUBLE_PRESS_MS, () => {
    pendingPress = null
    void toggleSelected($, path)
  })
  pendingPress = { path, timer }
}

/** French or English: Claude Code's `language` setting, else the system's locale (see pickLang). */
async function detectLang($: EngineInterface): Promise<void> {
  try {
    const setting = (await $.settings.read()).language
    let locale: string | undefined
    if (!setting) {
      locale = await $.env.get('LANG')
      // Windows sets no LANG: its display language comes from PowerShell.
      if (!locale) {
        const powershell = `${await systemRoot($)}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        locale = (await $.process.run([powershell, '-NoProfile', '-Command', '(Get-UICulture).Name'])).stdout
      }
    }
    t = WORDS[pickLang(setting, locale)]
  } catch {
    t = WORDS.en
  }
}

/** Reads `git status` in the session folder (read-only); outside a repository, or without git, no marks. */
async function refreshGit($: EngineInterface): Promise<void> {
  const run = ++gitRun
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return
    const status = await $.process.run(['git', 'status', '--porcelain', '-z', '--untracked-files=all'])
    if (status.exitCode !== 0 || run !== gitRun) return
    // Only the touched files' marks are kept: a large repository's whole status would bloat the state.
    const touched = new Set((await read($, files)).map(f => f.path.toLowerCase()))
    const marks = gitMarks(normPath(top.stdout.trim()), status.stdout)
    await update($, git, () => Object.fromEntries(Object.entries(marks).filter(([p]) => touched.has(p))))
  } catch {
    // git missing or refused: the tree simply shows no marks.
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Agents' })
}

/** Moves the clock while agents run or the band lingers, so durations and the band's timeout redraw. */
async function tick($: EngineInterface): Promise<void> {
  const list = await read($, agents)
  const at = await $.clock.now()
  if (list.some(a => a.status === 'running') || at - lastEnd(list) <= BAND_LINGER_MS + 2_000) await update($, now, () => at)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    root = normPath(await $.session.cwd())
    await detectLang($)
    void refreshGit($)
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the agents panel. ' +
        'Right after reading your brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again each time a step finishes, with a few-word `note`. Silent: it only draws a progress bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    $.clock.every(1_000, () => {
      void tick($)
    })
    // Last: a refused registration throws and would skip what follows.
    await $.command.register({
      name: 'sprout',
      description: t.commandDescription,
      immediate: true,
    })
    return started
  })

  // The files picked in the pane go with the person's next message, as context the model reads beside it.
  on('prompt.submit', async ($, e, next) => {
    const picked = await read($, selected)
    if (picked.length === 0 || NOT_TYPED.has(e.origin?.kind ?? '')) return next(e)
    const entered = await next({ ...e, context: [...(e.context ?? []), t.selectedNote(picked)] })
    if (!('drop' in entered)) await update($, selected, () => [])
    return entered
  })

  // `/sprout` opens the pane; `/sprout clear` first forgets every agent and file (the state outlives reloads).
  on('command.run', { command: 'sprout' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, () => [])
      await update($, files, () => [])
      await update($, selected, () => [])
      await update($, filter, () => null)
      await update($, query, () => '')
      await update($, git, () => ({}))
    }
    await openPane($)
    return {}
  })

  // A subagent's own progress: the call runs in its loop, so agentId names it. Registered before the
  // generic tool.call hook, which it answers in place of. A regex matcher: the tool is ours, so it is missing from
  // the generated tool types until the mod has registered it once.
  on('tool.call', { tool: /^mcp__sprout__step$/ }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await patchAgent($, agentId, a => {
      const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
      const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
      return { ...a, stepSource: 'step', stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
    })
    return { result: 'ok' }
  })

  // Every tool call of a subagent: what it is doing, and the files it reads or writes.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) return next(e)
    const args = e as unknown as Record<string, unknown>
    await patchAgent($, agentId, a => ({ ...a, lastTool: toolLabel(e.tool, args) }))
    const result = await next(e)
    const outcome = result as { deny?: unknown; isError?: boolean }
    const isDone = outcome.deny === undefined && !outcome.isError
    if (isDone) await patchAgent($, agentId, a => todoSteps(a, e.tool, args))
    const kind = WRITES.has(e.tool) ? 'write' : e.tool === 'Read' ? 'read' : null
    const raw = args.file_path ?? args.notebook_path
    if (kind && typeof raw === 'string' && raw && isDone) {
      const path = normPath(raw)
      const at = await $.clock.now()
      await update($, files, list => {
        const prev = list.find(f => f.path.toLowerCase() === path.toLowerCase())
        const touch: FileTouch = {
          path: prev?.path ?? path,
          agents: prev && prev.agents.includes(agentId) ? prev.agents : [...(prev?.agents ?? []), agentId],
          writes: (prev?.writes ?? 0) + (kind === 'write' ? 1 : 0),
          lastAt: at,
        }
        return [...list.filter(f => f !== prev), touch].slice(-500)
      })
      if (kind === 'write') void refreshGit($)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    // A fork shares its parent's context; an agent already told about the tool needs no second brief.
    const isBriefed = e.subagentType === 'fork' || e.prompt.includes('mcp__sprout__step')
    const started = await next(isBriefed ? e : { ...e, prompt: e.prompt + STEP_BRIEF })
    // Only an agent with a loop id can be followed: its steps, requests and end all carry that id.
    const agentId = started.agentId
    if (started.deny !== undefined || !agentId) return started
    const at = await $.clock.now()
    const list = await read($, agents)
    if (!list.some(a => a.status === 'running') && at - lastEnd(list) > BAND_LINGER_MS) {
      await update($, waveStart, () => at)
      await update($, filter, () => null)
    }
    const run: AgentRun = {
      id: agentId,
      agentId,
      description: e.description,
      type: e.subagentType,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextWindow: 0,
      tokens: 0,
      costUsd: 0,
      requests: 0,
    }
    await update($, agents, l => [...l.filter(a => a.id !== run.id), run].slice(-100))
    await update($, now, () => at)
    // The session reports its own model's window only: a subagent on another model shows tokens, not a percentage.
    if (started.model === e.parentModel) {
      try {
        const window = (await $.session.usage()).context.window
        await patchAgent($, agentId, a => ({ ...a, contextWindow: window }))
      } catch {
        // No window: the card shows tokens instead.
      }
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage as (Usage & { model?: string }) | null | undefined
    if (!agentId || !usage) return result
    const model = usage.model || e.model
    await patchAgent($, agentId, a => ({
      ...a,
      model,
      effort: typeof e.effort === 'string' ? e.effort : a.effort,
      contextTokens: allTokens(usage),
      tokens: a.tokens + allTokens(usage),
      costUsd: addCost(a.costUsd, costOf(model, usage)),
      requests: a.requests + 1,
    }))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      // An agent's end is when its changes settle: git's marks catch up.
      void refreshGit($)
      const at = await $.clock.now()
      const usage = e.usage as (Usage & { model?: string }) | undefined
      await patchAgent($, agentId, a => {
        const ended: AgentRun = {
          ...a,
          status: e.reason === 'answer' ? 'done' : 'failed',
          endedAt: at,
          answer: e.answer ? firstLine(e.answer) : a.answer,
          // Agents often skip their last report: an answer means every planned step is done.
          stepDone: e.reason === 'answer' && a.stepTotal ? a.stepTotal : a.stepDone,
        }
        // A run whose requests went unseen still gets the turn's own totals.
        if (a.requests === 0 && usage) {
          const model = usage.model || a.model
          return { ...ended, model, tokens: allTokens(usage), costUsd: costOf(model, usage) }
        }
        return ended
      })
      await update($, now, () => at)
    }
    return next(e)
  })

  // The band: only while agents run, and for a minute after the last one finishes.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, agents)
    const start = await read($, waveStart)
    const at = await read($, now)
    const crew = list.filter(a => a.startedAt >= start || a.status === 'running')
    const running = crew.filter(a => a.status === 'running')
    if (crew.length === 0 || (running.length === 0 && at - lastEnd(crew) > BAND_LINGER_MS)) return next(e)

    const others = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Svg is the desktop's alone: narrowing the event narrows the element table.
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : null
    const isLive = running.length > 0
    const failed = crew.filter(a => a.status === 'failed').length
    const ratio = crew.reduce((s, a) => s + (progressOf(a) ?? 0), 0) / crew.length
    const cost = crew.reduce<number | null>((s, a) => addCost(s, a.costUsd), 0)
    const span = Math.max(...crew.map(a => a.endedAt ?? Math.max(at, a.startedAt))) - Math.min(...crew.map(a => a.startedAt))
    const head = isLive ? t.bandRunning(running.length) : t.bandDone(crew.length)
    const barColor = isLive ? BAR_LIVE : failed ? BAR_FAIL : BAR_DONE
    // What the latest running agent does, shown on hover.
    const latest = [...running].sort((a, b) => b.startedAt - a.startedAt)[0]
    const doing = latest ? latest.stepNote || latest.lastTool || '' : ''
    const [lit, unlit] = blockBar(ratio, 31)
    const bar =
      Svg ? (
        <Svg
          source={dotBarSvg(ratio, barColor, isLive, `wave-${start}`, BAND_COLS, BAND_ROWS, !isLive && failed ? BAR_FAIL : undefined)}
          alt={`${Math.round(ratio * 100)}%`}
          width={dotBarWidth(BAND_COLS)}
          height={dotBarHeight(BAND_ROWS)}
        />
      ) : (
        <Text>
          <Text color={isLive ? RUN : failed ? FAIL : DONE}>{lit}</Text>
          <Text dimColor>{unlit}</Text>
        </Text>
      )
    // Other mods' band content stays below ours.
    return (
      <Box flexDirection="column">
        {/* Desktop hover: no tint (the engine's frame around the band has a padding a tint would leave bare); the
            band only joins the running agents' cards in one hover group, so hovering it lights them. A hover with a
            scope and no style does not join the group: a fully transparent background keeps it in. */}
        <Box
          key="sprout-band"
          flexDirection="row"
          alignItems="center"
          gap={1}
          {...(Svg ? { hover: { scope: LIVE_SCOPE, backgroundColor: '#00000000' } } : {})}
        >
          {/* The mascot sums up the wave: walking while agents run, smiling once done, red if one failed. */}
          {Svg ? (
            <Svg source={botSvg(isLive ? 'running' : failed ? 'failed' : 'done')} alt={head} width={BOT_SIZE} height={BOT_SIZE} />
          ) : (
            <Text color={isLive ? RUN : failed ? FAIL : DONE}>{isLive ? '●' : failed ? '✗' : '✓'}</Text>
          )}
          <Text bold>{head}</Text>
          {/* Breathing room around the bar; the button sits at the far right. */}
          <Box marginX={1}>{bar}</Box>
          <Text dimColor>
            {[t.bandRatio(crew.length - running.length, crew.length), cost ? fmtCost(cost) : '', fmtTime(span)]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
          {/* Hidden until hovered: the latest running agent's step, in the free room before the button. */}
          {Svg && doing && (
            <Box display="none" hover={{ display: 'flex' }} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">
                · {doing}
              </Text>
            </Box>
          )}
          <Box flexGrow={1} />
          <Button key="sprout-open" label={t.openAgents} plain onPress={() => void openPane($)} />
        </Box>
        {others}
      </Box>
    )
  })

  // The pane: one card per agent, then the tree of the files they touched.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Svg is the desktop's alone: narrowing the event narrows the element table.
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : null
    // The text field exists on every surface but mobile.
    const Input = e.surface !== 'mobile' ? $.ui.resolve(e).Input : null
    const list = await read($, agents)
    const touched = await read($, files)
    const picked = await read($, filter)
    const chosen = await read($, selected)
    const search = await read($, query)
    const isSearching = await read($, searching)
    const marks = await read($, git)
    const at = await read($, now)

    if (list.length === 0) {
      return (
        <Box flexDirection="column" alignItems="center" padding={1} gap={1}>
          {Svg && <Svg source={botSvg('done')} alt={t.altDone} width={BOT_SIZE * 3} height={BOT_SIZE * 3} />}
          <Text dimColor>{t.empty}</Text>
        </Box>
      )
    }

    const running = list.filter(a => a.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
    const finished = list.filter(a => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const shown = [...running, ...finished].slice(0, MAX_CARDS)
    const cardCols = Math.max(
      CARD_COLS_MIN,
      Math.min(CARD_COLS_MAX, Math.round(e.props.bodyColumns * CARD_COLS_PER_CELL), Math.floor(CARD_DOTS_MAX / (CARD_ROWS * shown.length))),
    )
    const hidden = list.length - shown.length
    const shownRunning = shown.filter(a => a.status === 'running')
    const shownFinished = shown.filter(a => a.status !== 'running')
    const totalCost = list.reduce<number | null>((s, a) => addCost(s, a.costUsd), 0)
    const totalTokens = list.reduce((s, a) => s + a.tokens, 0)
    // Wall time from the first agent's start to the last one's end (or now, while one runs).
    const firstStart = Math.min(...list.map(a => a.startedAt))
    const waveEnd = running.length ? at : Math.max(...list.map(a => a.endedAt ?? a.startedAt))
    // The Agents tile says the state at a glance: orange while one runs, red if one failed, green once all are done.
    const orange = Svg ? RUN_SOFT : RUN
    // The failed agents' red: on the desktop the cards' red, between the theme's (dark on white, glaring on black).
    const stateColor = running.length ? orange : list.some(a => a.status === 'failed') ? (Svg ? BAR_FAIL : FAIL) : DONE
    const tiles: [string, string, string | undefined][] = [
      ['Agents', running.length ? t.runningOf(running.length, list.length) : t.inTotal(list.length), stateColor],
      [t.tileCost, fmtCost(totalCost) || '—', orange],
      [t.tileTokens, fmtTokens(totalTokens), undefined],
      [t.tileTime, fmtTime(Math.max(0, waveEnd - firstStart)), undefined],
    ]

    const bar = (a: AgentRun): JSX.Element => {
      const progress = progressOf(a)
      const ctx = contextPct(a)
      const isLive = a.status === 'running'
      // Without reported steps a running bar shows the context fill, in grey.
      const ratio = progress ?? (ctx ?? 0) / 100
      const isFailed = a.status === 'failed'
      const color = !isLive ? (isFailed ? BAR_FAIL : BAR_DONE) : progress === null ? BAR_CTX : BAR_LIVE
      if (Svg) {
        return <Svg source={dotBarSvg(ratio, color, isLive, a.id, cardCols, CARD_ROWS, isFailed ? BAR_FAIL : undefined)} alt={`${Math.round(ratio * 100)}%`} width={dotBarWidth(cardCols)} height={dotBarHeight(CARD_ROWS)} />
      }
      const [lit, unlit] = blockBar(ratio, 14)
      return (
        <Text>
          <Text color={isLive ? RUN : isFailed ? FAIL : DONE}>{lit}</Text>
          <Text dimColor>{unlit}</Text>
        </Text>
      )
    }

    const card = (a: AgentRun): JSX.Element => {
      const isLive = a.status === 'running'
      const owner = a.id
      const fileCount = touched.filter(f => f.agents.includes(owner)).length
      const isPicked = picked === owner
      const detail = isLive
        ? a.stepNote || a.lastTool || t.starting
        : a.status === 'failed'
          ? t.failed
          : a.answer
            ? `→ ${a.answer}`
            : t.done
      const steps = a.stepTotal ? t.steps(a.stepDone ?? 0, a.stepTotal) : ''
      const facts = [
        // Every request's whole context, summed: what the agent had processed, and what its cost comes from.
        a.tokens ? t.processed(fmtTokens(a.tokens)) : '',
        fmtCost(a.costUsd),
        fmtTime(elapsed(a, at)),
      ].filter(Boolean)
      const hex = isLive ? BAR_LIVE : a.status === 'failed' ? BAR_FAIL : BAR_DONE
      // Every card keeps three lines. On the desktop a finished agent's third line (done or failed) is its type and
      // start time, and its answer or failure shows on hover, in full (a hover can reveal, never hide, so a cut copy
      // would read twice); a running agent keeps its step in sight, its type and start time show on hover.
      const answerOnHover = Boolean(Svg && !isLive)
      // The filter button only when filtering would narrow the list, or to undo a filter.
      const hasFilter = fileCount > 0 && (fileCount < touched.length || isPicked)
      const started = new Date(a.startedAt)
      const clock = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`
      // Desktop: the outline at 80% of the bar's colour; under the pointer, full and a light tint. The card filtering
      // the tree keeps a stronger tint.
      const look = Svg
        ? {
            borderColor: `${hex}cc`,
            hover: { borderColor: hex, backgroundColor: `${hex}${isPicked ? '1f' : '0b'}`, ...(isLive ? { scope: LIVE_SCOPE } : {}) },
            ...(isPicked ? { backgroundColor: `${hex}1f` } : {}),
          }
        : { borderColor: isLive ? RUN : a.status === 'failed' ? FAIL : DONE }
      return (
        <Box key={`card-${a.id}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" overflow="hidden" {...look}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {Svg ? (
              <Svg source={botSvg(a.status)} alt={isLive ? t.altRunning : a.status === 'failed' ? t.altFailed : t.altDone} width={BOT_SIZE} height={BOT_SIZE} />
            ) : (
              <Text color={isLive ? RUN : a.status === 'failed' ? FAIL : DONE}>{isLive ? '●' : a.status === 'failed' ? '✗' : '✓'}</Text>
            )}
            {/* minWidth 0: a narrow card cuts its texts (title first, then the model) instead of overflowing. */}
            <Box flexShrink={1} minWidth={0}>
              <Text bold={isLive} wrap="truncate-end">
                {a.description || a.type}
              </Text>
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={2} minWidth={0}>
              <Text dimColor wrap="truncate-start">
                {modelName(a.model)}
                {a.effort ? ` · ${a.effort}` : ''}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1} marginLeft={2}>
            {/* The bar keeps its width in a narrow pane; the facts are cut instead. */}
            <Box flexShrink={0} marginRight={1}>
              {bar(a)}
            </Box>
            {/* Steps right after the bar; context, tokens, cost and time at the far right. */}
            {steps && <Text dimColor>{steps}</Text>}
            <Box flexGrow={1} />
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-start">
                {facts.join('  ·  ')}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={1} marginLeft={2}>
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor italic={!isLive && !answerOnHover} wrap="truncate-end">
                {answerOnHover ? t.cardInfo(a.type, clock) : clip(detail, DETAIL_MAX)}
              </Text>
            </Box>
            <Box flexGrow={1} />
            {hasFilter && (
              <Button
                key={`filter-${a.id}`}
                plain
                dimColor={!isPicked}
                label={t.filesButton(fileCount, isPicked)}
                onPress={() => void update($, filter, f => (f === owner ? null : owner))}
              />
            )}
          </Box>
          {/* Hidden until the pointer is on the card: the answer of a finished agent, else its type and start time. */}
          {Svg && (
            <Box display="none" hover={{ display: 'flex' }} marginLeft={2} marginTop={1}>
              <Text dimColor italic={answerOnHover}>
                {answerOnHover ? detail : t.cardInfo(a.type, clock)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    // Read / written marks: on the desktop two SVG dots of the same 8px size (ring, disc); glyphs on the terminal.
    const mark = (isWrite: boolean): JSX.Element =>
      Svg ? (
        <Svg source={isWrite ? MARK_WRITE : MARK_READ} alt={isWrite ? t.written : t.read} width={8} height={8} />
      ) : (
        <Text color={isWrite ? WRITE : READ}>{isWrite ? '●' : '○'}</Text>
      )

    const pickedRun = picked ? list.find(a => a.id === picked) : undefined
    const needle = isSearching ? search.trim().toLowerCase() : ''
    const rootKey = root.toLowerCase() + '/'
    const shownFiles = (pickedRun && picked ? touched.filter(f => f.agents.includes(picked)) : touched).filter(f => {
      const path = f.path.toLowerCase()
      return !needle || (path.startsWith(rootKey) ? path.slice(rootKey.length) : path).includes(needle)
    })
    const rows = treeRows(shownFiles, root)
    const visibleRows = rows.slice(0, MAX_FILE_ROWS)

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Session totals in four tiles; a narrow pane wraps them onto two rows. */}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {tiles.map(([label, value, color], i) => (
            <Box key={`tile-${i}`} flexDirection="column" flexGrow={1} borderStyle="round" borderColor="promptBorder" hover={{ borderColor: 'inactive' }} paddingX={1}>
              <Text dimColor>{label}</Text>
              <Text bold {...(color ? { color } : {})} wrap="truncate-end">
                {value}
              </Text>
            </Box>
          ))}
        </Box>
        {shownRunning.length > 0 && (
          <Box marginTop={1}>
            <Text bold color={orange}>
              {t.sectionRunning(running.length)}
            </Text>
          </Box>
        )}
        {shownRunning.map(card)}
        {shownFinished.length > 0 && (
          <Box marginTop={1}>
            <Text bold dimColor>
              {t.sectionDone(finished.length)}
            </Text>
          </Box>
        )}
        {shownFinished.map(card)}
        {hidden > 0 && (
          <Box marginTop={1}>
            <Text dimColor>
              {t.older(hidden)}
            </Text>
          </Box>
        )}

        {/* No rule between the agents and the files: the cards and the framed title already part them. */}
        <Box flexDirection="row" gap={1} marginTop={3} marginBottom={1} alignItems="center">
          <Box borderStyle="round" borderColor="promptBorder" paddingX={1}>
            <Text bold>{t.filesTitle}</Text>
          </Box>
          <Text dimColor>{shownFiles.length}</Text>
          {/* The magnifier opens the search field; pressed again, it closes it and drops the filter. */}
          {/* The magnifier emoji forced to its plain text form (U+FE0E): emoji size, no colours. */}
          {Input && touched.length > 0 && (
            // One more cell of room after the file count.
            <Box marginLeft={1}>
              <Button
                key="search-toggle"
                plain
                dimColor={!isSearching}
                label={'🔍︎'}
                onPress={() => {
                  void update($, searching, s => !s)
                  if (isSearching) void update($, query, () => '')
                }}
              />
            </Box>
          )}
          {/* Opened by the magnifier, on the same line; Enter filters on the path shown in the tree (relative to the session folder when inside it). */}
          {Input && isSearching && (
            <Box flexGrow={1} flexShrink={1}>
              <Input
                key="files-search"
                placeholder={t.searchPlaceholder}
                value={search}
                submitLabel="✕"
                autoFocus
                // The tree filters as you type; the text is kept as typed so the field never fights the cursor.
                onInput={(v: string) => void update($, query, () => v)}
                // Enter, or its ✕ beside the field, closes the search, as the magnifier pressed again.
                onSubmit={() => {
                  void update($, searching, () => false)
                  void update($, query, () => '')
                }}
              />
            </Box>
          )}
          {pickedRun && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                · {pickedRun.description || pickedRun.type}
              </Text>
            </Box>
          )}
          <Box flexGrow={1} />
          {/* Legend at the right, as the totals pill above. */}
          {rows.length > 0 && (
            <Box flexDirection="row" alignItems="center" gap={1}>
              {mark(false)}
              <Text color={READ}>{t.read}</Text>
              <Box marginLeft={1}>{mark(true)}</Box>
              <Text color={WRITE}>{t.written}</Text>
            </Box>
          )}
          {pickedRun && <Button key="filter-all" plain label={t.all} onPress={() => void update($, filter, () => null)} />}
        </Box>
        {chosen.length > 0 && (
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Text color={orange}>
              {t.attached(chosen.length)}
            </Text>
            <Box flexGrow={1} />
            <Button key="selected-clear" plain dimColor label={t.clear} onPress={() => void update($, selected, () => [])} />
          </Box>
        )}
        {rows.length === 0 && (
          <Text dimColor>{search ? t.noMatch(search) : t.noFiles}</Text>
        )}
        {visibleRows.map((r, i) =>
          r.isDir || !r.touch ? (
            // A blank row before each folder but the first, so groups read apart.
            <Box key={`dir-${r.key}`} flexDirection="row" alignItems="center" gap={1} marginLeft={r.depth * 2} marginTop={i > 0 ? 1 : 0}>
              {Svg ? <Svg source={FOLDER_ICON} alt={t.folder} width={14} height={12} /> : <Text dimColor>▸</Text>}
              {/* A long path outside the session folder is cut on the left, never past the pane's edge. */}
              <Box flexShrink={1} overflow="hidden">
                <Text dimColor wrap="truncate-start">
                  {r.name}/
                </Text>
              </Box>
            </Box>
          ) : (
            // A blank row too when a file comes back out of a folder, so it does not read as that folder's.
            <Box
              key={`file-${r.key}`}
              flexDirection="row"
              alignItems="center"
              gap={1}
              marginLeft={r.depth * 2}
              marginTop={i > 0 && (visibleRows[i - 1]?.depth ?? 0) > r.depth ? 1 : 0}
            >
              {mark(r.touch.writes > 0)}
              {/* Click: select for the next message; double-click: open. A recent file stands at full strength, the others dim until hovered. */}
              <Box flexShrink={1}>
                <Button key={`open-${r.key}`} plain dimColor={at - r.touch.lastAt >= RECENT_MS && !chosen.includes(r.touch.path)} label={r.name} onPress={() => pressFile($, r.touch!.path)} />
              </Box>
              <Box flexGrow={1} />
              {/* Then git's mark, "attached", and the count of agents for a file several of them touched. */}
              {marks[r.touch.path.toLowerCase()] && (
                <Text color={GIT_COLOR[marks[r.touch.path.toLowerCase()] as GitMark]} bold>
                  {marks[r.touch.path.toLowerCase()]}
                </Text>
              )}
              {chosen.includes(r.touch.path) && <Text color={orange}>{t.attachedTag}</Text>}
              {r.touch.agents.length > 1 && <Text dimColor>{r.touch.agents.length} agents</Text>}
            </Box>
          ),
        )}
        {rows.length > visibleRows.length && <Text dimColor>{t.more(rows.length - visibleRows.length)}</Text>}
      </Box>
    )
  })
}
