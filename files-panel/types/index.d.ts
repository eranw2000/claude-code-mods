// What git says about a file Claude edited or wrote, as the last check read it.
//   unknown    not checked yet (or the check failed)
//   clean      tracked, and git status lists nothing for it: committed
//   dirty      git status lists a change (staged or not, deleted included)
//   untracked  git status lists it as ??
//   untracked-ignored  not listed and not tracked: ignored, or gone
//   no-git     the file is in no git repository
export type GitState = 'unknown' | 'clean' | 'dirty' | 'untracked' | 'untracked-ignored' | 'no-git'

// One path Claude touched this session: a file, or a folder Glob or Grep searched.
export type FileRow = {
  // The absolute path as the tool call named it (normalised).
  path: string
  // True for a folder a Glob or Grep searched.
  isFolder: boolean
  // True once the git repository holding it was looked up.
  isResolved: boolean
  // The repository root, as git prints it; '' outside any repository.
  root: string
  // The path inside the repository ('' for the root itself); outside one, the path.
  rel: string
  // True once an Edit, MultiEdit, NotebookEdit or Write on it succeeded.
  hasWritten: boolean
  git: GitState
  // The verb of the latest call on it: reading, editing, writing, searching.
  verb: string
  // Calls on it still in flight.
  active: number
  // Who touched it last: 'main', or the helper's description.
  by: string
  // When it was last touched (start of a call, then its end).
  at: number
}

// A folder's repository lookup: its root and its own path inside it ('a/b/').
export type DirInfo = {
  root: string
  prefix: string
}

declare module 'claude-code' {
  interface PluginState {
    'files-panel': {
      files: Record<string, FileRow>
      dirs: Record<string, DirInfo>
      helpers: Record<string, string>
      now: number
      cwd: string
      hasOpened: boolean
      isOpen: boolean
      // The conversation the rows belong to; a new id clears them.
      sessionId: string
      // The project folder; files outside it are folded under Other places.
      root: string
      isOtherOpen: boolean
    }
  }
}
