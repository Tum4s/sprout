import type { AgentRun, FileTouch } from '../types'

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// $ per million tokens [input, output, cache read, cache write], from the official table
// (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-09). Cache writes use the
// 1-hour rate: Claude Code's cache TTL is not reported per request, so the cost is an estimate.
// Order matters: the first pattern that matches wins.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/(fable|mythos)-5/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus-(5|4-[5-8])/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet-4/, [3, 15, 0.3, 6]],
  [/haiku-4-5/, [1, 5, 0.1, 2]],
]

const promptTokens = (u: Usage): number =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

export const allTokens = (u: Usage): number => promptTokens(u) + (u.output_tokens || 0)

/** Estimated USD cost of one response, or null for a model outside the table. */
export function costOf(model: string, u: Usage): number | null {
  const id = model.toLowerCase()
  let price = PRICES.find(([re]) => re.test(id))?.[1]
  // Haiku 5.5 is priced by prompt size: up to 100,000 tokens, then a higher tier.
  if (!price && /haiku-5-5/.test(id)) price = promptTokens(u) > 100_000 ? [0.5, 2.5, 0.05, 1] : [0.1, 0.5, 0.01, 0.2]
  if (!price) return null
  const [i, o, r, w] = price
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

export const addCost = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

export const fmtCost = (usd: number | null): string =>
  usd === null ? '' : `≈$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

/** "Sonnet 5.5" from "claude-sonnet-5-5[1m]". */
export function modelName(id: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  const [, family = '', major = '', minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

/** 0..1 from the steps the agent reported, 1 once finished, null when unknown. */
export function progressOf(a: AgentRun): number | null {
  if (a.status !== 'running') return 1
  return a.stepTotal ? Math.min(1, (a.stepDone ?? 0) / a.stepTotal) : null
}

export const contextPct = (a: AgentRun): number | null =>
  a.contextWindow ? Math.min(100, Math.round((a.contextTokens / a.contextWindow) * 100)) : null

export const elapsed = (a: AgentRun, now: number): number => (a.endedAt ?? Math.max(now, a.startedAt)) - a.startedAt

/** `s` cut to `max` characters, an ellipsis included. */
export const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)

/** First meaningful line of a final answer, without markdown marks. */
export function firstLine(text: string, max = 160): string {
  const line =
    text
      .split('\n')
      .map(l => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*|__|`/g, '').trim())
      .find(l => l.length > 0) ?? ''
  return clip(line, max)
}

export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => d.toUpperCase() + ':')

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/**
 * Steps read from the agent's own todo list (TodoWrite sends the whole list; TaskCreate / TaskUpdate one task at a
 * time), for agents that do not report through the `step` tool. Returns `a` unchanged for any other tool.
 */
export function todoSteps(a: AgentRun, tool: string, args: Record<string, unknown>): AgentRun {
  if (a.stepSource === 'step') return a
  if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
    const todos = args.todos as { status?: string; activeForm?: string; content?: string }[]
    const current = todos.find(t => t.status === 'in_progress')
    return {
      ...a,
      stepSource: 'todo',
      stepTotal: todos.length,
      stepDone: todos.filter(t => t.status === 'completed').length,
      stepNote: current?.activeForm || current?.content || a.stepNote,
    }
  }
  // ponytail: counts TaskUpdate events, not task ids; a task completed twice counts twice (capped at the total).
  const total = a.stepSource === 'todo' ? (a.stepTotal ?? 0) : 0
  const done = a.stepSource === 'todo' ? (a.stepDone ?? 0) : 0
  if (tool === 'TaskCreate') return { ...a, stepSource: 'todo', stepTotal: total + 1, stepDone: done }
  if (tool === 'TaskUpdate') {
    const status = args.status
    const nextTotal = status === 'deleted' ? Math.max(0, total - 1) : total
    const nextDone = Math.min(nextTotal, done + (status === 'completed' ? 1 : 0))
    const note = status === 'in_progress' ? String(args.activeForm || args.subject || '') || a.stepNote : a.stepNote
    return { ...a, stepSource: 'todo', stepTotal: nextTotal, stepDone: nextDone, stepNote: note }
  }
  return a
}

/** A short label of what an agent is doing, from a tool call's name and arguments. */
export function toolLabel(tool: string, args: Record<string, unknown>): string {
  const name = tool.replace(/^mcp__.+?__/, '')
  const path = args.file_path ?? args.notebook_path ?? args.path
  if (typeof path === 'string' && path) return `${name} ${baseName(normPath(path))}`
  if (typeof args.pattern === 'string') return `${name} "${args.pattern.slice(0, 40)}"`
  if (typeof args.command === 'string') return `${name}: ${(args.command.trim().split(/\s+/)[0] ?? '').slice(0, 48)}`
  return name
}

