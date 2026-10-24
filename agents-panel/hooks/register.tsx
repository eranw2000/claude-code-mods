import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Activity, AgentCard, CodexRun, MainRow, PlanStep, ShellRow } from '../types'

const PANE = 'agents-panel'
const agents = atom({ plugin: 'agents-panel', key: 'agents' } as const, {})
const isCollapsed = atom({ plugin: 'agents-panel', key: 'isCollapsed' } as const, true)
const now = atom({ plugin: 'agents-panel', key: 'now' } as const, 0)
// The ids of every helper known when the band was hidden; a new id shows it again.
const hiddenIds = atom({ plugin: 'agents-panel', key: 'hiddenIds' } as const, [] as string[])
const IDLE: Activity = { doing: '', doingAt: 0, active: 0, idleSince: 0, said: '', saidAt: 0, recent: [] }
const main = atom({ plugin: 'agents-panel', key: 'main' } as const, { ...IDLE, lastPrompt: '', lastPromptAt: 0 } as MainRow)
const shells = atom({ plugin: 'agents-panel', key: 'shells' } as const, {} as Record<string, ShellRow>)
const isShellsCollapsed = atom({ plugin: 'agents-panel', key: 'isShellsCollapsed' } as const, true)
const openPrompts = atom({ plugin: 'agents-panel', key: 'openPrompts' } as const, [] as string[])
// The conversation the cards belong to; '' until the first event reads it.
const sessionId = atom({ plugin: 'agents-panel', key: 'sessionId' } as const, '')

// How many actions a card lists, how much of a prompt it shows folded, and
// how many finished shells the pane keeps.
const RECENT = 5
const PROMPT_PREVIEW = 200
const FINISHED_SHELLS = 10

// The band stays this long after the last helper of a batch ends, showing 100%.
const GRACE_MS = 10_000
// Expected duration when no helper of this session has finished yet.
const DEFAULT_MS = 5 * 60_000
// A running helper never counts as more than this share done.
const CAP = 0.95
const BAND_ORANGE = '#d9734e'
const PILL_PURPLE = '#7c5cd6'
const TRACK_DARK = '#3a3a40'

// Dollars per million tokens: input, output, cache read, cache write.
// From the Claude API reference.
// Cache writes are priced at 2x input, the 1-hour cache Claude Code asks for.
// An unknown model is priced as Opus 5.5, so the figure is always marked approximate.
const OPUS_5_5: [number, number, number, number] = [4, 20, 0.2, 8]
const PRICES: Array<[string, [number, number, number, number]]> = [
  ['fable', [10, 50, 0.25, 20]],
  ['mythos', [10, 50, 0.25, 20]],
  ['opus-5-5', OPUS_5_5],
  ['opus', [5, 25, 0.5, 10]],
  ['sonnet-5', [2, 10, 0.2, 4]],
  ['sonnet', [3, 15, 0.3, 6]],
  ['haiku-5-5', [0.1, 0.5, 0.01, 0.2]],
  ['haiku', [1, 5, 0.1, 2]],
]

const COLORS = ['#d9734e', '#4caf7d', '#4a90e2', '#d4a03a', '#b06ad9', '#3fb8c4']

function priceOf(model: string): [number, number, number, number] {
  for (const [key, price] of PRICES) {
    if (model.includes(key)) return price
  }
  return OPUS_5_5
}

function colorOf(text: string): string {
  let hash = 0
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length] ?? '#888888'
}

