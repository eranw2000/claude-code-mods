import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'

import type { DirInfo, FileRow, GitState } from '../types'

const PANE = 'files-panel'
const TITLE = 'Files'
const files = atom({ plugin: 'files-panel', key: 'files' } as const, {} as Record<string, FileRow>)
const dirs = atom({ plugin: 'files-panel', key: 'dirs' } as const, {} as Record<string, DirInfo>)
const helpers = atom({ plugin: 'files-panel', key: 'helpers' } as const, {} as Record<string, string>)
const now = atom({ plugin: 'files-panel', key: 'now' } as const, 0)
const cwd = atom({ plugin: 'files-panel', key: 'cwd' } as const, '')
const hasOpened = atom({ plugin: 'files-panel', key: 'hasOpened' } as const, false)
const isOpen = atom({ plugin: 'files-panel', key: 'isOpen' } as const, false)
// The conversation the rows belong to; '' until the first event reads it.
const sessionId = atom({ plugin: 'files-panel', key: 'sessionId' } as const, '')
// The project folder (where the session started, or where /cd took it); a file
// outside it goes in the folded "Other places" group.
const root = atom({ plugin: 'files-panel', key: 'root' } as const, '')
const isOtherOpen = atom({ plugin: 'files-panel', key: 'isOtherOpen' } as const, false)

// The slow git check while the pane is open.
const EVERY_MS = 15_000
// Paths per git call, so an argument list never grows past what a shell takes.
const CHUNK = 100
const ORANGE = '#d9734e'
const BLUE = '#4a90e2'
const GREEN = 'success'
// Outside any repository, rows are grouped under this key.
const OUTSIDE = '\u0000outside'

type Target = { raw: string; verb: string; isFolder: boolean; isWrite: boolean }
type Shown = 'working' | 'searched' | 'committed' | 'changed' | 'read'

let ticker: Timer | undefined

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// What a call does to which path; undefined for a call that touches no file.
// Bash is not here: its command is never read.
function targetOf(tool: string, a: Record<string, unknown>): Target | undefined {
  switch (tool) {
    case 'Read': return { raw: str(a.file_path), verb: 'reading', isFolder: false, isWrite: false }
    case 'Edit': case 'MultiEdit':
      return { raw: str(a.file_path), verb: 'editing', isFolder: false, isWrite: true }
    case 'NotebookEdit': return { raw: str(a.notebook_path), verb: 'editing', isFolder: false, isWrite: true }
    case 'Write': return { raw: str(a.file_path), verb: 'writing', isFolder: false, isWrite: true }
    case 'Glob': case 'Grep': return { raw: str(a.path), verb: 'searching', isFolder: true, isWrite: false }
    default: return undefined
  }
}

function normalize(path: string, base: string): string {
  const abs = path.startsWith('/') ? path : `${base || '/'}/${path}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function fit(text: string, cols: number): string {
  return text.length <= cols ? text : `${text.slice(0, Math.max(1, cols - 1))}…`
}

// A path cut from its head, so its end (the file) stays readable.
function fitPath(text: string, cols: number): string {
  return text.length <= cols ? text : `…${text.slice(text.length - Math.max(1, cols - 1))}`
}

// A line cut to `cols` from its head part, so the tail (a state, an age) stays whole.
// On a narrow pane the head keeps at least a few cells and the tail is cut too.
function withTail(head: string, tail: string, cols: number): string {
  const room = Math.max(Math.min(head.length, 8), cols - tail.length)
  const line = head.length <= room ? head + tail : fit(head, room) + tail
  return fit(line, cols)
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h${m % 60}m ago`
}

function shownOf(row: FileRow): Shown {
  if (row.active > 0) return 'working'
  if (row.isFolder) return 'searched'
  if (row.hasWritten) return row.git === 'clean' ? 'committed' : 'changed'
  return 'read'
}