// --- Dot-matrix bar (the app's Ultracode slider): square dots, gap = half a dot, dots sized so 4 rows fill 8px ---

const DOT = 8 / (4 + 3 / 2)
const PITCH = DOT * 1.5
const TWINKLES = Array.from(
  { length: 10 },
  (_, i) => `.k${i}{animation:tw ${(1.8 + i * 0.3).toFixed(1)}s linear ${(-i * 0.73).toFixed(2)}s infinite}`,
).join('')
// Fast rise, slower fall, as measured on the app's slider (~150 ms up, ~300 ms down).
const TWINKLE_CSS = `<style>${TWINKLES}@keyframes tw{0%,60%{fill-opacity:.65}66%{fill-opacity:1}85%,100%{fill-opacity:.65}}@media (prefers-reduced-motion: reduce){rect{animation:none}}</style>`

// A light theme: see-through dots wash out on white, so lit dots (the ones with an `opacity`) fill solid and fade
// in by column tenths, .g0 at 50% to .g9 at 100%, keeping the dark theme's left-to-right ramp; the track gets
// darker, Claude's orange and the done green deeper. A live bar's twinkle still animates its fill-opacity.
const LIGHT_RAMP = Array.from({ length: 10 }, (_, i) => `.g${i}{opacity:${(0.5 + i / 18).toFixed(2)}}`).join('')
const LIGHT_CSS =
  `<style>@media (prefers-color-scheme: light){rect[opacity]{fill-opacity:1}${LIGHT_RAMP}rect:not([opacity]){fill-opacity:.3}` +
  '[fill="#d97757"]{fill:#c4572f}[fill="#7fb88f"]{fill:#3f8f5a}}</style>'

/** Git's own word for a file, from `git status --porcelain -z`: modified, added, untracked or deleted. */
export type GitMark = 'M' | 'A' | 'U' | 'D'

/** Each changed file's mark, keyed by its absolute path in lower case; `top` is the repository's root. */
export function gitMarks(top: string, porcelain: string): Record<string, GitMark> {
  const marks: Record<string, GitMark> = {}
  const entries = porcelain.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const mark: GitMark = code === '??' ? 'U' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : 'M'
    marks[`${top}/${entry.slice(3)}`.toLowerCase()] = mark
    // A rename or copy carries its old path as the next entry.
    if (/[RC]/.test(code)) i++
  }
  return marks
}

/** Pixels spanned by `n` dots in a row or a column (the epsilon keeps 4 rows at exactly 8px). */
const span = (n: number): number => Math.ceil(n * PITCH - (PITCH - DOT) - 1e-9)

export const dotBarWidth = (cols: number): number => span(cols)

export const dotBarHeight = (rows: number): number => span(rows)

/**
 * SVG source of a dot bar: `ratio` of the columns lit in `color`, brighter to the right, twinkling while `isLive`.
 * Seeded by `seed`, so the same agent draws the same source and its animation does not restart on each redraw.
 */
export function dotBarSvg(ratio: number, color: string, isLive: boolean, seed: string, cols = 32, rows = 4, track = '#888'): string {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const rnd = (): number => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
  const lit = Math.round(Math.max(0, Math.min(1, ratio)) * cols)
  const size = DOT.toFixed(2)
  let dots = ''
  for (let c = 0; c < cols; c++) {
    const base = 0.45 + 0.4 * (c / Math.max(1, cols - 1))
    for (let r = 0; r < rows; r++) {
      const at = `x="${(c * PITCH).toFixed(2)}" y="${(r * PITCH).toFixed(2)}" width="${size}" height="${size}"`
      if (c >= lit) {
        dots += `<rect ${at} fill="${track}" fill-opacity="0.18"/>`
        continue
      }
      const opacity = (base * (0.85 + 0.3 * rnd())).toFixed(2)
      // g<n>: the column's tenth, for the light theme's ramp; k<n>: one of the twinkle rhythms while live.
      const ramp = `g${Math.min(9, Math.floor((c / cols) * 10))}`
      const classes = isLive ? `${ramp} k${Math.floor(rnd() * 10)}` : ramp
      dots += `<rect ${at} fill="${color}" opacity="${opacity}" fill-opacity="0.65" class="${classes}"/>`
    }
  }
  const w = dotBarWidth(cols)
  const height = dotBarHeight(rows)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}">${isLive ? TWINKLE_CSS : ''}${LIGHT_CSS}${dots}</svg>`
}

/** Terminal fallback: filled and empty half blocks for a bar `width` cells wide. */
export function blockBar(ratio: number, width: number): [string, string] {
  const lit = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return ['▄'.repeat(lit), '▄'.repeat(width - lit)]
}

// --- Tree of touched files ---

export type TreeRow = { key: string; depth: number; name: string; isDir: boolean; touch?: FileTouch }

type Node = { name: string; dirs: Map<string, Node>; files: FileTouch[] }

