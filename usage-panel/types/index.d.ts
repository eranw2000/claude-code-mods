// The account the session is signed in to, as the login record has it.
export type UsageAccount = {
  email: string
  // The plan's display name; '' when the record has none.
  plan: string
}

// One usage limit, as the engine reports it.
export type UsageWindow = {
  // seven_day, five_hour, spend_limit, or any other kind the engine reports.
  kind: string
  percentUsed: number
  // ISO 8601; absent when the engine has no reset time.
  resetsAt?: string
}

// The limits a reply reported.
export type UsageReading = {
  windows: UsageWindow[]
  // When they arrived, in $.clock.now()'s milliseconds.
  at: number
  // The account they belong to, so a switch can hide them; '' with no login record.
  email: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-panel': {
      // null: no account in the login record (an API key, or signed out).
      account: UsageAccount | null
      // null: no answer has reported limits yet.
      reading: UsageReading | null
      // The email signed in when the main loop's turn started; null until this load sees one.
      askedBy: string | null
      // True once this conversation's first prompt has opened the pane.
      hasPrompted: boolean
      // The time the pane last checked, so a limit that reset is seen.
      now: number
    }
  }
}