function stateWord(row: FileRow): string {
  const shown = shownOf(row)
  if (shown === 'working') return row.verb
  if (shown === 'changed') {
    if (row.git === 'no-git') return 'changed · no git'
    if (row.git === 'untracked') return 'changed · untracked'
    if (row.git === 'untracked-ignored') return 'changed · not tracked'
    return 'changed'
  }
  return shown
}

function blank(path: string, t: Target, by: string, at: number): FileRow {
  return {
    path, isFolder: t.isFolder, isResolved: false, root: '', rel: path, hasWritten: false,
    git: 'unknown', verb: t.verb, active: 0, by, at,
  }
}

// Who made a call: 'main', a helper's description, or undefined for a helper
// this conversation does not know (one of an earlier conversation, still busy
// after a /clear), whose files are not listed.
async function whoIs($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (!agentId) return 'main'
  const known = (await read($, helpers))[agentId]
  if (known) return known
  try {
    const info = (await $.agent.list()).find(a => a.id === agentId)
    if (info?.description) {
      await update($, helpers, h => ({ ...h, [agentId]: info.description }))
      return info.description
    }
  } catch {}
  return undefined
}

// The repository holding a folder, asked of git once per folder. Read-only.
async function resolveDir($: EngineInterface, dir: string): Promise<DirInfo | undefined> {
  const known = (await read($, dirs))[dir]
  if (known) return known
  let info: DirInfo
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel', '--show-prefix'], { timeoutMs: 10_000 })
    if (r.exitCode === 0) {
      const [root = '', prefix = ''] = r.stdout.split('\n')
      info = { root, prefix }
    } else if (/not a git repository/i.test(r.stderr)) {
      info = { root: '', prefix: '' }
    } else {
      return undefined
    }
  } catch {
    return undefined
  }
  await update($, dirs, d => ({ ...d, [dir]: info }))
  return info
}

// Fills in which repository a touched path is in, the first time it is touched.
async function place($: EngineInterface, path: string) {
  const row = (await read($, files))[path]
  if (!row || row.isResolved) return
  let rel = path
  let info = row.isFolder ? await resolveDir($, path) : undefined
  if (info && info.root) rel = info.prefix.replace(/\/$/, '')
  if (!info) {
    info = await resolveDir($, dirOf(path))
    if (info && info.root) rel = info.prefix + baseName(path)
  }
  if (!info) return
  const root = info.root
  await update($, files, all => {
    const cur = all[path]
    if (!cur) return all
    return {
      ...all,
      [path]: { ...cur, isResolved: true, root, rel: root ? rel : path, git: root ? cur.git : 'no-git' },
    }
  })
}

// Splits `git status --porcelain=v1 -z` into path -> XY. A rename or copy
// carries its old path as the next field, which is skipped.
function parseStatus(out: string): Record<string, string> {
  const map: Record<string, string> = {}
  const fields = out.split('\u0000')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? ''
    if (f.length < 4) continue
    const xy = f.slice(0, 2)
    map[f.slice(3)] = xy
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  return map
}

// Asks git, read-only, what state each written file of one repository is in.
// `--no-optional-locks` keeps status from refreshing the index.
async function checkRepo($: EngineInterface, root: string) {
  const rows = Object.values(await read($, files)).filter(r => r.hasWritten && r.isResolved && r.root === root)
  if (rows.length === 0) return
  const states: Record<string, GitState> = {}
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK)
    const rels = part.map(r => r.rel)
    let status: Record<string, string>
    let tracked: Set<string>
    try {
      const s = await $.process.run(
        ['git', '--literal-pathspecs', '--no-optional-locks', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...rels],
        { timeoutMs: 20_000 },
      )
      const l = await $.process.run(
        ['git', '--literal-pathspecs', '--no-optional-locks', '-C', root, 'ls-files', '-z', '--', ...rels],
        { timeoutMs: 20_000 },
      )
      if (s.exitCode !== 0 || l.exitCode !== 0) continue
      status = parseStatus(s.stdout)
      tracked = new Set(l.stdout.split('\u0000').filter(Boolean))
    } catch {
      continue
    }
    for (const r of part) {
      const xy = status[r.rel]
      states[r.path] = xy === '??' ? 'untracked'
        : xy !== undefined ? 'dirty'
        : tracked.has(r.rel) ? 'clean'
        : 'untracked-ignored'
    }
  }
  if (Object.keys(states).length === 0) return
  await update($, files, all => {
    const next = { ...all }
    for (const [path, git] of Object.entries(states)) {
      const cur = next[path]
      if (cur) next[path] = { ...cur, git }
    }
    return next
  })
}