/**
 * Rows of a tree of `files`, relative to `root` when under it. Folders first, then files, by name;
 * a folder with a single subfolder and no file is merged into one row ("hooks/utils").
 */
export function treeRows(files: FileTouch[], root: string): TreeRow[] {
  const rootKey = normPath(root).replace(/\/+$/, '').toLowerCase()
  const top: Node = { name: '', dirs: new Map(), files: [] }
  for (const f of files) {
    const full = normPath(f.path)
    const isInside = rootKey !== '' && full.toLowerCase().startsWith(rootKey + '/')
    const parts = (isInside ? full.slice(rootKey.length + 1) : full).split('/').filter(Boolean)
    let node = top
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (!next) {
        next = { name: part, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(f)
  }
  const rows: TreeRow[] = []
  const walk = (node: Node, depth: number, prefix: string): void => {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let name = dir.name
      let cur = dir
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        cur = [...cur.dirs.values()][0]!
        name += '/' + cur.name
      }
      const key = `${prefix}/${name}`
      rows.push({ key, depth, name, isDir: true })
      walk(cur, depth + 1, key)
    }
    for (const f of [...node.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))) {
      rows.push({ key: f.path, depth, name: baseName(normPath(f.path)), isDir: false, touch: f })
    }
  }
  walk(top, 0, '')
  return rows
}

/**
 * The pane's totals as a pill: faded orange fill and outline, light orange text (dark theme), about 6.2px per
 * character of 12px system-ui plus 8px of padding each side.
 */
export function totalsPill(costUsd: number | null, tokens: number): { label: string; source: string; width: number } {
  const label = [fmtCost(costUsd), `${fmtTokens(tokens)} tk`].filter(Boolean).join('  ·  ')
  const width = Math.round(16 + label.length * 6.2)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="19" rx="9.5" fill="#d97757" fill-opacity="0.16" stroke="#d97757" stroke-opacity="0.45"/>` +
    `<text x="${width / 2}" y="14" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#f0b9a3">${label}</text>` +
    // A light theme: the pale peach text would vanish on white, a deeper orange reads.
    `<style>@media (prefers-color-scheme: light){text{fill:#a8482a}}</style></svg>`
  return { label, source, width }
}

// --- The agent's mascot (the IT bot, sunset palette): leaf antennas, round head, glowing eyes, walking while it works ---

const BOT_CSS =
  '<style>*{transform-box:fill-box;transform-origin:center}' +
  '.b{animation:b 1.2s ease-in-out infinite}.e{animation:e 3.2s infinite}' +
  '.l{animation:l 1.6s ease-in-out infinite;transform-origin:bottom center}.r{animation:r 1.6s ease-in-out infinite;transform-origin:bottom center}' +
  '.p{animation:p .5s ease-in-out infinite}.q{animation:q .5s ease-in-out infinite}' +
  '.m{animation:m .5s ease-in-out infinite;transform-origin:top center}.n{animation:n .5s ease-in-out infinite;transform-origin:top center}' +
  '@keyframes b{50%{transform:translateY(-.7px)}}@keyframes e{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}' +
  '@keyframes l{50%{transform:rotate(-6deg)}}@keyframes r{50%{transform:rotate(6deg)}}' +
  '@keyframes p{50%{transform:translateY(-1px)}}@keyframes q{0%,100%{transform:translateY(-1px)}50%{transform:translateY(0)}}' +
  '@keyframes m{50%{transform:rotate(22deg)}}@keyframes n{50%{transform:rotate(-22deg)}}' +
  '@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>'

const SUN =
  '<defs><linearGradient id="atb-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b2bd6"/><stop offset=".55" stop-color="#e2489b"/><stop offset="1" stop-color="#ff9f45"/></linearGradient>' +
  '<linearGradient id="atb-belly" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7aa8"/><stop offset="1" stop-color="#ffb35c"/></linearGradient>' +
  '<linearGradient id="atb-leaf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2fd6c4"/><stop offset="1" stop-color="#ff6fb1"/></linearGradient></defs>'

