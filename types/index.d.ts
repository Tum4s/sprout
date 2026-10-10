export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  /** The subagent's loop id (same as agentId): only agents that have one are followed. */
  id: string
  agentId?: string
  description: string
  type: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  /** Tokens the next request re-sends (input + cache + output of the last response). */
  contextTokens: number
  /** Context window when known (same model as the session), else 0. */
  contextWindow: number
  tokens: number
  /** Estimated cost in USD; null when the model is not in the price table. */
  costUsd: number | null
  requests: number
  lastTool?: string
  /** Self-reported through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  /** Where the steps come from: the `step` tool, or the agent's own todo list when it never called it. */
  stepSource?: 'step' | 'todo'
  /** First line of the final answer. */
  answer?: string
}

export type FileTouch = {
  /** Absolute path, forward slashes. */
  path: string
  agents: string[]
  writes: number
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    sprout: {
      agents: AgentRun[]
      files: FileTouch[]
      /** Ticks every second while agents run, so durations and the band's timeout redraw. */
      now: number
      /** Start of the current wave of agents: the band and its totals cover agents started since. */
      waveStart: number
      /** Agent whose files the pane shows; null for all. */
      filter: string | null
      /** Files the person picked in the pane, handed to Claude with their next message. */
      selected: string[]
      /** Text typed in the files search; empty shows every file. */
      query: string
      /** Whether the search field is open (the magnifier toggles it). */
      searching: boolean
      /** Git status of changed files in the session folder, by lower-cased absolute path. */
      git: Record<string, "M" | "A" | "U" | "D">
    }
  }
}
