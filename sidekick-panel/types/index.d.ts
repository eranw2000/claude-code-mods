// One question typed into the Sidekick pane, and what came back.
export type AskStatus = 'asking' | 'answered' | 'failed'

// 'ask' is answered with no tools; 'do' is a line starting with "!", carried
// out by a helper that has them; 'see' is a question with an image: a helper
// whose only tool is Read reports on the image, and a fork answers from that.
export type AskKind = 'ask' | 'do' | 'see'

export type AskEntry = {
  // Unique in the conversation: the time it was asked plus a counter.
  id: string
  // Absent on an entry from before 0.2.0, which is a question.
  kind?: AskKind
  // The helper doing a 'do' entry, once it has started.
  agentId?: string
  // True while this answer offers its Do it button; taken by the first press.
  canDo?: boolean
  // True when the "still alive" check closed this entry. That was a guess, so a
  // report arriving later still lands on it.
  closedByWatch?: boolean
  question: string
  // The image sent with this line, its full path; absent when none was.
  image?: string
  // A question with an image that is longer than `question` keeps, until the
  // fork that answers it has been asked. Absent otherwise.
  fullQuestion?: string
  askedAt: number
  status: AskStatus
  // '' until the fork answered.
  answer: string
  // 0 until the fork settled, answered or failed.
  doneAt: number
  // Why it failed, in the person's words; '' otherwise.
  note: string
  // What the answer cost: the reply's tokens, and how much of the
  // conversation the prompt cache served.
  outputTokens: number
  cacheReadTokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'sidekick-panel': {
      // Newest last. Dropped on /clear or a resume: they were about the old
      // conversation.
      entries: Shaped<AskEntry[]>
      // The conversation the entries belong to; a new id clears them.
      sessionId: string
      // Counts the questions sent; the Input's key carries it, so a sent
      // question leaves an empty field behind.
      gen: number
      // The time the pane last moved its "thinking" clock on.
      now: number
      // True once the pane opened by itself in this conversation; a reload
      // then opens nothing. Reset on /clear or a resume.
      hasOpened: boolean
      // The main loop's newest reply, handed to the fork until the next
      // prompt carries it in the transcript; '' when none is owed.
      lastAnswer: string
      // The image waiting for the next line, its full path; '' when none is.
      attachment: string
      // What the last press of the paste button has to say; '' when nothing.
      attachNote: string
    }
  }
}