const BOT: Record<AgentRun['status'], string> = {
  // Walking: body bobs, antennas sway, eyes blink, arms and legs alternate.
  running:
    BOT_CSS +
    SUN +
    '<g class="b"><ellipse class="l" cx="5" cy="1.4" rx="1.4" ry=".75" fill="url(#atb-leaf)" stroke="#2a0f4a" stroke-width=".35"/><ellipse class="r" cx="15" cy="1.4" rx="1.4" ry=".75" fill="url(#atb-leaf)" stroke="#2a0f4a" stroke-width=".35"/>' +
    '<rect x="4" y="3" width="12" height="9" rx="4.2" fill="url(#atb-sun)" stroke="#2a0f4a" stroke-width=".6"/><g class="e"><circle cx="8" cy="7.4" r="1.6" fill="#7ff6ff"/><circle cx="12" cy="7.4" r="1.6" fill="#7ff6ff"/></g>' +
    '<ellipse class="m" cx="4.6" cy="14.2" rx="1.1" ry="2" fill="#9d7bf7" stroke="#2a0f4a" stroke-width=".35"/><ellipse class="n" cx="15.4" cy="14.2" rx="1.1" ry="2" fill="#9d7bf7" stroke="#2a0f4a" stroke-width=".35"/>' +
    '<rect x="6" y="12" width="8" height="5.2" rx="2" fill="url(#atb-belly)" stroke="#2a0f4a" stroke-width=".45"/></g>' +
    '<rect class="p" x="7.4" y="17" width="1.8" height="2.4" rx=".6" fill="#7a4ff0" stroke="#2a0f4a" stroke-width=".3"/><rect class="q" x="10.8" y="17" width="1.8" height="2.4" rx=".6" fill="#7a4ff0" stroke="#2a0f4a" stroke-width=".3"/>',
  // Done: all green, smiling eyes, one arm raised.
  done:
    '<defs><linearGradient id="atb-ok" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14532d"/><stop offset="1" stop-color="#22a35a"/></linearGradient></defs>' +
    '<ellipse cx="5" cy="1.4" rx="1.4" ry=".75" fill="#2a8a55" stroke="#0f2e1c" stroke-width=".35"/><ellipse cx="15" cy="1.4" rx="1.4" ry=".75" fill="#2a8a55" stroke="#0f2e1c" stroke-width=".35"/>' +
    '<rect x="4" y="3" width="12" height="9" rx="4.2" fill="url(#atb-ok)" stroke="#0f2e1c" stroke-width=".6"/><path d="M6.6 7.8q1.4-1.4 2.8 0M10.6 7.8q1.4-1.4 2.8 0" stroke="#d0ffe0" stroke-width=".8" fill="none"/>' +
    '<ellipse cx="3.6" cy="11.6" rx="1.1" ry="2" fill="#1e7a45" stroke="#0f2e1c" stroke-width=".35" transform="rotate(40 3.6 11.6)"/><ellipse cx="15.4" cy="14.2" rx="1.1" ry="2" fill="#1e7a45" stroke="#0f2e1c" stroke-width=".35"/>' +
    '<rect x="6" y="12" width="8" height="5.2" rx="2" fill="#4fbf7a" stroke="#0f2e1c" stroke-width=".45"/>' +
    '<rect x="7.4" y="17" width="1.8" height="2.2" rx=".6" fill="#14532d" stroke="#0f2e1c" stroke-width=".3"/><rect x="10.8" y="17" width="1.8" height="2.2" rx=".6" fill="#14532d" stroke="#0f2e1c" stroke-width=".3"/>',
  // Failed: all red, crossed eyes, drooping antennas and arms.
  failed:
    '<defs><linearGradient id="atb-fail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a1f3a"/><stop offset="1" stop-color="#b8323f"/></linearGradient></defs>' +
    '<ellipse cx="5.4" cy="1.8" rx="1.2" ry=".6" fill="#7a2a4a" stroke="#2a0f4a" stroke-width=".35" transform="rotate(30 5.4 1.8)"/><ellipse cx="14.6" cy="1.8" rx="1.2" ry=".6" fill="#7a2a4a" stroke="#2a0f4a" stroke-width=".35" transform="rotate(-30 14.6 1.8)"/>' +
    '<rect x="4" y="3" width="12" height="9" rx="4.2" fill="url(#atb-fail)" stroke="#2a0f4a" stroke-width=".6"/><path d="M7 6.4l2 2M9 6.4l-2 2M11 6.4l2 2M13 6.4l-2 2" stroke="#ffd0d6" stroke-width=".7"/>' +
    '<ellipse cx="4.6" cy="15" rx="1.1" ry="2" fill="#8a2b3e" stroke="#2a0f4a" stroke-width=".35"/><ellipse cx="15.4" cy="15" rx="1.1" ry="2" fill="#8a2b3e" stroke="#2a0f4a" stroke-width=".35"/>' +
    '<rect x="6" y="12" width="8" height="5.2" rx="2" fill="#c45a6a" stroke="#2a0f4a" stroke-width=".45"/>' +
    '<rect x="7.4" y="17" width="1.8" height="2.2" rx=".6" fill="#5a1f3a" stroke="#2a0f4a" stroke-width=".3"/><rect x="10.8" y="17" width="1.8" height="2.2" rx=".6" fill="#5a1f3a" stroke="#2a0f4a" stroke-width=".3"/>',
}

/** SVG source of the mascot for an agent's status, drawn on a 20x20 grid (scaled by the Svg's size). */
export const botSvg = (status: AgentRun['status']): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${BOT[status]}</svg>`