function modelName(model: string): string {
  const m = model.match(/(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/)
  const [, name = '', major = '', minor] = m ?? []
  if (!name) return model || 'model ?'
  const family = name.charAt(0).toUpperCase() + name.slice(1)
  return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
}

function statusOf(status: AgentStatus): AgentCard['status'] {
  if (status === 'completed' || status === 'idle') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  return 'running'
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function money(usd: number): string {
  return usd < 10 ? `≈$${usd.toFixed(2)}` : `≈$${Math.round(usd)}`
}

function blank(id: string, at: number): AgentCard {
  return {
    ...IDLE,
    id, description: 'helper', type: 'agent', model: '', effort: '', status: 'running',
    startedAt: at, endedAt: 0, steps: 0, tools: 0, lastTool: '', tokens: 0, outTokens: 0,
    context: 0, cost: 0, prompt: '', plan: [],
  }
}

// A cut that keeps a line on one row: the text, or its head and an ellipsis.
function fit(text: string, cols: number): string {
  return text.length <= cols ? text : `${text.slice(0, Math.max(1, cols - 1))}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
}

// A span as the status line writes it: 40s, 5m14s, 2h3m.
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// What a tool call is doing, in a few words. A shell call is named by its own
// description and never by its command, which can hold a secret.
function labelOf(e: ToolCallInput): string {
  const a = e as unknown as Record<string, unknown>
  const tool: string = e.tool
  const named = (what: string) => fit(what ? `${tool}: ${oneLine(what)}` : tool, 200)
  switch (tool) {
    case 'Bash': return named(str(a.description) || 'shell command')
    case 'Monitor': return named(str(a.description) || 'watch')
    case 'Read': case 'Edit': case 'Write': return named(baseName(str(a.file_path)))
    case 'NotebookEdit': return named(baseName(str(a.notebook_path)))
    case 'Grep': case 'Glob': return named(str(a.pattern))
    case 'WebFetch': return named(hostOf(str(a.url)))
    case 'WebSearch': return named(str(a.query))
    case 'Agent': return named(str(a.description))
    case 'Skill': return named(str(a.skill))
    default: return tool
  }
}

function startCall<A extends Activity>(a: A, label: string, at: number): A {
  return {
    ...a, doing: label, doingAt: at, active: a.active + 1, idleSince: 0,
    recent: [{ label, at }, ...a.recent].slice(0, RECENT),
  }
}

function endCall<A extends Activity>(a: A, at: number): A {
  const active = Math.max(0, a.active - 1)
  return { ...a, active, idleSince: active === 0 ? at : a.idleSince }
}

function say<A extends Activity>(a: A, answer: string, at: number): A {
  const line = firstLine(answer)
  return line ? { ...a, said: fit(line, 300), saidAt: at } : a
}

// The most specific thing known: the call in flight; else the last call, then
// the last words, each with how long ago.
// Returned as [what, how long ago], so a cut to the width keeps the age.
function doingNow(a: Activity, t: number): [string, string] {
  if (a.doing && a.active > 0) return [a.doing, '']
  if (a.doing) return [a.doing, ` · ${span(t - (a.idleSince || a.doingAt))} ago`]
  if (a.said) return [a.said, ` · ${span(t - a.saidAt)} ago`]
  return ['', '']
}

// A line cut to `cols` from its head, so its tail (an age, a state) stays whole.
function withTail(head: string, tail: string, cols: number): string {
  return fit(head, Math.max(4, cols - tail.length)) + tail
}

// A helper's own task list, from its TodoWrite, TaskCreate and TaskUpdate calls.
function planAfter(plan: PlanStep[], e: ToolCallInput, result: ToolCallResult | undefined): PlanStep[] {
  const a = e as unknown as Record<string, unknown>
  const status = (s: unknown): PlanStep['status'] =>
    s === 'completed' || s === 'in_progress' ? s : 'pending'
  if (e.tool === 'TodoWrite' && Array.isArray(a.todos)) {
    return a.todos.map((raw, i) => {
      const t = (raw ?? {}) as Record<string, unknown>
      return { id: String(i), title: oneLine(str(t.content)), active: oneLine(str(t.activeForm)), status: status(t.status) }
    })
  }
  const r = (result && !result.deny && !result.isError ? result.result : undefined) as Record<string, unknown> | undefined
  if (e.tool === 'TaskCreate') {
    const task = (r?.task ?? {}) as Record<string, unknown>
    const id = str(task.id) || `new-${plan.length}`
    return [...plan, { id, title: oneLine(str(a.subject)), active: oneLine(str(a.activeForm)), status: 'pending' }]
  }
  if (e.tool === 'TaskUpdate') {
    const id = str(a.taskId)
    if (a.status === 'deleted') return plan.filter(s => s.id !== id)
    return plan.map(s => s.id !== id ? s : {
      ...s,
      title: a.subject === undefined ? s.title : oneLine(str(a.subject)),
      active: a.activeForm === undefined ? s.active : oneLine(str(a.activeForm)),
      status: a.status === undefined ? s.status : status(a.status),
    })
  }
  return plan
}

const PLAN_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate']

// A background task's notification, read from its tags. The summary is never
// kept: only the ids, the status word and an exit code.
type Note = { taskId: string; toolUseId: string; status: ShellRow['status']; exitCode: number }

function parseNote(body: string): Note | undefined {
  if (!body.includes('<task-notification')) return undefined
  const tag = (name: string) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() ?? ''
  const word = tag('status')
  const code = tag('summary').match(/exit code (-?\d+)/i)?.[1]
  const exitCode = code === undefined ? -1 : Number(code)
  const status: ShellRow['status'] = word === 'killed' ? 'stopped'
    : word === 'failed' || exitCode > 0 ? 'failed'
      : 'ok'
  return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status, exitCode }
}

// Running shells, then the newest finished ones, at most FINISHED_SHELLS.
function pruned(all: Record<string, ShellRow>): Record<string, ShellRow> {
  const rows = Object.values(all)
  const done = rows.filter(r => r.status !== 'running').sort((a, b) => b.endedAt - a.endedAt)
  const keep = new Set([...rows.filter(r => r.status === 'running'), ...done.slice(0, FINISHED_SHELLS)].map(r => r.id))
  return Object.fromEntries(rows.filter(r => keep.has(r.id)).map(r => [r.id, r]))
}

// How far along a helper is: its own task list when it keeps one (measured),
// else the band's estimate from finished helpers' run times (marked ≈).
function progressOf(c: AgentCard, all: AgentCard[], t: number): { share: number; label: string } {
  const took = clock((c.endedAt || t) - c.startedAt)
  if (c.status === 'done') return { share: 1, label: `100% · took ${took}` }
  if (c.status !== 'running') return { share: 0, label: `${c.status} after ${took}` }
  if (c.plan.length > 0) {
    const done = c.plan.filter(s => s.status === 'completed').length
    const now = c.plan.find(s => s.status === 'in_progress')
    const name = now ? (now.active || now.title) : ''
    return { share: done / c.plan.length, label: `Steps ${done}/${c.plan.length}${name ? ` · ${name}` : ''}` }
  }
  const s = shareOf(c, all, t)
  const pct = Math.round(100 * s.share)
  const run = c.codex
  if (run) {
    // Past its usual time a Codex run still has its limit, which is real.
    if (s.isLong) {
      const toLimit = deadlineOf(c) - t
      return { share: s.share, label: `≈${pct}% · running long · ${toLimit > 0 ? `limit in ${left(toLimit)}` : 'past its limit'}` }
    }
    const isUsual = run.expectedMs > 0 && run.expectedMs <= deadlineOf(c) - c.startedAt
    return { share: s.share, label: `≈${pct}% · ≈${left(s.leftMs)} left (${isUsual ? `usual ${span(run.expectedMs)}` : 'to its limit'})` }
  }
  return { share: s.share, label: `≈${pct}% · ${s.isLong ? 'running long' : `≈${left(s.leftMs)} left`} (estimate)` }
}

// ---- The crab avatars ----------------------------------------------------
// One shared crab body, 12 x 12 pixels, with a hat (and a prop in a claw)
// drawn over it per helper type. Letters are palette entries, '.' is empty.
const CRAB_COLS = 12
const CRAB_ROWS = 6 // two pixels to a cell on the terminal
const CRAB_BODY = [
  '............',
  '............',
  '............',
  '............',
  '............',
  '..BBBBBBBB..',
  '.BBEBBBBEBB.',
  'BBBBBBBBBBBB',
  'B.BBBBBBBB.B',
  '..BBBBBBBB..',
  '..B.B..B.B..',
  '..B.B..B.B..',
]

// Each hat lists only its own rows from the top; '.' leaves the crab showing.
const HATS: Record<string, string[]> = {
  builder: [ // a hard hat, and a wrench by the right claw
    '............',
    '....HHHH....',
    '...HHHHHH...',
    '..HHHHHHHHGG',
    '.AAAAAAAAA.G',
    '...........G',
  ],
  explorer: [ // a cap with a white stripe, and a checkered flag on a pole
    'KWKW........',
    'WKWK........',
    'G...HHHH....',
    'G..HWWWHH...',
    'G..AAAAAAAA.',
    'G...........',
    'G...........',
  ],
  planner: [ // a white captain's hat, its band in the type colour, a dark visor
    '............',
    '...WWWWWW...',
    '..WWWWWWWW..',
    '..HHHHHHHH..',
    '...KKKKKK...',
  ],
  inspector: [ // a mining helmet with a lamp, and a magnifying glass over the right eye
    '............',
    '....HHHH....',
    '...HHYYHH...',
    '..HHHYYHHH..',
    '.AAAAAAAAAA.',
    '.......GGG..',
    '......GL..G.',
    '......G...G.',
    '......G...G.',
    '.......GGG..',
    '..........N.',
    '...........N',
  ],
  reviewer: [ // a graduation cap with a gold tassel, its band in the type colour, and the magnifying glass
    '....DDDD....',
    '.DDDDDDDDDD.',
    'DDDDDDDDDDDD',
    '.Y.DDDDDD...',
    '.Y.HHHHHH...',
    '.Y.....GGG..',
    'YY....GL..G.',
    '......G...G.',
    '......G...G.',
    '.......GGG..',
    '..........N.',
    '...........N',
  ],
  helper: [ // a puffy white nurse's cap, its band in the type colour
    '...WW..WW...',
    '..WWWWWWWW..',
    '.WWWWWWWWWW.',
    '.WWWWWWWWWW.',
    '..HHHHHHHH..',
  ],
  developer: [ // headphones (band and cups in the type colour), and an open laptop held up in front, screen lit
    '............',
    '...HHHHHH...',
    '..H......H..',
    '.H........H.',
    'HH........HH',
    'HH........HH',
    '............',
    '...GGGGGG...',
    '...GLLLLG...',
    '...GLLLLG...',
    '..WWWWWWWW..',
  ],
  designer: [ // a beret tilted to one side, and a paintbrush in the right claw
    '......A.....',
    '...HHHHHH...',
    '..HHHHHHHHH.',
    '.HHHHHHHHHHH',
    '...AAAAAA..P',
    '...........N',
    '...........N',
  ],
  codex: [ // a cap, and reading glasses around the eyes
    '............',
    '....HHHH....',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '.AAAAAAAAAA.',
    '..KKK..KKK..',
    '..K.KKKK.K..',
    '..KKK..KKK..',
  ],
  bare: [],
}

// The fixed colours; H is the type's own colour and A a darker shade of it.
const PALETTE: Record<string, string> = {
  B: '#d97757', E: '#1a1a1a', K: '#1a1a1a', W: '#f4f4f4', G: '#9aa0a6', D: '#4a4f55',
  Y: '#ffd84d', L: '#9ecbff', N: '#8d6e63', P: '#29b6f6',
}

const BLUE = '#2f6fd6'
const BERRY = '#c2185b'

type Hat = { role: string; color: string }
type HatRule = { match: (type: string, description: string) => boolean } & Hat

const isType = (...names: string[]) => (type: string) => names.includes(type)
const startsWith = (re: RegExp) => (type: string, description: string) =>
  type === 'general-purpose' && re.test(description.trim())

// The one table: which crab a helper gets and its colour, first match wins.
// A new type is one line; an unknown type gets the bare crab in a hashed colour.
const HAT_RULES: HatRule[] = [
  { match: type => /developer/i.test(type), role: 'developer', color: BLUE },
  { match: type => /designer/i.test(type), role: 'designer', color: BERRY },
  { match: startsWith(/^(build|implement|develop|code|fix)\b/i), role: 'developer', color: BLUE },
  { match: startsWith(/^(design|draw|style)\b/i), role: 'designer', color: BERRY },
  { match: isType('general-purpose', 'claude', 'fork'), role: 'builder', color: '#d4a03a' },
  { match: isType('Explore'), role: 'explorer', color: '#4caf7d' },
  { match: isType('Plan', 'plan-auditor'), role: 'planner', color: '#4a90e2' },
  { match: isType('code-reviewer'), role: 'reviewer', color: '#a0522d' },
  { match: isType('ai-signal-reviewer'), role: 'reviewer', color: '#8d6e63' },
  { match: type => /reviewer/i.test(type), role: 'reviewer', color: '#a0522d' },
  { match: isType('deploy-guard', 'pr-validator'), role: 'inspector', color: '#a0522d' },
  { match: isType('claude-code-guide'), role: 'helper', color: '#3fb8c4' },
  { match: isType('statusline-setup', 'hookify:conversation-analyzer'), role: 'helper', color: '#5c9e6e' },
  { match: isType('codex'), role: 'codex', color: '#2e9d8f' },
]

function hatOf(type: string, description: string): Hat {
  const rule = HAT_RULES.find(r => r.match(type, description))
  return rule ? { role: rule.role, color: rule.color } : { role: 'bare', color: colorOf(type) }
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (s: number) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

// The crab's pixels, row by row: a colour, or '' where nothing is drawn.
function spriteOf(hat: Hat): string[][] {
  const over = HATS[hat.role] ?? []
  const colors: Record<string, string> = { ...PALETTE, H: hat.color, A: shade(hat.color, 0.65) }
  return CRAB_BODY.map((row, y) => [...row].map((base, x) => {
    const top = over[y]?.[x] ?? '.'
    const letter = top !== '.' ? top : base
    return letter === '.' ? '' : colors[letter] ?? ''
  }))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

// The terminal's drawing: one upper-half block per cell, its colour the upper
// pixel and its background the lower one; the terminal's own colour where empty.
function rasterCells(px: string[][]): string {
  const DEFAULT = 0x01000000
  const color = (c: string | undefined) => c ? parseInt(c.slice(1), 16) : DEFAULT
  const words: number[] = []
  for (let y = 0; y < CRAB_ROWS; y++) {
    for (let x = 0; x < CRAB_COLS; x++) {
      const top = px[2 * y]?.[x]
      const bottom = px[2 * y + 1]?.[x]
      words.push(top || bottom ? 0x2580 : 0x20, color(top), color(bottom))
    }
  }
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((w, i) => view.setUint32(i * 4, w, true))
  return base64(bytes)
}

// The other surfaces' drawing: one square per pixel.
function svgOf(px: string[][]): string {
  const rects = px.flatMap((row, y) => row.map((c, x) =>
    c ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>` : ''))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CRAB_COLS} ${CRAB_COLS}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