async function checkAll($: EngineInterface) {
  const roots = new Set(Object.values(await read($, files)).filter(r => r.hasWritten && r.root).map(r => r.root))
  for (const root of roots) await checkRepo($, root)
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  if (!(await read($, isOpen))) {
    ticker?.cancel()
    ticker = undefined
    return
  }
  await checkAll($)
}

function wake($: EngineInterface) {
  if (!ticker) ticker = $.clock.every(EVERY_MS, () => void tick($))
}

// Drops what one conversation touched, and the folder-to-repository answers,
// since a repository may have been made or moved since.
async function forget($: EngineInterface) {
  await update($, files, () => ({}))
  await update($, helpers, () => ({}))
  await update($, dirs, () => ({}))
  await update($, isOtherOpen, () => false)
}

// A /clear or a resume keeps the process, and so this state, but starts another
// conversation under a new id, and no session.start fires for it. session.end
// drops at once; this is the fallback for a switch it did not see. Only the
// main loop's events ask (a helper's hook may read its own id and folder), and
// the decision is made inside one update, so of two racing events one drops.
async function fresh($: EngineInterface, agentId?: string) {
  if (agentId) return
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    return
  }
  let moved = false
  let changed = false
  await update($, sessionId, was => {
    moved = was !== '' && was !== id
    changed = was !== id
    return id
  })
  if (moved) await forget($)
  if (!changed) return
  try {
    const dir = await $.session.cwd()
    await update($, cwd, () => dir)
    const top = await $.session.root()
    await update($, root, () => top)
  } catch {}
}

// macOS reaches /tmp, /var and /etc through /private, so a path may arrive
// either way; compare without it. Letter case is compared as written.
function plainPath(path: string): string {
  return path.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '').replace(/\/+$/, '')
}

// Inside the project folder, or the folder itself; with no folder known, all is.
function isInside(path: string, top: string): boolean {
  const base = plainPath(top)
  if (!base) return true
  const p = plainPath(path)
  return p === base || p.startsWith(`${base}/`)
}

async function openPane($: EngineInterface) {
  await update($, isOpen, () => true)
  wake($)
  return $.ui.open({ id: PANE, title: TITLE })
}

type Node = { name: string; children: Map<string, Node>; file?: FileRow; searched?: FileRow }

function node(name: string): Node {
  return { name, children: new Map() }
}

function insert(top: Node, segs: string[], row: FileRow) {
  let cur = top
  for (const seg of segs) {
    let child = cur.children.get(seg)
    if (!child) {
      child = node(seg)
      cur.children.set(seg, child)
    }
    cur = child
  }
  if (cur === top) {
    top.searched = row
    return
  }
  if (row.isFolder) cur.searched = row
  else cur.file = row
}

function isFolderNode(n: Node): boolean {
  return n.children.size > 0 || (!n.file && !!n.searched)
}

type Counts = Record<Shown, number>

function countsOf(n: Node, into: Counts = { working: 0, changed: 0, committed: 0, read: 0, searched: 0 }): Counts {
  if (n.file) into[shownOf(n.file)] += 1
  for (const c of n.children.values()) countsOf(c, into)
  return into
}

