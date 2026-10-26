// One thing a loop did: a tool call's label (never a command's raw text) and when.
export type Action = {
  label: string
  at: number
}

// What a loop is doing: its latest tool call, or failing that its latest words.
export type Activity = {
  // The latest tool call's label, '' before the first one.
  doing: string
  // When that call started.
  doingAt: number
  // Tool calls of this loop still in flight; 0 between calls.
  active: number
  // When the last call in flight ended (0 while one runs).
  idleSince: number
  // The first line of the loop's latest model text, and when it came.
  said: string
  saidAt: number
  // The last five actions, newest first.
  recent: Action[]
}

export type AgentCard = Activity & {
  id: string
  description: string
  type: string
  model: string
  effort: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number
  steps: number
  tools: number
  lastTool: string
  tokens: number
  outTokens: number
  context: number
  cost: number
  // What the helper was asked: the Agent call's prompt, whole.
  prompt: string
  // The helper's own task list, when it keeps one; empty when it does not.
  plan: PlanStep[]
  // Set on a card that is a Codex run (codex_delegate.py) rather than a helper.
  codex?: CodexRun
}

// A Codex run the session started through codex_delegate.py, read from its
// command's flags and then from the files the run writes.
export type CodexRun = {
  // Its --label as the runner writes it into the run folder's name (default
  // "delegation"); '' when the command builds it from something unknown.
  label: string
  // Its --out, with the command's own variables filled in; '' when unknown.
  out: string
  // Its time limit (--timeout, else the runner's 1800 seconds), in ms.
  limitMs: number
  // Request fields the command names literally ('' when not, or not known):
  // they pick its run folder out of others of the same label.
  requestId: string
  base: string
  head: string
  // Its --job-type until the run's request says ('review', 'plan', 'legacy').
  jobType: string
  // The repository its request names (repo_id, e.g. github.com/o/r); '' until read.
  repoId: string
  // True when its --profile has a fallback that can run it a second time (or
  // the profile is not known).
  hasFallback: boolean
  // True once the card follows that fallback's own run folder.
  isFallback: boolean
  // 'main', or the id of the helper that started it.
  owner: string
  // True when the background command ends with its helper's final answer.
  endsWithOwner: boolean
  // The background task's id, once the call answered with one.
  taskId: string
  // The runner's exit code once it ended; else -1.
  exitCode: number
  // The run folder (<dir of out>/.codex-runs/<run id>), its stamp and the
  // request id it holds, once found.
  runDir: string
  runAt: number
  runRequestId: string
  // The Codex process and its session log, once found.
  pid: number
  rollout: string
  // The model's context window, from its log; 0 until read.
  window: number
  // When the run's files were last read.
  readAt: number
  // When its receipt was first seen saying it ended (0 until then), and what
  // it said: the exit code (-1 when none) and the terminal status.
  endSeenAt: number
  endCode: number
  endStatus: string
  // How long past runs like it took (the median: same repository, else same
  // label, else same job type), and how many there were; 0 when fewer than
  // three, and the card counts to its limit instead.
  expectedMs: number
  history: number
  // Where its limit is counted from: the call, or a fallback's own start.
  deadlineFrom: number
}

// One step of a helper's task list (TodoWrite, or TaskCreate and TaskUpdate).
export type PlanStep = {
  id: string
  title: string
  // The step's present-continuous form ("Running tests"), when given.
  active: string
  status: 'pending' | 'in_progress' | 'completed'
}

// The main loop of the session.
export type MainRow = Activity & {
  // The last prompt the owner typed (first line), and when.
  lastPrompt: string
  lastPromptAt: number
}

// One shell command of the session, by whoever ran it.
export type ShellRow = {
  // The tool_use id of the Bash or Monitor call.
  id: string
  // The background task's id, once the call answered with one.
  taskId: string
  // The call's own description; never its command.
  description: string
  // 'main', or the id of the helper that ran it.
  owner: string
  kind: 'bash' | 'monitor'
  isBackground: boolean
  status: 'running' | 'ok' | 'failed' | 'stopped'
  // The exit code, when the notification says it; else -1.
  exitCode: number
  startedAt: number
  endedAt: number
  // True when the command ends with its helper's final answer.
  endsWithOwner: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      agents: Record<string, AgentCard>
      isCollapsed: boolean
      now: number
      hiddenIds: string[]
      main: MainRow
      shells: Record<string, ShellRow>
      isShellsCollapsed: boolean
      // Ids of the cards whose prompt is shown whole.
      openPrompts: string[]
      // The conversation the cards belong to; a new id clears them.
      sessionId: string
      // Whether the owner has typed a prompt in this conversation yet.
      hasPrompted: boolean
    }
  }
}