// The band's numbers are estimates, so every one of them is drawn with "≈".
type Estimate = {
  done: number
  total: number
  running: number
  percent: number
  leftMs: number
  isLong: boolean
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

// Expected run time of a helper: the median of finished helpers of its type,
// else of every finished helper this session, else five minutes.
function expectedMs(card: AgentCard, all: AgentCard[]): number {
  // A Codex run is expected to take as long as past runs like it took, else
  // its own limit, and never past the moment its limit ends it.
  if (card.codex) return Math.min(card.codex.expectedMs || Infinity, deadlineOf(card) - card.startedAt)
  const finished = all.filter(c => c.status === 'done' && c.endedAt > 0)
  const took = (cs: AgentCard[]) => cs.map(c => c.endedAt - c.startedAt)
  return median(took(finished.filter(c => c.type === card.type)))
    ?? median(took(finished))
    ?? DEFAULT_MS
}

// The helpers of the current batch: from the first one that started after
// every earlier helper had ended (plus the grace), up to now.
function batchOf(all: AgentCard[]): AgentCard[] {
  const sorted = [...all].sort((a, b) => a.startedAt - b.startedAt)
  let start = 0
  let busyUntil = -Infinity
  sorted.forEach((c, i) => {
    if (c.startedAt > busyUntil + GRACE_MS) start = i
    const end = c.status === 'running' ? Infinity : (c.endedAt || c.startedAt)
    busyUntil = Math.max(busyUntil, end)
  })
  return sorted.slice(start)
}

// One running helper's estimated share done (capped), time left and whether it
// is past its expected time. The band and the cards both read this.
function shareOf(c: AgentCard, all: AgentCard[], t: number): { share: number; leftMs: number; isLong: boolean } {
  const expected = expectedMs(c, all)
  const elapsed = Math.max(0, t - c.startedAt)
  return { share: Math.min(CAP, elapsed / expected), leftMs: Math.max(0, expected - elapsed), isLong: elapsed > expected }
}

function estimate(batch: AgentCard[], all: AgentCard[], t: number): Estimate {
  const running = batch.filter(c => c.status === 'running')
  const done = batch.length - running.length
  let progress = 0
  let leftMs = 0
  let isLong = false
  for (const c of running) {
    const s = shareOf(c, all, t)
    progress += s.share
    if (s.isLong) isLong = true
    leftMs = Math.max(leftMs, s.leftMs)
  }
  const total = batch.length
  const percent = total ? Math.round((100 * (done + progress)) / total) : 0
  return { done, total, running: running.length, percent, leftMs: Math.max(0, leftMs), isLong }
}

// Whether the band shows: a helper runs, or the last one ended within the grace.
function isBandShown(batch: AgentCard[], t: number): boolean {
  if (batch.length === 0) return false
  if (batch.some(c => c.status === 'running')) return true
  return t - Math.max(...batch.map(c => c.endedAt || c.startedAt)) <= GRACE_MS
}

function left(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// The progress bar's words, the same in the band above the prompt and in the pane.
function barOf(batch: AgentCard[], all: AgentCard[], t: number) {
  const est = estimate(batch, all, t)
  const isRunning = est.running > 0
  return {
    est,
    isRunning,
    title: '● Helpers',
    pct: `≈${est.percent}%`,
    eta: !isRunning ? 'done' : est.isLong ? 'running long' : `≈${left(est.leftMs)} left`,
    count: `×${est.running}`,
    label: ` Tasks ${est.done}/${est.total} `,
  }
}

// How much of a bar `track` cells long is filled; never less than its label.
function filledOf(track: number, percent: number, label: string): number {
  return Math.min(track, Math.max(label.length, Math.round((track * percent) / 100)))
}

async function hideBand($: EngineInterface) {
  const ids = Object.keys(await read($, agents))
  await update($, hiddenIds, () => ids)
}

let window = 1_000_000
let ticker: { cancel: () => void } | undefined

// Only agent.spawn and the list read at session.start make a card. A helper of
// an earlier conversation can still be mid-call after a /clear, and its events
// must not bring its card back.
async function edit($: EngineInterface, id: string, fn: (card: AgentCard) => AgentCard) {
  await update($, agents, all => {
    const card = all[id]
    return card ? { ...all, [id]: fn(card) } : all
  })
}

async function isKnown($: EngineInterface, agentId: string | undefined): Promise<boolean> {
  return !agentId || !!(await read($, agents))[agentId]
}

// A tool call starts on its loop: a helper's card, or the main row.
async function beginCall($: EngineInterface, e: ToolCallInput, at: number) {
  const label = labelOf(e)
  if (e.agentId) {
    await edit($, e.agentId, c => ({ ...startCall(c, label, at), tools: c.tools + 1, lastTool: e.tool }))
  } else {
    await update($, main, m => startCall(m, label, at))
  }
}

// A tool call ends; a helper's task-list call also updates its plan.
async function endCallOn($: EngineInterface, e: ToolCallInput, result: ToolCallResult | undefined, at: number) {
  if (e.agentId) {
    const isPlan = PLAN_TOOLS.includes(e.tool)
    await edit($, e.agentId, c => ({ ...endCall(c, at), plan: isPlan ? planAfter(c.plan, e, result) : c.plan }))
  } else {
    await update($, main, m => endCall(m, at))
  }
}

function newShell(id: string, e: ToolCallInput, at: number): ShellRow {
  const a = e as unknown as Record<string, unknown>
  const isMonitor = e.tool === 'Monitor'
  return {
    id, taskId: '',
    description: fit(oneLine(str(a.description)), 200) || (isMonitor ? 'watch' : 'shell command'),
    owner: e.agentId ?? 'main',
    kind: isMonitor ? 'monitor' : 'bash',
    isBackground: isMonitor || a.run_in_background === true,
    status: 'running', exitCode: -1, startedAt: at, endedAt: 0, endsWithOwner: false,
  }
}

// What a shell call's result says: started in the background (it keeps
// running until its notification), or finished, with its exit code when the
// error text leads with one.
function settled(row: ShellRow, result: ToolCallResult | undefined, at: number): ShellRow {
  if (!result || result.deny !== undefined) return { ...row, status: 'stopped', endedAt: at }
  const r = typeof result.result === 'object' && result.result ? result.result as Record<string, unknown> : {}
  const taskId = str(r.backgroundTaskId) || str(r.taskId)
  if (!result.isError && taskId) {
    return { ...row, taskId, isBackground: true, endsWithOwner: r.backgroundEndsWithFinalResponse === true }
  }
  const code = str(result.text).match(/^Exit code (-?\d+)/)?.[1]
  const exitCode = code === undefined ? (result.isError ? -1 : 0) : Number(code)
  const status = r.interrupted === true ? 'stopped' : result.isError ? 'failed' : 'ok'
  return { ...row, status, exitCode, endedAt: at }
}

// A shell that keeps running opens the pane the way a helper does, so a Codex
// review alone still shows: a background command, a monitor, or a Codex run
// (python running the codex_delegate.py runner, or a raw `codex exec` in
// command position). A quick foreground command does not, or the pane would
// open on every ls; neither does the runner's `verify`, a grep for the file
// or its test file.
const CODEX_RUN = /\bpython[\d.]*\s+(?:-\S+\s+)*(?:\S*\/)?codex_delegate\.py(?!\s+verify\b)|(?:^|[;&|(]|\b(?:then|do|nohup|time)\s)\s*codex\s+exec\b/m

function opensPane(e: ToolCallInput): boolean {
  const a = e as unknown as Record<string, unknown>
  return e.tool === 'Monitor' || a.run_in_background === true || CODEX_RUN.test(str(a.command))
}

async function startShell($: EngineInterface, id: string, e: ToolCallInput, at: number) {
  await update($, shells, all => pruned({ ...all, [id]: newShell(id, e, at) }))
}

async function settleShell($: EngineInterface, id: string, result: ToolCallResult | undefined, at: number) {
  await update($, shells, all => {
    const row = all[id]
    return row ? pruned({ ...all, [id]: settled(row, result, at) }) : all
  })
}

// A background task's notification ends the shell it names, by task id or call id.
async function noteShells($: EngineInterface, body: string, at: number) {
  const note = parseNote(body)
  if (!note) return
  await update($, shells, all => pruned(Object.fromEntries(Object.values(all).map(row => {
    const isIt = row.status === 'running'
      && ((note.taskId !== '' && row.taskId === note.taskId) || (note.toolUseId !== '' && row.id === note.toolUseId))
    return [row.id, isIt ? { ...row, status: note.status, exitCode: note.exitCode, endedAt: at } : row]
  }))))
}

// A helper's final answer ends the background commands that die with it.
async function endOwnedShells($: EngineInterface, owner: string, at: number) {
  await update($, shells, all => pruned(Object.fromEntries(Object.values(all).map(row => [
    row.id,
    row.owner === owner && row.status === 'running' && row.endsWithOwner ? { ...row, status: 'stopped', endedAt: at } : row,
  ]))))
}

// ---- Codex runs ------------------------------------------------------------
// A Bash call that runs codex_delegate.py is a Codex run, and gets a card of its
// own instead of a shell row. The command is read for its flags only; its text
// never reaches the pane. Everything else comes from the files the run writes:
// <dir of --out>/.codex-runs/<run id>/receipt.json and child-process.json, and
// the Codex session log the child keeps open.

// codex_delegate.py's own limit when the call names none.
const CODEX_DEFAULT_LIMIT_MS = 1800 * 1000
// How often a running card's files are read again.
const CODEX_READ_MS = 10_000
// How much of the end of the session log is read for the latest token count.
const CODEX_LOG_TAIL = 262_144
// A run whose receipt says it ended gets this long for its end notice, then
// ends from the receipt: a helper's run can end with nobody told.
const CODEX_RECEIPT_GRACE_MS = 30_000
// The runner stops Codex at its limit; a run not heard from by its limit plus
// this has failed, and the card says so.
const CODEX_OVER_LIMIT_MS = 60_000
// Past its limit, a read of its files this long under way is not waited for.
const CODEX_STUCK_READ_MS = 60_000
// The profiles the runner runs once more on another model, after one of these
// exits, in a run folder of its own. Both are empty when the runner has no
// fallback.
const CODEX_FALLBACK_PROFILES: string[] = []
const CODEX_FALLBACK_EXITS: number[] = []
// Past runs: finished receipts of the last 30 days, read again hourly. A usual
// time needs at least three of them.
const HISTORY_DAYS = 30
const HISTORY_TTL_MS = 60 * 60_000
const HISTORY_MIN = 3
const HISTORY_MAX = 600
// A run folder is named <UTC stamp>-<label>-<6 hex>.
const RUN_DIR_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(.+)-[0-9a-f]{6}$/
// The runner's exit codes, in words (codex-delegation.md, "Exit codes", and the
// EXIT_ constants in codex_delegate.py). Exit 0 is said by the job type.
const CODEX_EXITS: Record<number, [AgentCard['status'], string]> = {
  2: ['failed', 'no codex command on this machine'],
  3: ['failed', 'no Codex login'],
  4: ['failed', 'timed out'],
  5: ['failed', 'Codex itself failed'],
  6: ['failed', 'empty answer'],
  7: ['failed', 'unsafe output path'],
  8: ['failed', 'another run holds this output file'],
  9: ['failed', 'the answer names other commits'],
  10: ['failed', 'malformed answer'],
  11: ['failed', 'the answer says it is incomplete'],
  12: ['failed', 'the model provider refused it'],
  13: ['failed', 'refused before it started'],
  14: ['failed', 'the confined run was refused'],
  15: ['stopped', 'Codex review is off (CODEX_REVIEW=off)'],
  130: ['stopped', 'interrupted'],
  143: ['stopped', 'interrupted'],
}

type CodexCall = {
  label: string; out: string; cwd: string; repo: string; base: string; head: string
  requestId: string; jobType: string; model: string; limitMs: number; hasFallback: boolean
  vars: Record<string, string>
}

// A token of a shell command: a word, an operator that ends a simple command
// (; & | && || ( ) and a newline), a redirection whose target is the next word,
// or a redirection that is whole by itself (2>&1).
type Token = { kind: 'word' | 'op' | 'redir' | 'fd'; text: string }

// A shell command's tokens, split as the shell would: quotes, $( ... ) and
// ` ... ` stay inside their word, a backslash-newline joins, and a comment and
// a heredoc's body are dropped, so an apostrophe in either opens no quote.
function shellTokens(command: string): Token[] {
  const out: Token[] = []
  const n = command.length
  let cur = ''
  let has = false
  let i = 0
  // Heredocs whose bodies start at the next newline; and one whose delimiter is the next word.
  const bodies: Array<{ end: string; strip: boolean }> = []
  let delimiter: { strip: boolean } | undefined
  const push = () => {
    if (has && delimiter) {
      bodies.push({ end: cur, strip: delimiter.strip })
      delimiter = undefined
    } else if (has) {
      out.push({ kind: 'word', text: cur })
    }
    cur = ''
    has = false
  }
  // From a `$(` or a backtick at `from`, the index just past its close.
  const closeOf = (from: number): number => {
    if (command[from] === '`') {
      let j = from + 1
      while (j < n && command[j] !== '`') j += command[j] === '\\' ? 2 : 1
      return Math.min(n, j + 1)
    }
    let depth = 0
    let quote = ''
    for (let j = from + 1; j < n; j++) {
      const c = command[j]!
      if (quote) {
        if (c === quote) quote = ''
        else if (c === '\\' && quote === '"') j++
      } else if (c === "'" || c === '"') quote = c
      else if (c === '\\') j++
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) return j + 1
    }
    return n
  }
  const opensSub = (j: number) => (command[j] === '$' && command[j + 1] === '(') || command[j] === '`'
  while (i < n) {
    const ch = command[i]!
    if (ch === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close < 0 ? n : close
      cur += command.slice(i + 1, end)
      has = true
      i = end + 1
    } else if (ch === '"') {
      has = true
      let j = i + 1
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < n) {
          cur += command[j + 1]
          j += 2
        } else if (opensSub(j)) {
          const k = closeOf(j)
          cur += command.slice(j, k)
          j = k
        } else {
          cur += command[j]
          j++
        }
      }
      i = j + 1
    } else if (opensSub(i)) {
      const k = closeOf(i)
      cur += command.slice(i, k)
      has = true
      i = k
    } else if (ch === '\\') {
      if (i + 1 < n && command[i + 1] !== '\n') {
        cur += command[i + 1]
        has = true
      }
      i += 2
    } else if (ch === '#' && !has) {
      while (i < n && command[i] !== '\n') i++
    } else if (ch === '\n') {
      push()
      out.push({ kind: 'op', text: ';' })
      i++
      // Each heredoc opened on that line has its body here, up to its delimiter line.
      for (const body of bodies) {
        while (i < n) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol < 0 ? n : eol)
          i = eol < 0 ? n : eol + 1
          if ((body.strip ? line.replace(/^\t+/, '') : line) === body.end) break
        }
      }
      bodies.length = 0
    } else if (ch === '<' || ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      // A number right before it is the file descriptor, not a word.
      if (ch !== '&' && has && /^\d+$/.test(cur)) {
        cur = ''
        has = false
      } else {
        push()
      }
      if (command.startsWith('<<<', i)) {
        out.push({ kind: 'redir', text: '<<<' })
        i += 3
      } else if (command.startsWith('<<', i)) {
        const strip = command[i + 2] === '-'
        delimiter = { strip }
        i += strip ? 3 : 2
      } else {
        const op = command.slice(i).match(/^(&>>|&>|>>|>&|<&|>\||<>|>|<)/)?.[1] ?? ch
        i += op.length
        const fd = op.endsWith('&') ? command.slice(i).match(/^(\d+|-)/)?.[1] : undefined
        if (fd !== undefined) {
          i += fd.length
          out.push({ kind: 'fd', text: op + fd })
        } else {
          out.push({ kind: 'redir', text: op })
        }
      }
    } else if (/\s/.test(ch)) {
      push()
      i++
    } else if (';&|()'.includes(ch)) {
      push()
      const two = command.slice(i, i + 2)
      const op = ['&&', '||', ';;', '|&'].includes(two) ? two : ch
      out.push({ kind: 'op', text: op })
      i += op.length
    } else {
      cur += ch
      has = true
      i++
    }
  }
  push()
  return out
}

