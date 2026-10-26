// One prompt the owner typed, and the first paragraph of the main loop's
// latest answer after it.
export type ThreadEntry = {
  // Counts from 1 in the conversation.
  n: number
  prompt: string
  promptAt: number
  // '' until a turn after the prompt ends with visible text.
  answer: string
  answerAt: number
  // True when the newest turn after the prompt was interrupted.
  isStopped: boolean
  // The transcript row the prompt was stored as, so a click can scroll to it.
  // Absent until the row is stored.
  rowId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'thread-panel': {
      // The owner's prompts, oldest first.
      thread: ThreadEntry[]
      // Ids of the entries whose prompt is shown whole.
      openPrompts: string[]
      // The conversation the entries belong to; a new id clears them.
      sessionId: string
      // The time the pane last moved its "ago" labels on.
      now: number
    }
  }
}
