import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageAccount, UsageReading, UsageWindow } from '../types'

// The Usage pane: its own id, so the engine draws it as its own tab beside the
// other panes.
const PANE = 'usage-panel'
const account = atom({ plugin: 'usage-panel', key: 'account' } as const, null as UsageAccount | null)
const reading = atom({ plugin: 'usage-panel', key: 'reading' } as const, null as UsageReading | null)
const askedBy = atom({ plugin: 'usage-panel', key: 'askedBy' } as const, null as string | null)
const hasPrompted = atom({ plugin: 'usage-panel', key: 'hasPrompted' } as const, false)
const now = atom({ plugin: 'usage-panel', key: 'now' } as const, 0)

const BLUE = '#3b6fd4'
// How often the pane re-reads the account and looks for a limit that reset.
const CHECK_MS = 60_000
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// The limits in the order the pane lists them; any other kind comes after.
const LABELS: Record<string, string> = {
  seven_day: 'This week',
  five_hour: 'Last 5 hours',
  spend_limit: 'Spend limit',
}
const ORDER = Object.keys(LABELS)

function label(kind: string): string {
  const name = LABELS[kind]
  if (name) return name
  const words = kind.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function rank(kind: string): number {
  const at = ORDER.indexOf(kind)
  return at === -1 ? ORDER.length : at
}

function clockTime(d: Date): string {
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// "Thursday 1:00 AM", in this machine's time zone. Built by hand so the format
// is the same on every machine.
function dayTime(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${clockTime(d)}`
}

// The time alone when it is today, the day and time when it is not.
function readAt(ms: number, t: number): string {
  const d = new Date(ms)
  return d.toDateString() === new Date(t).toDateString() ? clockTime(d) : dayTime(ms)
}

function resetMs(w: UsageWindow): number | undefined {
  if (!w.resetsAt) return undefined
  const ms = Date.parse(w.resetsAt)
  return Number.isNaN(ms) ? undefined : ms
}

// A figure the engine reported before a reset that has since passed is no longer
// true, and nothing new arrives until the next answer.
function hasReset(w: UsageWindow, t: number): boolean {
  const ms = resetMs(w)
  return ms !== undefined && ms <= t
}

// Blocks for the filled share and for the rest, at least one filled block for
// any use at all. A share past 100 on an exceeded limit fills the bar.
function barCells(percent: number, cols: number): [number, number] {
  const share = Math.min(100, Math.max(0, percent))
  const filled = share > 0 ? Math.max(1, Math.round((share / 100) * cols)) : 0
  return [filled, cols - filled]
}

// The login record, read fresh each time because another window can switch the
// account at any moment. The engine's $.session.identity() answers only a mod
// that managed settings install; its doc says "any mod can read the person's own
// config file, where a login keeps the same facts".
//
// undefined means the file could not be read or parsed (another session may be
// writing it), so the caller keeps what it knows. null means it was read and
// holds no account.
async function readAccount($: EngineInterface): Promise<UsageAccount | null | undefined> {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = dir ?? (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!home) return undefined
    const raw = await $.fs.read(`${home}/.claude.json`)
    const card = JSON.parse(raw).oauthAccount
    if (!card || typeof card.emailAddress !== 'string' || !card.emailAddress) return null
    return {
      email: card.emailAddress,
      plan: typeof card.planDisplayName === 'string' ? card.planDisplayName : '',
    }
  } catch {
    return undefined
  }
}

// Writes the account only when it changed, and answers the one now in force.
async function refreshAccount($: EngineInterface): Promise<UsageAccount | null> {
  const found = await readAccount($)
  if (found === undefined) return read($, account)
  await update($, account, was =>
    was?.email === found?.email && was?.plan === found?.plan ? was : found)
  return found
}

// The only writer of the figures. The engine names no account on them, and a switch
// can happen in another window while a turn runs. So they are kept only right after
// a reply in the main loop, whose figures the engine holds by then, and only when
// one account was signed in both as its turn started and now.
async function noteReply($: EngineInterface) {
  const email = (await refreshAccount($))?.email ?? ''
  if ((await read($, askedBy)) !== email) return
  const { rateLimits } = await $.session.usage()
  const at = await $.clock.now()
  await update($, reading, () => ({
    windows: rateLimits.map((w: UsageWindow) => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
    at,
    email,
  }))
  await update($, now, () => at)
}

async function check($: EngineInterface) {
  await refreshAccount($)
  const t = await $.clock.now()
  await update($, now, () => t)
}

// A reload starts the module over, so this starts again with it.
let ticker: { cancel: () => void } | undefined

function wake($: EngineInterface) {
  if (!ticker) ticker = $.clock.every(CHECK_MS, () => check($))
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Usage' })
}

export const register: Register = (on, options) => {
  // The switch in plugin.json's userConfig: the pane is on unless switched off.
  const showPane = options.showPane !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-panel',
      description: 'Show the Usage pane: your account and how much of each limit is used',
    })
    const result = await next(e)
    if (showPane) {
      // State outlives a reload, and a turn already running was not seen starting.
      await update($, askedBy, () => null)
      await check($)
      wake($)
    }
    return result
  })

  on('command.run', { command: 'usage-panel' }, async $ => {
    if (!showPane) {
      return { text: 'The Usage pane is switched off. Turn "Show the Usage pane" back on in /config.' }
    }
    await check($)
    await openPane($)
    return { text: 'Usage pane opened.' }
  })

  // Who is signed in as the main loop's turn starts. A helper's turn says nothing.
  on('turn.start', async ($, e, next) => {
    if (showPane && !e.agentId) {
      const email = (await refreshAccount($))?.email ?? ''
      await update($, askedBy, () => email)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A helper's reply and a step with no reply (stopReason null) say nothing. A failure
  // here must never reach the turn itself.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (showPane && !e.agentId && result.stopReason !== null) {
      try {
        await noteReply($)
      } catch {}
    }
    return result
  })

  // A /clear or a resume starts another conversation in this process. The account
  // and the limits are still true, so only "the first prompt opens it" starts over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      try {
        await update($, hasPrompted, () => false)
      } catch {}
    }
    return next(e)
  })

  // The conversation's first prompt opens the pane, so the tab is there from the
  // start. Only the first: a pane the owner closes stays closed.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (showPane && (kind === 'composer' || kind === 'bridge') && !e.isMeta) {
      let isFirst = false
      await update($, hasPrompted, was => {
        isFirst = !was
        return true
      })
      if (isFirst) void openPane($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (!showPane) {
      return <Text dimColor>The Usage pane is switched off in /config.</Text>
    }
    const signedIn = await read($, account)
    const kept = await read($, reading)
    // An arrival time of 0 means the time is unknown, so the figure is not drawn.
    const got = kept && kept.at > 0 ? kept : null
    const t = Math.max(await read($, now), await $.clock.now())
    const cols = Math.max(10, (e.props?.bodyColumns ?? 40) - 2)

    // A figure is drawn only when its owner is the email on the pane, both maybe none.
    const isHidden = !!got && got.email !== (signedIn?.email ?? '')
    const isOtherAccount = isHidden && !!got.email && !!signedIn
    const windows = isHidden || !got
      ? []
      : [...got.windows].sort((a, b) => rank(a.kind) - rank(b.kind))
    const week = windows.find(w => w.kind === 'seven_day' && !hasReset(w, t))

    const row = (w: UsageWindow) => {
      const name = label(w.kind)
      const reset = resetMs(w)
      if (hasReset(w, t)) {
        return (
          <Box key={w.kind} flexDirection="column" marginTop={1}>
            <Text>{name}</Text>
            <Text dimColor>It reset {dayTime(reset!)}. The new figure comes with Claude's next answer.</Text>
          </Box>
        )
      }
      const [filled, rest] = barCells(w.percentUsed, cols)
      return (
        <Box key={w.kind} flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between">
            <Text>{name}</Text>
            <Text dimColor>{w.percentUsed}% used</Text>
          </Box>
          <Text wrap="truncate-end">
            <Text color={BLUE}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(rest)}</Text>
          </Text>
          {reset !== undefined && <Text dimColor>Resets {dayTime(reset)}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {signedIn && <Text dimColor wrap="truncate-end">{signedIn.email}</Text>}
        <Text wrap="truncate-end">
          <Text bold>Your usage</Text>
          {signedIn?.plan ? <Text dimColor>  {signedIn.plan}</Text> : null}
        </Text>
        {week && (
          <Box marginTop={1}>
            <Text>{week.percentUsed}% of your weekly limit used.</Text>
          </Box>
        )}
        {isOtherAccount && (
          <Box marginTop={1}>
            <Text dimColor>You switched account. The figures come with Claude's next answer.</Text>
          </Box>
        )}
        {!isOtherAccount && windows.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No limits to show yet. On a Claude subscription they come with Claude's next answer.</Text>
          </Box>
        )}
        {windows.map(row)}
        {windows.length > 0 && got && (
          <Box marginTop={1}>
            <Text dimColor>As of {readAt(got.at, t)}.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