// A command's simple commands, each as its words, redirections left out.
function statementsOf(command: string): string[][] {
  const all: string[][] = [[]]
  let isTarget = false
  for (const tok of shellTokens(command)) {
    if (tok.kind === 'op') all.push([])
    else if (tok.kind === 'redir') isTarget = true
    else if (tok.kind === 'word' && isTarget) isTarget = false
    else if (tok.kind === 'word') all[all.length - 1]!.push(tok.text)
  }
  return all.filter(s => s.length > 0)
}

const ASSIGN_RE = /^([A-Za-z_]\w*)=([\s\S]*)$/
const PYTHON_RE = /^python(\d+(\.\d+)*)?$/
const RUNNER_RE = /(^|\/)codex_delegate\.py$/
// Words a simple command may start with before its program.
const LEADERS = new Set([
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!', 'time', 'nohup', 'exec',
  'command', 'builtin', 'export', 'local', 'readonly', 'declare',
])
// Python's own flags that may come before the script; -X and -W take a value.
const PY_FLAGS = new Set(['-u', '-I', '-B', '-E', '-s', '-S', '-O', '-OO', '-q', '-b', '-bb', '-v', '-d', '-P', '-X', '-W'])

// A value with the command's own variables filled in; an unknown one stays as written.
function expandVars(raw: string, vars: Record<string, string>): string {
  let v = raw
  for (let pass = 0; pass < 3 && v.includes('$'); pass++) {
    v = v.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => vars[a ?? b] ?? all)
  }
  return v
}

// The runner's own spelling of a label in a run folder's name (safe_label).
function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'delegation'
}