function countLine(c: Counts): string {
  const parts: string[] = []
  if (c.working) parts.push(`${c.working} now`)
  if (c.changed) parts.push(`${c.changed} changed`)
  if (c.committed) parts.push(`${c.committed} committed`)
  if (c.read) parts.push(`${c.read} read`)
  return parts.join(' · ')
}

// The groups of the tree: one per repository root, and one for the files
// outside any repository under their nearest common folder.
function groupsOf(rows: FileRow[]): Array<{ label: string; isGit: boolean; top: Node }> {
  const byRoot = new Map<string, FileRow[]>()
  for (const r of rows) {
    const key = r.root || OUTSIDE
    byRoot.set(key, [...(byRoot.get(key) ?? []), r])
  }
  const out: Array<{ label: string; isGit: boolean; top: Node }> = []
  for (const [key, list] of byRoot) {
    const top = node('')
    if (key === OUTSIDE) {
      const segsOf = (r: FileRow) => r.path.split('/').filter(Boolean)
      let common: string[] | undefined
      for (const r of list) {
        const folder = r.isFolder ? segsOf(r) : segsOf(r).slice(0, -1)
        if (!common) common = folder
        else {
          let i = 0
          while (i < common.length && i < folder.length && common[i] === folder[i]) i++
          common = common.slice(0, i)
        }
      }
      const base = common ?? []
      for (const r of list) insert(top, segsOf(r).slice(base.length), r)
      out.push({ label: `/${base.join('/')}`, isGit: false, top })
    } else {
      for (const r of list) insert(top, r.rel.split('/').filter(Boolean), r)
      out.push({ label: key, isGit: true, top })
    }
  }
  return out.sort((a, b) => (a.isGit === b.isGit ? a.label.localeCompare(b.label) : a.isGit ? -1 : 1))
}

type Line = { key: string; depth: number; text: string; tail: string; shown?: Shown; isFolder: boolean }

// Folders first, then files, each alphabetical; a chain of folders that each
// hold one folder and nothing else is drawn as one line ("a/b/c").
function linesOf(n: Node, depth: number, prefix: string, t: number, out: Line[]) {
  const kids = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const k of kids.filter(isFolderNode)) {
    let label = k.name
    let cur = k
    while (!cur.file && !cur.searched && cur.children.size === 1) {
      const only = [...cur.children.values()][0]!
      if (!isFolderNode(only)) break
      label += `/${only.name}`
      cur = only
    }
    const counts = countLine(countsOf(cur))
    const tags = [cur.searched ? (cur.searched.active > 0 ? 'searching' : 'searched') : '', counts].filter(Boolean).join(' · ')
    const key = `${prefix}/${label}`
    out.push({ key, depth, text: `▾ ${label}/`, tail: tags ? ` · ${tags}` : '', isFolder: true, shown: cur.searched && cur.children.size === 0 ? shownOf(cur.searched) : undefined })
    linesOf(cur, depth + 1, key, t, out)
  }
  for (const k of kids.filter(c => !isFolderNode(c))) {
    const row = k.file
    if (!row) continue
    const shown = shownOf(row)
    const icon = shown === 'working' ? '▶' : shown === 'committed' ? '✓' : shown === 'changed' ? '●' : '·'
    const when = shown === 'working' ? 'now' : ago(t - row.at)
    out.push({
      key: `${prefix}/${k.name}`, depth, text: `${icon} ${k.name}`, shown, isFolder: false,
      tail: ` · ${stateWord(row)} · ${fit(row.by, 24)} · ${when}`,
    })
  }
}