// The flags of the first codex_delegate.py run in a command, or undefined when
// it runs none. A run is the runner in command position, alone or after a
// Python interpreter: a command that only names the file (cat, grep, git add,
// a heredoc's text) is not one, and neither are its verify, --check and --help
// forms. The command's own assignments and cd's are kept, to read its paths.
function codexCallOf(command: string): CodexCall | undefined {
  const vars: Record<string, string> = {}
  let cwd = ''
  for (const words of statementsOf(command)) {
    let i = 0
    let isEnv = false
    while (i < words.length) {
      const w = words[i]!
      const m = w.match(ASSIGN_RE)
      if (m) vars[m[1]!] = m[2]!
      else if (w === 'env') isEnv = true
      else if (!LEADERS.has(w) && !(isEnv && w.startsWith('-'))) break
      i++
    }
    const prog = words[i]
    if (prog === undefined) continue
    if (prog === 'cd' || prog === 'pushd') {
      const to = words[i + 1] ?? '~'
      if (to !== '-') cwd = !cwd || /^[/~$]/.test(to) ? to : `${cwd}/${to}`
      continue
    }
    let at = i
    if (PYTHON_RE.test(baseName(prog))) {
      at++
      while (at < words.length && PY_FLAGS.has(words[at]!)) at += words[at] === '-X' || words[at] === '-W' ? 2 : 1
    }
    if (!RUNNER_RE.test(words[at] ?? '')) continue
    const args = words.slice(at + 1)
    if (args[0] === 'verify' || args.some(a => a === '--check' || a === '--help' || a === '-h')) continue
    const flag = (name: string): string => {
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!
        if (a === name) return args[k + 1] ?? ''
        if (a.startsWith(`${name}=`)) return a.slice(name.length + 1)
      }
      return ''
    }
    // A value the command builds from something unknown ($(uuidgen), an unset variable) is ''.
    const known = (raw: string) => {
      const v = expandVars(raw, vars)
      return /[$`]/.test(v) ? '' : v
    }
    const label = flag('--label')
    const seconds = Number(known(flag('--timeout')))
    // A profile the command builds from something unknown may have a fallback
    // when the runner has any: it keeps the longer time, since failing a live
    // run is the worse mistake.
    const profile = flag('--profile')
    const hasFallback = profile !== '' && CODEX_FALLBACK_PROFILES.length > 0
      && (known(profile) === '' || CODEX_FALLBACK_PROFILES.includes(known(profile)))
    return {
      label: label ? (known(label) && safeLabel(known(label))) : 'delegation',
      out: flag('--out'),
      cwd,
      repo: known(flag('--repo')),
      base: known(flag('--base')),
      head: known(flag('--head')),
      requestId: known(flag('--request-id')),
      jobType: known(flag('--job-type')),
      model: known(flag('--model')),
      limitMs: seconds > 0 ? seconds * 1000 : CODEX_DEFAULT_LIMIT_MS,
      hasFallback,
      vars,
    }
  }
  return undefined
}

const envCache = new Map<string, string>()

// One environment variable of this machine, '' when unset.
async function envOf($: EngineInterface, name: string): Promise<string> {
  const known = envCache.get(name)
  if (known !== undefined) return known
  let value = ''
  try {
    const r = await $.process.run(['/usr/bin/printenv', name], { timeoutMs: 5_000 })
    value = r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {}
  envCache.set(name, value)
  return value
}

// A path from the command, made absolute: its own variables first, then this
// machine's environment, a leading ~, and a relative path against the
// command's own cd (itself against the session's folder); '' when any part is
// unknown.
async function pathOf($: EngineInterface, raw: string, vars: Record<string, string>, cwd: string): Promise<string> {
  let v = expandVars(raw, vars)
  if (v.includes('`') || v.includes('$(')) return ''
  for (const m of [...v.matchAll(/\$\{(\w+)\}|\$(\w+)/g)]) {
    const value = await envOf($, m[1] ?? m[2] ?? '')
    if (!value) return ''
    v = v.replace(m[0], value)
  }
  if (v === '~' || v.startsWith('~/')) v = (await envOf($, 'HOME')) + v.slice(1)
  if (v && !v.startsWith('/')) {
    let base = cwd ? await pathOf($, cwd, vars, '') : ''
    if (cwd && !base) return ''
    if (!base) {
      try {
        base = await $.session.cwd()
      } catch {
        return ''
      }
    }
    v = `${base}/${v}`
  }
  const parts: string[] = []
  for (const p of v.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '' && p !== '.') parts.push(p)
  }
  return v ? `/${parts.join('/')}` : ''
}

// What a run works on, in a few words: the repository folder and, for a
// review, base..head; never the command.
function targetOf(repo: string, base: string, head: string): string {
  const range = base && head ? `${base.slice(0, 7)}..${head.slice(0, 7)}` : ''
  return [repo ? baseName(repo) : '', range].filter(Boolean).join(' ')
}

// What a running card says it is doing, and what it was asked, by job type.
function verbOf(jobType: string): [string, string] {
  if (jobType === 'review') return ['Reviewing', 'Reviews']
  if (jobType === 'plan') return ['Planning for', 'Plans for']
  return ['Working on', 'Works on']
}

function ended(code: number, jobType: string): [AgentCard['status'], string] {
  if (code === 0) return ['done', jobType === 'review' || jobType === 'plan' ? `${jobType} finished` : 'finished']
  return CODEX_EXITS[code] ?? ['failed', `exit ${code}`]
}

// A sha the command names agrees with the request's resolved one; a name
// (main, HEAD) is not compared.
function agrees(literal: string, sha: unknown): boolean {
  return !/^[0-9a-f]{7,40}$/i.test(literal) || str(sha).toLowerCase().startsWith(literal.toLowerCase())
}

type Found = { dir: string; at: number; requestId: string }
type Before = { dir: string; requestId: string; request: Record<string, unknown> }

// What a request works on. Without --request-id the runner gives each attempt
// a new id, so a fallback is known by these instead: the same brief (its hash)
// in the same checkout, which another run of the same commits does not share.
const WORK_FIELDS = ['job_type', 'repo_id', 'base_sha', 'head_sha', 'checkout', 'brief_sha256']
const sameWork = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  WORK_FIELDS.every(k => str(a[k]) === str(b[k]))

// The run folder a card's run writes: of its label, stamped no earlier than the
// second the call started, not another card's, and agreeing with every request
// field the command names literally (request id, base, head); the earliest
// such, since a later one is a later run. With `after`, the folder a profile's
// fallback made, stamped no earlier than the one it follows: the same request
// id when the command names one, else the same work.
async function findRunDir(
  $: EngineInterface, run: CodexRun, from: number, taken: Set<string>, after?: Before,
): Promise<Found | undefined> {
  if (!run.out) return undefined
  const dir = `${run.out.replace(/\/[^/]*$/, '') || '/'}/.codex-runs`
  const floor = Math.floor(from / 1000) * 1000
  const folders = (await $.fs.list(dir)).flatMap(e => {
    const m = e.name.match(RUN_DIR_RE)
    if (!m || e.kind !== 'dir' || (run.label && m[7] !== run.label)) return []
    const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
    return at < floor ? [] : [{ dir: `${dir}/${e.name}`, at }]
  }).sort((a, b) => a.at - b.at || a.dir.localeCompare(b.dir))
  for (const f of folders) {
    if (taken.has(f.dir) || f.dir === after?.dir) continue
    // request.json comes just before the started receipt; a run refused that
    // early has only its receipt's bare request.
    const request = await jsonAt($, `${f.dir}/request.json`)
      ?? (await jsonAt($, `${f.dir}/receipt.json`))?.request as Record<string, unknown> | undefined
    if (!request) continue
    const requestId = str(request.request_id)
    if (after) {
      if (run.requestId ? requestId !== after.requestId : !sameWork(request, after.request)) continue
    } else if ((run.requestId && requestId !== run.requestId) || !agrees(run.base, request.base_sha) || !agrees(run.head, request.head_sha)) {
      continue
    }
    return { dir: f.dir, at: f.at, requestId }
  }
  return undefined
}

type PastRun = { path: string; label: string; job: string; repo: string; ms: number; finishedAt: number }
// Each folder's succeeded runs, read once an hour and once at a time however
// many ticks ask: the project folders, and each run's own runs folder once it
// is known, so runs kept beside it count too.
const pastByRoot = new Map<string, { at: number; runs: PastRun[] }>()
const pastLoading = new Map<string, Promise<void>>()

// Succeeded Codex runs that finished in the last HISTORY_DAYS days, newest
// HISTORY_MAX of them, from the project folders' run folders and this run's own.
async function pastRuns($: EngineInterface, t: number, runsDir: string): Promise<PastRun[]> {
  const home = await envOf($, 'HOME')
  const roots = [...new Set([home ? `${home}/.claude/projects` : '', runsDir].filter(Boolean))]
  const byPath = new Map<string, PastRun>()
  for (const root of roots) {
    const cached = pastByRoot.get(root)
    if (!cached || t - cached.at > HISTORY_TTL_MS) {
      if (!pastLoading.has(root)) {
        pastLoading.set(root, loadPast($, t, root).finally(() => pastLoading.delete(root)))
      }
      await pastLoading.get(root)
    }
    for (const run of pastByRoot.get(root)?.runs ?? []) byPath.set(run.path, run)
  }
  return [...byPath.values()]
    .filter(r => t - r.finishedAt <= HISTORY_DAYS * 86_400_000)
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, HISTORY_MAX)
}

// One folder's succeeded runs. `find -mtime` only narrows the files read: a
// receipt is written when its run ends, so the finish date is checked above.
async function loadPast($: EngineInterface, t: number, root: string) {
  const runs: PastRun[] = []
  try {
    const r = await $.process.run(
      ['/usr/bin/find', root, '-maxdepth', '4', '-path', '*/.codex-runs/*/receipt.json', '-mtime', `-${HISTORY_DAYS + 1}`],
      { timeoutMs: 20_000 },
    )
    const paths = [...new Set(r.stdout.split('\n').filter(Boolean).map(p => p.replace(/\/{2,}/g, '/')))]
    for (const path of paths) {
      const d = await jsonAt($, path)
      if (!d || d.terminal_status !== 'succeeded') continue
      const finishedAt = Date.parse(str(d.finished_utc))
      const ms = finishedAt - Date.parse(str(d.started_utc))
      const m = str(d.run_id).match(RUN_DIR_RE)
      if (!(ms > 0) || !m) continue
      const request = (d.request ?? {}) as Record<string, unknown>
      runs.push({ path, label: m[7]!, job: str(request.job_type), repo: str(request.repo_id), ms, finishedAt })
    }
  } catch {}
  pastByRoot.set(root, { at: t, runs })
}

// A run's usual time: the median of past runs of its repository and job type,
// else of its label and job type, else of its job type; 0 with fewer than
// HISTORY_MIN. It may be past the run's limit. Also how many runs that was.
function typicalOf(runs: PastRun[], run: CodexRun, label: string): [number, number] {
  const job = run.jobType
  const groups = [
    run.repoId ? runs.filter(r => r.repo === run.repoId && r.job === job) : [],
    label ? runs.filter(r => r.label === label && r.job === job) : [],
    runs.filter(r => r.job === job),
  ]
  for (const group of groups) {
    const mid = group.length >= HISTORY_MIN ? median(group.map(r => r.ms)) : undefined
    if (mid !== undefined) return [mid, group.length]
  }
  return [0, 0]
}

async function jsonAt($: EngineInterface, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(String(await $.fs.read(path)))
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

const num = (v: unknown): number => typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')) || 0

// The latest token count in the Codex session log the process keeps open.
async function logUsage($: EngineInterface, run: CodexRun): Promise<Partial<AgentCard> & { rollout: string; window: number } | undefined> {
  let rollout = run.rollout
  if (!rollout && run.pid > 0) {
    const r = await $.process.run(['/usr/sbin/lsof', '-p', String(run.pid), '-Fn'], { timeoutMs: 5_000 })
    rollout = r.stdout.split('\n').find(l => /^n.*\/rollout-[^/]*\.jsonl$/.test(l))?.slice(1) ?? ''
  }
  if (!rollout) return undefined
  const r = await $.process.run(['/usr/bin/tail', '-c', String(CODEX_LOG_TAIL), rollout], { timeoutMs: 5_000 })
  const line = r.stdout.split('\n').reverse().find(l => l.includes('"token_count"'))
  if (!line) return { rollout, window: run.window }
  try {
    const info = JSON.parse(line).payload.info
    const total = info.total_token_usage ?? {}
    const last = info.last_token_usage ?? {}
    return {
      rollout,
      window: num(info.model_context_window) || run.window,
      tokens: num(total.total_tokens),
      outTokens: num(total.output_tokens),
      context: num(last.input_tokens) + num(last.output_tokens),
    }
  } catch {
    return { rollout, window: run.window }
  }
}

// A receipt value the runner had not learned yet reads "unknown" ("inherited"
// for an effort left to Codex's own setting): the first value that says more.
function firstKnown(...values: unknown[]): string {
  return values.map(str).find(v => v !== '' && v !== 'unknown' && v !== 'inherited') ?? ''
}

const isOver = (receipt: Record<string, unknown> | undefined) =>
  !!receipt && str(receipt.terminal_status) !== '' && receipt.terminal_status !== 'started'

// Cards whose files are being read now, and when that read started: a slow
// read is never started twice. A read asked for meanwhile (a run's end) is
// noted and runs once the slow one is done, so what the end changed is read.
const reading = new Map<string, number>()
const readAgain = new Set<string>()

// Reads a run's files and puts what they say on its card. Best effort: a file
// not written yet, or unreadable, changes nothing.
async function readCodex($: EngineInterface, id: string, at: number) {
  if (reading.has(id)) {
    readAgain.add(id)
    return
  }
  reading.set(id, at)
  try {
    await readCodexFiles($, id, at)
    while (readAgain.delete(id)) {
      const now = await $.clock.now()
      reading.set(id, now)
      await readCodexFiles($, id, now)
    }
  } finally {
    reading.delete(id)
  }
}

async function readCodexFiles($: EngineInterface, id: string, at: number) {
  const all = await read($, agents)
  const card = all[id]
  const run = card?.codex
  if (!card || !run) return
  const taken = new Set(Object.values(all).flatMap(c => c.id !== id && c.codex?.runDir ? [c.codex.runDir] : []))
  const found: Partial<CodexRun> = { readAt: at }
  const fields: Partial<AgentCard> = {}
  const isRunning = card.status === 'running'
  try {
    let runDir = run.runDir
    let requestId = run.runRequestId
    if (!runDir) {
      const f = await findRunDir($, run, card.startedAt, taken)
      if (f) {
        ({ dir: runDir, requestId } = f)
        Object.assign(found, { runDir, runAt: f.at, runRequestId: requestId })
      }
    }
    if (runDir) {
      let receipt = await jsonAt($, `${runDir}/receipt.json`)
      // A profile's fallback runs it once more, in a folder of its own: follow it.
      // Once only, as the runner does: a failed fallback is the run's end.
      if (isRunning && fallsBack(run) && !run.isFallback && isOver(receipt) && CODEX_FALLBACK_EXITS.includes(num(receipt?.exit_code))) {
        const first = (receipt?.request ?? {}) as Record<string, unknown>
        const next = await findRunDir($, run, run.runAt || card.startedAt, taken, { dir: runDir, requestId, request: first })
        if (next) {
          runDir = next.dir
          Object.assign(found, {
            runDir, runAt: next.at, runRequestId: next.requestId, pid: 0, rollout: '',
            endSeenAt: 0, endCode: -1, endStatus: '', deadlineFrom: next.at, isFallback: true,
          })
          receipt = await jsonAt($, `${runDir}/receipt.json`)
        }
      }
      const cur = { ...run, ...found }
      const request = (receipt?.request ?? {}) as Record<string, unknown>
      const model = firstKnown(receipt?.observed_model, receipt?.argv_model, request.model)
      const effort = firstKnown(receipt?.observed_effort, receipt?.argv_effort, request.effort)
      if (model) fields.model = model
      if (effort) fields.effort = effort
      found.jobType = str(request.job_type) || cur.jobType
      found.repoId = str(request.repo_id) || cur.repoId
      // The request names what the run works on, resolved, where the command
      // may only have named variables.
      const isReview = found.jobType === 'review'
      const target = targetOf(str(request.checkout), isReview ? str(request.base_sha) : '', isReview ? str(request.head_sha) : '')
      if (target) {
        const [doing, asked] = verbOf(found.jobType)
        fields.prompt = `${asked} ${target}`
        if (isRunning) fields.doing = `${doing} ${target}`
      }
      if (!cur.pid) found.pid = num((await jsonAt($, `${runDir}/child-process.json`))?.pid)
      if (isRunning) {
        const usage = await logUsage($, { ...cur, ...found })
        if (usage) {
          found.rollout = usage.rollout
          found.window = usage.window
          if (usage.tokens) Object.assign(fields, { tokens: usage.tokens, outTokens: usage.outTokens, context: usage.context })
        }
        if (isOver(receipt) && !cur.endSeenAt) {
          const code = receipt?.exit_code
          Object.assign(found, { endSeenAt: at, endCode: typeof code === 'number' ? code : -1, endStatus: str(receipt?.terminal_status) })
        }
      } else if (num(receipt?.tokens)) {
        fields.tokens = num(receipt?.tokens)
      }
    }
    if (isRunning) {
      const cur = { ...run, ...found }
      const label = baseName(cur.runDir).match(RUN_DIR_RE)?.[7] ?? cur.label
      const runsDir = cur.runDir.replace(/\/[^/]*$/, '')
      ;[found.expectedMs, found.history] = typicalOf(await pastRuns($, at, runsDir), cur, label)
    }
  } catch {}
  await edit($, id, c => {
    // A slow read the run outlived drops its doing line, which would cover the
    // end words; the read the end asked for runs next and has the final counts.
    if (isRunning && c.status !== 'running') {
      const { doing: _d, ...lasting } = fields
      return { ...c, ...lasting, codex: { ...c.codex!, ...found } }
    }
    return { ...c, ...fields, codex: { ...c.codex!, ...found } }
  })
}

// A run's card at its end, in words: the doing line ("Reviewing ...") is
// cleared, since the card shows it first while set.
function finishCodex(c: AgentCard, status: AgentCard['status'], words: string, at: number, code = -1): AgentCard {
  return { ...c, status, endedAt: at, doing: '', said: words, saidAt: at, active: 0, idleSince: at, codex: { ...c.codex!, exitCode: code } }
}

// A run's card at its end, from the runner's exit code.
function endCodex(c: AgentCard, code: number, at: number): AgentCard {
  const [status, words] = ended(code, c.codex!.jobType)
  return finishCodex(c, status, words, at, code)
}

// A run that did not finish is said out loud, not only drawn: a toast names it.
async function tellEnd($: EngineInterface, id: string) {
  const c = (await read($, agents))[id]
  if (!c?.codex || c.status === 'done' || c.status === 'running') return
  try {
    await $.ui.toast(fit(`Codex: ${c.description} ${c.status === 'failed' ? 'failed' : 'stopped'}: ${c.said}`, 160))
  } catch {}
}

// The call answered: a background run keeps running until its notification;
// a foreground one ended, with the exit code its error text leads with.
async function settleCodex($: EngineInterface, id: string, result: ToolCallResult | undefined, at: number) {
  await edit($, id, c => {
    if (!result || result.deny !== undefined) return finishCodex(c, 'stopped', 'not started', at)
    const r = typeof result.result === 'object' && result.result ? result.result as Record<string, unknown> : {}
    const taskId = str(r.backgroundTaskId) || str(r.taskId)
    if (!result.isError && taskId) {
      return { ...c, codex: { ...c.codex!, taskId, endsWithOwner: r.backgroundEndsWithFinalResponse === true } }
    }
    if (r.interrupted === true) return finishCodex(c, 'stopped', 'interrupted', at)
    const code = str(result.text).match(/^Exit code (-?\d+)/)?.[1]
    return endCodex(c, code === undefined ? (result.isError ? 1 : 0) : Number(code), at)
  })
  await readCodex($, id, at)
  await tellEnd($, id)
}

// A background task's notification ends the Codex run it names: by its exit
// code, or as stopped when it was killed.
async function noteCodex($: EngineInterface, body: string, at: number) {
  const note = parseNote(body)
  if (!note) return
  const all = await read($, agents)
  for (const c of Object.values(all)) {
    const run = c.codex
    if (!run || c.status !== 'running') continue
    const isIt = (note.taskId !== '' && run.taskId === note.taskId) || (note.toolUseId !== '' && c.id === `codex-${note.toolUseId}`)
    if (!isIt) continue
    await edit($, c.id, card => note.exitCode >= 0 ? endCodex(card, note.exitCode, at)
      : note.status === 'ok' ? endCodex(card, 0, at)
        : note.status === 'stopped' ? finishCodex(card, 'stopped', 'stopped before it finished', at)
          : finishCodex(card, 'failed', 'failed, no exit code given', at))
    await readCodex($, c.id, at)
    await tellEnd($, c.id)
  }
}

// A helper's final answer ends its runs that die with it.
async function endOwnedCodex($: EngineInterface, owner: string, at: number) {
  const ids = Object.values(await read($, agents))
    .filter(c => c.codex?.owner === owner && c.codex.endsWithOwner && c.status === 'running')
    .map(c => c.id)
  for (const id of ids) {
    await edit($, id, c => finishCodex(c, 'stopped', 'ended with its helper', at))
    await tellEnd($, id)
  }
}

// When a run's limit ends it. A profile with a fallback can run it twice, each
// up to its limit, so until the card follows the fallback's own folder it has
// twice the time; from there its limit counts from that start. The limit check,
// the fail words, the bar and the card's time line all read this one answer.
function deadlineOf(c: AgentCard): number {
  const run = c.codex!
  return (run.deadlineFrom || c.startedAt) + run.limitMs * (fallsBack(run) && !run.isFallback ? 2 : 1)
}

// Whether a fallback can run it a second time. A card saved before the field
// was named hasFallback carries hasProfile instead, so a run live across an
// update keeps its fallback.
function fallsBack(run: CodexRun): boolean {
  return run.hasFallback ?? (run as { hasProfile?: boolean }).hasProfile === true
}

// Whether a running run is well past its limit.
function isPastLimit(c: AgentCard, t: number): boolean {
  return t > deadlineOf(c) + CODEX_OVER_LIMIT_MS
}

// Every second, each running run: ended by its receipt when no notice came,
// failed once well past its limit, and its files read again every CODEX_READ_MS.
async function pollCodex($: EngineInterface, t: number) {
  for (const seen of Object.values(await read($, agents))) {
    if (!seen.codex || seen.status !== 'running') continue
    let c = seen
    // Past its limit, the files are read once more before anything is decided:
    // its receipt may have just ended it, or a fallback just started. A read
    // already under way is waited for, but not past CODEX_STUCK_READ_MS: then
    // the card decides on what it already knows.
    if (!c.codex!.endSeenAt && isPastLimit(c, t)) {
      const since = reading.get(c.id)
      if (since === undefined) {
        await readCodex($, c.id, t)
        const fresh = (await read($, agents))[c.id]
        if (!fresh?.codex || fresh.status !== 'running') continue
        c = fresh
      } else if (t - since < CODEX_STUCK_READ_MS) {
        continue
      }
    }
    const run = c.codex!
    // Past its limit an ended receipt is not waited on for a notice.
    if (run.endSeenAt && (t - run.endSeenAt >= CODEX_RECEIPT_GRACE_MS || isPastLimit(c, t))) {
      await edit($, c.id, card => run.endCode >= 0 ? endCodex(card, run.endCode, t)
        : finishCodex(card, run.endStatus === 'interrupted' ? 'stopped' : 'failed', run.endStatus || 'ended', t))
      await tellEnd($, c.id)
    } else if (isPastLimit(c, t)) {
      await edit($, c.id, card => finishCodex(card, 'failed', `no end ${span(t - card.startedAt)} after it started, past its ${span(deadlineOf(card) - card.startedAt)} limit`, t))
      await tellEnd($, c.id)
    } else if (t - run.readAt >= CODEX_READ_MS) {
      await readCodex($, c.id, t)
    }
  }
}

// One redraw a second while anything runs, and through the band's grace after,
// so the timers move and the band goes away; none when idle.
async function tick($: EngineInterface) {
  // The same clock the start and end times come from, so tests can move it.
  const t = await $.clock.now()
  await update($, now, () => t)
  await pollCodex($, t)
  const all = Object.values(await read($, agents))
  const isShellRunning = Object.values(await read($, shells)).some(r => r.status === 'running')
  if (!isBandShown(batchOf(all), t) && !isShellRunning && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

async function togglePrompt($: EngineInterface, id: string) {
  await update($, openPrompts, ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id])
}

function wake($: EngineInterface) {
  if (!ticker) ticker = $.clock.every(1000, () => tick($))
}

// Drops every card, shell and the main row: what an earlier conversation left.
async function forget($: EngineInterface) {
  await update($, agents, () => ({}))
  await update($, shells, () => ({}))
  await update($, main, () => ({ ...IDLE, lastPrompt: '', lastPromptAt: 0 }))
  await update($, hiddenIds, () => [])
  await update($, openPrompts, () => [])
}

// A /clear or a resume keeps the process, and so this state, but starts another
// conversation under a new id, and no session.start fires for it. session.end
// resets at once; this is the fallback for a switch it did not see (a hot
// reload in between). Only the main loop's events ask: a helper's hook may read
// its own id. The decision is made inside one update, so of two events that
// race only one sees the old id and drops.
async function fresh($: EngineInterface, agentId?: string) {
  if (agentId) return
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    return
  }
  let moved = false
  await update($, sessionId, was => {
    moved = was !== '' && was !== id
    return id
  })
  if (moved) await forget($)
}

export const register: Register = (on, options) => {
  // The two switches in plugin.json's userConfig. The pane is on unless switched
  // off; the band above the prompt is off unless switched on, since the same
  // bar is at the top of the pane.
  const showPane = options.showPane !== false
  const showBand = options.showBand === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-panel',
      description: 'Show the Agents pane: what each helper is doing, its tokens, cost and time',
    })
    const result = await next(e)
    await fresh($)
    try {
      window = (await $.session.usage()).context.window || window
    } catch {}
    // Agents already running when the mod loaded have no token history; show them anyway.
    try {
      const at = await $.clock.now()
      for (const info of await $.agent.list()) {
        await update($, agents, all => all[info.id] ? all : {
          ...all,
          [info.id]: {
            ...blank(info.id, at),
            description: info.description || 'helper',
            type: info.type,
            status: statusOf(info.status),
          },
        })
      }
      wake($)
    } catch {}
    return result
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    if (!showPane) {
      return { text: 'The Agents pane is switched off. Turn "Show the Agents pane" back on in /config.' }
    }
    await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: 'Agents pane opened.' }
  })

  // A /clear or a resume ends this conversation while the process goes on: drop
  // its work now, so the pane and band never show it in the next one.
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

  on('agent.spawn', async ($, e, next) => {
    await fresh($, e.parentAgentId)
    const result = await next(e)
    if (result.agentId) {
      const id = result.agentId
      const at = await $.clock.now()
      await update($, agents, all => ({
        ...all,
        [id]: {
          ...blank(id, at),
          description: e.description || 'helper',
          type: e.subagentType,
          model: result.model,
          prompt: e.prompt,
        },
      }))
      wake($)
      if (showPane) void $.ui.open({ id: PANE, title: 'Agents' })
    }
    return result
  })

  // turn.step streams: forward every chunk untouched, then read the finished response.
  on('turn.step', async function* ($, e, next) {
    await fresh($, e.agentId)
    const result = yield* next(e)
    const at = await $.clock.now()
    if (e.agentId) {
      await edit($, e.agentId, card => say(card, result.answer, at))
    } else {
      await update($, main, m => say(m, result.answer, at))
    }
    if (e.agentId && result.usage) {
      const u = result.usage
      const [pin, pout, pread, pwrite] = priceOf(u.model || e.model)
      const context = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const cost = (u.input_tokens * pin + u.output_tokens * pout
        + u.cache_read_input_tokens * pread + u.cache_creation_input_tokens * pwrite) / 1_000_000
      await edit($, e.agentId, card => ({
        ...card,
        model: u.model || e.model || card.model,
        effort: e.effort === undefined ? card.effort : String(e.effort),
        steps: card.steps + 1,
        tokens: card.tokens + context + u.output_tokens,
        outTokens: card.outTokens + u.output_tokens,
        context,
        cost: card.cost + cost,
      }))
    }
    return result
  })

  // Every tool call of the session, main loop and helpers alike: what each loop
  // is doing, and every shell command (Bash, Monitor) from start to end.
  on('tool.call', async ($, e, next) => {
    await fresh($, e.agentId)
    const at = await $.clock.now()
    // A helper the pane does not know (one of an earlier conversation) gets no row.
    const known = await isKnown($, e.agentId)
    const fields = e as unknown as Record<string, unknown>
    const call = known && e.tool === 'Bash' ? codexCallOf(str(fields.command)) : undefined
    const isShell = !call && (e.tool === 'Bash' || e.tool === 'Monitor') && known
    const id = e.tool_use_id || `${e.tool}-${at}-${Math.random().toString(36).slice(2, 8)}`
    const codexId = `codex-${id}`
    await beginCall($, e, at)
    if (call) {
      const target = targetOf(call.repo, call.base, call.head)
      const [doing, asked] = verbOf(call.jobType)
      const out = await pathOf($, call.out, call.vars, call.cwd)
      await update($, agents, all => ({
        ...all,
        [codexId]: {
          ...blank(codexId, at),
          description: fit(oneLine(str(fields.description)), 200) || `Codex ${call.label || 'run'}`,
          type: 'codex',
          model: call.model,
          prompt: target ? `${asked} ${target}` : '',
          doing: target ? `${doing} ${target}` : doing,
          doingAt: at,
          active: 1,
          codex: {
            label: call.label, out, limitMs: call.limitMs, requestId: call.requestId, base: call.base,
            head: call.head, jobType: call.jobType, repoId: '', hasFallback: call.hasFallback,
            owner: e.agentId ?? 'main', endsWithOwner: false, taskId: '', exitCode: -1,
            runDir: '', runAt: 0, runRequestId: '', pid: 0, rollout: '', window: 0, readAt: 0,
            endSeenAt: 0, endCode: -1, endStatus: '', expectedMs: 0, history: 0, deadlineFrom: at, isFallback: false,
          },
        },
      }))
      wake($)
      if (showPane) void $.ui.open({ id: PANE, title: 'Agents' })
    }
    if (isShell) {
      await startShell($, id, e, at)
      wake($)
      if (showPane && opensPane(e)) void $.ui.open({ id: PANE, title: 'Agents' })
    }
    let result: ToolCallResult | undefined
    try {
      result = await next(e)
      return result
    } finally {
      const end = await $.clock.now()
      await endCallOn($, e, result, end)
      if (isShell) await settleShell($, id, result, end)
      if (call) await settleCodex($, codexId, result, end)
    }
  })

  on('turn.complete', async ($, e, next) => {
    await fresh($, e.agentId)
    if (e.agentId) {
      const at = await $.clock.now()
      const status = e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
      await edit($, e.agentId!, card => ({ ...card, status, endedAt: at, lastTool: '' }))
      await endOwnedShells($, e.agentId, at)
      await endOwnedCodex($, e.agentId, at)
    }
    return next(e)
  })

  // The owner's own prompts, and background tasks' notifications that end a shell.
  on('prompt.submit', async ($, e, next) => {
    await fresh($)
    const at = await $.clock.now()
    const kind = e.origin.kind
    if ((kind === 'composer' || kind === 'bridge') && !e.isMeta) {
      const line = fit(oneLine(e.text), 300)
      if (line) await update($, main, m => ({ ...m, lastPrompt: line, lastPromptAt: at }))
    }
    if (kind === 'task-notification') {
      await noteShells($, e.text, at)
      await noteCodex($, e.text, at)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A notification delivered into a helper's loop reaches it as a row, not a prompt.
  on('session.append', async ($, e, next) => {
    await fresh($, e.agentId)
    if (e.origin.kind === 'task-notification') {
      const body = e.message.content
        .map(b => (b as { type: string; text?: unknown }).type === 'text' ? str((b as { text?: unknown }).text) : '')
        .join('\n')
      const at = await $.clock.now()
      await noteShells($, body, at)
      await noteCodex($, body, at)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The progress band above the prompt: shown while helpers run, and for the
  // grace after the last one ends. Every figure on it is an estimate.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const all = Object.values(await read($, agents))
    const hidden = await read($, hiddenIds)
    const t = Math.max(await read($, now), await $.clock.now())
    const batch = batchOf(all)
    const isHidden = all.length > 0 && all.every(c => hidden.includes(c.id))
    if (isHidden || !isBandShown(batch, t)) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const { est, isRunning, title, pct, eta, count, label } = barOf(batch, all, t)
    // Border and padding take 4 cells, the five gaps 5, the Hide button 8.
    const cols = e.props.bodyColumns || 60
    const fixed = 4 + 5 + 8 + title.length + pct.length + eta.length + count.length
    const track = Math.max(14, cols - fixed)
    const filled = filledOf(track, est.percent, label)

    return (
      <Box borderStyle="round" borderColor={BAND_ORANGE} paddingX={1} gap={1} alignItems="center">
        <Text color={isRunning ? BAND_ORANGE : 'success'} bold>{title}</Text>
        <Box>
          <Text color="#ffffff" backgroundColor={PILL_PURPLE} bold>{label.padEnd(filled)}</Text>
          {track > filled && <Text backgroundColor={TRACK_DARK}>{' '.repeat(track - filled)}</Text>}
        </Box>
        <Text bold>{pct}</Text>
        <Text dimColor>{eta}</Text>
        <Text color={BAND_ORANGE}>{count}</Text>
        <Button key="hide" label="Hide" onPress={() => hideBand($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    if (!showPane) {
      return <Text dimColor>The Agents pane is switched off in /config.</Text>
    }
    const all = Object.values(await read($, agents)).sort((a, b) => a.startedAt - b.startedAt)
    const byId = Object.fromEntries(all.map(c => [c.id, c]))
    const collapsed = await read($, isCollapsed)
    const mainRow = await read($, main)
    const shellRows = Object.values(await read($, shells))
    const shellsCollapsed = await read($, isShellsCollapsed)
    const opened = await read($, openPrompts)
    const t = Math.max(await read($, now), await $.clock.now())
    // The pane's padding takes 2 cells; a card's text sits right of its crab.
    const cols = Math.max(20, (e.props?.bodyColumns ?? 40) - 2)
    const textCols = Math.max(12, cols - CRAB_COLS - 1)
    // The terminal alone draws a Raster and alone lacks Svg; the table answers
    // `in` for every name, so the surface decides.
    const Raster = e.surface === 'terminal' && 'Raster' in els ? els.Raster : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

    const running = all.filter(c => c.status === 'running')
    const finished = all.filter(c => c.status !== 'running')
    const liveShells = shellRows.filter(r => r.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    const doneShells = shellRows.filter(r => r.status !== 'running').sort((a, b) => b.endedAt - a.endedAt)
    const sum = (f: (c: AgentCard) => number) => all.reduce((n, c) => n + f(c), 0)

    const tile = (label: string, value: string) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexGrow={1}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )

    const crab = (c: AgentCard) => {
      const hat = hatOf(c.type, c.description)
      const px = spriteOf(hat)
      const alt = `${hat.role} crab`
      if (Raster) return <Raster key={`crab-${c.id}`} columns={CRAB_COLS} rows={CRAB_ROWS} cells={rasterCells(px)} />
      if (Svg) return <Svg source={svgOf(px)} alt={alt} width={CRAB_COLS * 3} height={CRAB_COLS * 3} />
      return <Text dimColor>{alt}</Text>
    }

    const shellRow = (r: ShellRow) => {
      const mark = r.status === 'running' ? '…' : r.status === 'ok' ? '✓' : r.status === 'failed' ? '✗' : '■'
      const markColor = r.status === 'running' ? BAND_ORANGE : r.status === 'ok' ? 'success' : 'error'
      const owner = r.owner === 'main' ? 'main' : byId[r.owner]?.description ?? 'helper'
      const where = r.kind === 'monitor' ? 'monitor' : r.isBackground ? 'background' : 'foreground'
      const code = r.exitCode >= 0 ? ` (exit ${r.exitCode})` : ''
      const state = r.status === 'running'
        ? `running ${span(t - r.startedAt)}`
        : `${r.status}${code} · took ${span(r.endedAt - r.startedAt)} · ${span(t - r.endedAt)} ago`
      return (
        <Box key={`shell-${r.id}`} flexDirection="column">
          <Text wrap="truncate-end"><Text color={markColor}>{mark}</Text> {fit(r.description, cols - 2)}</Text>
          <Text dimColor wrap="truncate-end">{withTail(`  ${owner}`, ` · ${where} · ${state}`, cols)}</Text>
        </Box>
      )
    }

    const card = (c: AgentCard) => {
      const color = hatOf(c.type, c.description).color
      const elapsed = (c.endedAt || t) - c.startedAt
      const ctxWindow = c.codex?.window || window
      const pct = c.context ? Math.max(1, Math.round((100 * c.context) / ctxWindow)) : 0
      // A Codex run is billed by its own plan, so no Claude-priced cost, and it
      // makes no Claude tool or model calls; its limit is what it counts down to.
      const contextLine = c.codex
        ? `Context ${short(c.context)} (${pct}% of ${short(ctxWindow)})`
        : `Context ${short(c.context)} (${pct}% of ${short(window)}) · cost ${money(c.cost)}`
      const timeLine = c.codex
        // On a narrow pane only the count of past runs is cut.
        ? c.codex.expectedMs
          ? `Time ${clock(elapsed)} · usual ${clock(c.codex.expectedMs)} · limit ${clock(deadlineOf(c) - c.startedAt)} · ${plural(c.codex.history, 'past run')}`
          : `Time ${clock(elapsed)} · limit ${clock(deadlineOf(c) - c.startedAt)}`
        : `Time ${clock(elapsed)} · ${plural(c.tools, 'tool call')} · ${plural(c.steps, 'model call')}`
      const mark = c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : c.status === 'stopped' ? '■' : '…'
      const markColor = c.status === 'done' ? 'success' : c.status === 'running' ? color : 'error'
      const p = progressOf(c, all, t)
      const filled = Math.round(textCols * p.share)
      const bar = '━'.repeat(filled) + '─'.repeat(textCols - filled)
      const [head, tail] = doingNow(c, t)
      const isOpen = opened.includes(c.id)
      const asked = oneLine(c.prompt)
      const preview = asked.length > PROMPT_PREVIEW ? `${asked.slice(0, PROMPT_PREVIEW)}…` : asked
      return (
        <Box key={c.id} flexDirection="row" gap={1} marginTop={1}>
          <Box flexDirection="column" width={CRAB_COLS} flexShrink={0}>{crab(c)}</Box>
          <Box flexDirection="column" flexGrow={1}>
            <Box justifyContent="space-between">
              <Text bold wrap="truncate-end">{fit(c.description, textCols - 2)}</Text>
              <Text color={markColor}> {mark}</Text>
            </Box>
            <Text wrap="truncate-end">
              <Text color={color}>{c.type}</Text>
              <Text dimColor> {modelName(c.model)}{c.effort ? ` · ${c.effort}` : ''}</Text>
            </Text>
            <Text wrap="truncate-end">{head ? withTail(`▶ ${head}`, tail, textCols) : '▶ starting'}</Text>
            <Text wrap="truncate-end" color={color}>{withTail(p.label, '', textCols)}</Text>
            <Text color={color} dimColor={c.status !== 'running' && c.status !== 'done'}>{bar}</Text>
            <Text dimColor wrap="truncate-end">{fit(`Tokens ${short(c.tokens)} total · ↓${short(c.outTokens)} output`, textCols)}</Text>
            <Text dimColor wrap="truncate-end">{fit(contextLine, textCols)}</Text>
            <Text dimColor wrap="truncate-end">{fit(timeLine, textCols)}</Text>
            {asked ? <Text dimColor>Asked: {isOpen ? c.prompt : preview}</Text> : null}
            {asked.length > PROMPT_PREVIEW && (
              <Button
                key={`prompt-${c.id}`}
                plain
                label={isOpen ? '▾ Hide the prompt' : '▸ Show the whole prompt'}
                onPress={() => togglePrompt($, c.id)}
              />
            )}
            {c.recent.length > 0 && <Text dimColor>Recent</Text>}
            {c.recent.map((a, i) => (
              <Text key={`recent-${c.id}-${i}`} dimColor wrap="truncate-end">{withTail(`  ${a.label}`, ` · ${span(t - a.at)} ago`, textCols)}</Text>
            ))}
          </Box>
        </Box>
      )
    }

    const [mainHead, mainTail] = doingNow(mainRow, t)
    const promptTail = mainRow.lastPrompt ? `" · ${span(t - mainRow.lastPromptAt)} ago` : ''

    // The helpers' progress bar, at the top of the pane: on
    // two lines, so it fits a narrow pane, while the band's rules show it.
    const batch = batchOf(all)
    const helpersBar = () => {
      const b = barOf(batch, all, t)
      // The border and padding take 4 cells.
      const track = Math.max(10, cols - 4)
      const filled = filledOf(track, b.est.percent, b.label)
      return (
        <Box key="helpers-bar" flexDirection="column" borderStyle="round" borderColor={BAND_ORANGE} paddingX={1} marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={b.isRunning ? BAND_ORANGE : 'success'} bold>{b.title}</Text>
            <Text bold> {b.pct}</Text>
            <Text dimColor> · {b.eta}</Text>
            <Text color={BAND_ORANGE}> {b.count}</Text>
          </Text>
          <Box>
            <Text color="#ffffff" backgroundColor={PILL_PURPLE} bold>{fit(b.label, track).padEnd(filled)}</Text>
            {track > filled && <Text backgroundColor={TRACK_DARK}>{' '.repeat(track - filled)}</Text>}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{fit(`${plural(running.length, 'agent')} · ${plural(liveShells.length, 'shell')} running`, cols)}</Text>
        {isBandShown(batch, t) && helpersBar()}
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end"><Text color={BAND_ORANGE} bold>● main</Text> {mainHead ? withTail(mainHead, mainTail, cols - 7) : 'idle'}</Text>
          {mainRow.lastPrompt ? <Text dimColor wrap="truncate-end">{withTail(`last "${mainRow.lastPrompt}`, promptTail, cols)}</Text> : null}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {shellRows.length === 0
            ? <Text dimColor>No shell commands yet.</Text>
            : <Text bold>Shells · {liveShells.length} running</Text>}
          {liveShells.map(shellRow)}
          {doneShells.length > 0 && (
            <Button
              key="shells-toggle"
              plain
              label={`${shellsCollapsed ? '▸' : '▾'} Finished shells · ${doneShells.length}`}
              onPress={() => update($, isShellsCollapsed, v => !v)}
            />
          )}
          {!shellsCollapsed && doneShells.map(shellRow)}
        </Box>
        {all.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No helper agents in this session yet.</Text>
          </Box>
        )}
        {all.length > 0 && (
          <Box gap={1} marginTop={1}>
            {tile('Cost', money(sum(c => c.cost)))}
            {tile('Tokens', short(sum(c => c.tokens)))}
            {tile('Time', clock((running.length ? t : Math.max(...all.map(c => c.endedAt || c.startedAt))) - Math.min(...all.map(c => c.startedAt))))}
          </Box>
        )}
        {running.length > 0 && <Text bold>Running · {running.length}</Text>}
        {running.map(card)}
        {finished.length > 0 && (
          <Box marginTop={1}>
            <Button
              key="toggle"
              plain
              label={`${collapsed ? '▸' : '▾'} Finished · ${finished.length}`}
              onPress={() => update($, isCollapsed, v => !v)}
            />
          </Box>
        )}
        {!collapsed && finished.map(card)}
        {all.length > 0 && <Text dimColor>Cost is approximate: list prices times the tokens each helper used.</Text>}
      </Box>
    )
  })
}