export const register: Register = (on, options) => {
  // The switch in plugin.json's userConfig; anything but an explicit false is on.
  const showPane = options.showPane !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files-panel',
      description: 'Show the Files pane: every file Claude read, edited or wrote this session, and which are committed',
    })
    await update($, cwd, () => e.cwd)
    const result = await next(e)
    await fresh($)
    return result
  })

  on('command.run', { command: 'files-panel' }, async $ => {
    if (!showPane) {
      return { text: 'The files panel is switched off. Turn "Show the files panel" back on in /config.' }
    }
    await update($, hasOpened, () => true)
    await openPane($)
    await checkAll($)
    return { text: 'Files pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isOpen, () => false)
    ticker?.cancel()
    ticker = undefined
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear or a resume ends this conversation while the process goes on: drop
  // its files now, so the pane never shows them in the next one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      try {
        await forget($)
        // '' is "not known yet": the next event adopts the new id without dropping.
        await update($, sessionId, () => '')
      } catch {}
    }
    return next(e)
  })

  // The owner's prompt is the main loop's first event after a /clear, even in a
  // turn that touches no file.
  on('prompt.submit', async ($, e, next) => {
    await fresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    await fresh($, e.parentAgentId)
    const result = await next(e)
    if (result.agentId) {
      const id = result.agentId
      await update($, helpers, h => ({ ...h, [id]: e.description || 'helper' }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Every tool call, main loop and helpers alike. A file call marks its file
  // working until the call ends; a write, or any Bash call, asks git after.
  on('tool.call', async ($, e, next) => {
    if (!showPane) return next(e)
    await fresh($, e.agentId)
    const tool = String(e.tool)
    if (tool === 'Bash') {
      try {
        return await next(e)
      } finally {
        await checkAll($)
      }
    }
    const target = targetOf(tool, e as unknown as Record<string, unknown>)
    if (!target) return next(e)
    const base = await read($, cwd)
    const path = normalize(target.raw || base || '/', base)
    const by = await whoIs($, e.agentId)
    if (by === undefined) return next(e)
    const at = await $.clock.now()
    await update($, files, all => {
      const cur = all[path] ?? blank(path, target, by, at)
      return { ...all, [path]: { ...cur, verb: target.verb, active: cur.active + 1, by, at } }
    })
    if (!(await read($, hasOpened))) {
      await update($, hasOpened, () => true)
      void openPane($)
    }
    let result: ToolCallResult | undefined
    try {
      result = await next(e)
      return result
    } finally {
      const end = await $.clock.now()
      const isOk = result !== undefined && result.deny === undefined && result.isError !== true
      await update($, files, all => {
        const cur = all[path]
        if (!cur) return all
        const hasWritten = cur.hasWritten || (target.isWrite && isOk)
        return { ...all, [path]: { ...cur, active: Math.max(0, cur.active - 1), at: end, hasWritten } }
      })
      await place($, path)
      if (target.isWrite && isOk) {
        const row = (await read($, files))[path]
        if (row?.root) await checkRepo($, row.root)
      }
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!showPane) {
      return <Text dimColor>The files panel is switched off in /config.</Text>
    }
    const all = Object.values(await read($, files))
    // Read at every drawing, so after a /cd the line moves at the next redraw;
    // the stored one if that fails.
    let top = await read($, root)
    try {
      top = (await $.session.root()) || top
    } catch {}
    const rows = all.filter(r => isInside(r.path, top))
    const others = all.filter(r => !isInside(r.path, top))
    const isOthersShown = await read($, isOtherOpen)
    const t = Math.max(await read($, now), await $.clock.now())
    // The pane's padding takes 2 cells.
    const cols = Math.max(20, (e.props?.bodyColumns ?? 40) - 2)
    if (all.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{fit('No files touched in this session yet.', cols)}</Text>
        </Box>
      )
    }
    const fileRows = rows.filter(r => !r.isFolder)
    const count = (s: Shown) => fileRows.filter(r => shownOf(r) === s).length
    const head = [
      `${count('read')} read`, `${count('changed')} changed`, `${count('committed')} committed`,
    ].join(' · ')
    // What Claude is doing now, among the rows shown: a folded file stays folded
    // here too, and the Other places label counts it instead.
    const shown = isOthersShown ? all : rows
    const working = shown.filter(r => r.active > 0).sort((a, b) => b.at - a.at)
    const latest = [...shown].sort((a, b) => b.at - a.at)[0]
    const nowLine = working[0]
      ? withTail(`▶ ${working[0].verb} ${baseName(working[0].path)}`, ` · ${fit(working[0].by, 24)}${working.length > 1 ? ` · +${working.length - 1} more` : ''}`, cols)
      : latest
        ? withTail(`Last: ${baseName(latest.path)}`, ` · ${stateWord(latest)} · ${fit(latest.by, 24)} · ${ago(t - latest.at)}`, cols)
        : ''

    type Group = ReturnType<typeof groupsOf>[number]
    const lines: Array<{ key: string; group?: Group; line?: Line }> = []
    const addGroups = (list: FileRow[], prefix: string) => {
      for (const g of groupsOf(list)) {
        lines.push({ key: `${prefix}g:${g.label}`, group: g })
        const out: Line[] = []
        linesOf(g.top, 1, prefix + g.label, t, out)
        for (const line of out) lines.push({ key: line.key, line })
      }
    }
    addGroups(rows, '')
    // How much is folded, and what of it is changed or busy, so a changed file
    // outside the project is never hidden behind a bare count.
    const otherFiles = others.filter(r => !r.isFolder)
    const otherFolders = others.length - otherFiles.length
    const many = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
    const size = [otherFiles.length ? many(otherFiles.length, 'file') : '', otherFolders ? many(otherFolders, 'folder') : '']
      .filter(Boolean).join(', ')
    const busy = { working: 0, changed: 0, committed: 0, read: 0, searched: 0 }
    for (const r of otherFiles) busy[shownOf(r)] += 1
    const state = [busy.working ? `${busy.working} now` : '', busy.changed ? `${busy.changed} changed` : '']
      .filter(Boolean).join(' · ')
    const otherLabel = `${isOthersShown ? '▾' : '▸'} Other places · ${size}${state ? ` · ${state}` : ''} · outside ${fitPath(top, Math.max(8, cols - 60))}`
    const otherLines = lines.length
    if (isOthersShown) addGroups(others, 'other:')

    const draw = (key: string, group: Group | undefined, line: Line | undefined) => {
      if (group !== undefined) {
        const counts = countLine(countsOf(group.top))
        const searched = group.top.searched ? ' · searched' : ''
        const tail = `${group.isGit ? '' : ' · no git'}${searched}${counts ? ` · ${counts}` : ''}`
        const room = Math.max(Math.min(group.label.length, 8), cols - tail.length)
        const label = fitPath(group.label, room)
        return (
          <Box key={key} marginTop={1}>
            <Text bold wrap="truncate-end">{label}<Text dimColor>{fit(tail, Math.max(0, cols - label.length))}</Text></Text>
          </Box>
        )
      }
      const l = line!
      const indent = '  '.repeat(l.depth)
      const text = withTail(indent + l.text, l.tail, cols)
      const color = l.shown === 'working' ? BLUE : l.shown === 'changed' ? ORANGE : l.shown === 'committed' ? GREEN : undefined
      const isDim = l.isFolder ? l.shown !== 'working' : l.shown === 'read'
      return (
        <Box key={key}>
          <Text wrap="truncate-end" color={color} bold={l.shown === 'working'} dimColor={isDim}>{text}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{fit(`Files · ${head}`, cols)}</Text>
        <Text color={working[0] ? BLUE : undefined} bold={!!working[0]} dimColor={!working[0]}>{nowLine}</Text>
        {rows.length === 0 && <Text dimColor>{fit('No files in this project yet.', cols)}</Text>}
        {lines.slice(0, otherLines).map(({ key, group, line }) => draw(key, group, line))}
        {others.length > 0 && (
          <Box marginTop={1}>
            <Button key="other-toggle" plain label={fit(otherLabel, cols)} onPress={() => update($, isOtherOpen, v => !v)} />
          </Box>
        )}
        {lines.slice(otherLines).map(({ key, group, line }) => draw(key, group, line))}
      </Box>
    )
  })
}
