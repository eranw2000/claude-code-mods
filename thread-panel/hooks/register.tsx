import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ThreadEntry } from '../types'

// The Thread pane: its own id, so the engine draws it as its own tab beside
// the other panes.
const PANE = 'thread-panel'
const thread = atom({ plugin: 'thread-panel', key: 'thread' } as const, [] as ThreadEntry[])
const openPrompts = atom({ plugin: 'thread-panel', key: 'openPrompts' } as const, [] as string[])
const sessionId = atom({ plugin: 'thread-panel', key: 'sessionId' } as const, '')
const now = atom({ plugin: 'thread-panel', key: 'now' } as const, 0)

// The pane keeps this many prompts, shows this much of a prompt folded, and
// this much of an answer's first paragraph.
const KEEP = 200
const PROMPT_FOLD = 300
const ANSWER_KEEP = 800
const ORANGE = '#d9734e'
// The "ago" labels move on every second while the newest prompt is still being
// worked on, and every half minute after its answer.
const WORKING_MS = 1000
const IDLE_MS = 30_000

// A cut that keeps a line on one row: the text, or its head and an ellipsis.
function fit(text: string, cols: number): string {
  return text.length <= cols ? text : `${text.slice(0, Math.max(1, cols - 1))}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// The text up to its first blank line, on one line.
function firstParagraph(text: string): string {
  return oneLine(text.trim().split(/\n\s*\n/)[0] ?? '')
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

async function togglePrompt($: EngineInterface, id: string) {
  await update($, openPrompts, ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id])
}

// The stored row carries no prompt number, so it goes to the oldest prompt with
// the same text still without a row, else the newest one without a row: the
// row is stored right after its prompt.submit.
async function noteRow($: EngineInterface, text: string, rowId: string) {
  await update($, thread, list => {
    if (list.some(x => x.rowId === rowId)) return list
    const open = list.filter(x => !x.rowId)
    const target = open.find(x => x.prompt === text) ?? open.at(-1)
    return target ? list.map(x => x === target ? { ...x, rowId } : x) : list
  })
}

// Scrolls the transcript to the prompt's row. The engine moves a transcript row
// only for the person's own press, and says why when it cannot.
async function jumpTo($: EngineInterface, rowId: string) {
  let why: string | undefined
  try {
    why = (await $.ui.scroll({ to: { requestId: rowId }, block: 'start' })).deny
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  if (why) await $.ui.toast(fit(`Thread: cannot jump to that message (${oneLine(why)})`, 160))
}

// The timer that moves the "ago" labels on: one second, writing the time only
// as often as the newest prompt's state asks for. It stops when the list is empty.
let ticker: { cancel: () => void } | undefined

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  const list = await read($, thread)
  const last = list.at(-1)
  if (!last) {
    ticker?.cancel()
    ticker = undefined
    return
  }
  const isWorking = !last.answer && !last.isStopped
  const was = await read($, now)
  if (isWorking ? t - was >= WORKING_MS : t - was >= IDLE_MS) await update($, now, () => t)
}

function wake($: EngineInterface) {
  if (!ticker) ticker = $.clock.every(WORKING_MS, () => tick($))
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Thread' })
}

// Drops every entry: what an earlier conversation left.
async function forget($: EngineInterface) {
  await update($, thread, () => [])
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
  // The switch in plugin.json's userConfig: the pane is on unless switched off.
  const showPane = options.showPane !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'thread-panel',
      description: 'Show the Thread pane: each prompt you typed, with the first paragraph of the answer',
    })
    const result = await next(e)
    await fresh($)
    // A reload starts the module over, timer included.
    if ((await read($, thread)).length > 0) wake($)
    return result
  })

  on('command.run', { command: 'thread-panel' }, async $ => {
    if (!showPane) {
      return { text: 'The Thread pane is switched off. Turn "Show the Thread pane" back on in /config.' }
    }
    await openPane($)
    return { text: 'Thread pane opened.' }
  })

  // A /clear or a resume ends this conversation while the process goes on: drop
  // its prompts now, so the pane never shows them in the next one.
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

  // The main loop's answer goes under the newest prompt. A later turn with no
  // prompt of its own (a background job's notice) replaces it, so the pane
  // shows where the work ended up. A helper's turn writes nothing here.
  on('turn.complete', async ($, e, next) => {
    await fresh($, e.agentId)
    if (!e.agentId) {
      const answer = fit(firstParagraph(e.answer), ANSWER_KEEP)
      if (answer || e.isAborted) {
        const at = await $.clock.now()
        await update($, thread, list => {
          const last = list.at(-1)
          if (!last) return list
          const entry = answer
            ? { ...last, answer, answerAt: at, isStopped: e.isAborted }
            : { ...last, isStopped: true }
          return [...list.slice(0, -1), entry]
        })
      }
    }
    return next(e)
  })

  // A conversation switch can first show on any main-loop event, so these ask too,
  // and the Thread pane drops the old prompts as soon as the Agents pane does.
  on('agent.spawn', async ($, e, next) => {
    await fresh($, e.parentAgentId)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await fresh($, e.agentId)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await fresh($, e.agentId)
    return yield* next(e)
  })

  // The owner's own prompts.
  on('prompt.submit', async ($, e, next) => {
    await fresh($)
    const kind = e.origin.kind
    if ((kind === 'composer' || kind === 'bridge') && !e.isMeta) {
      const prompt = e.text.trim()
      if (prompt) {
        const at = await $.clock.now()
        // The conversation's first prompt opens the pane, so the tab is there from
        // the start. Only the first: a pane the owner closes stays closed.
        // Decided inside the one update, so of two prompts that race only one opens it.
        let isFirst = false
        await update($, thread, list => {
          isFirst = list.length === 0
          return [
            ...list,
            { n: (list.at(-1)?.n ?? 0) + 1, prompt, promptAt: at, answer: '', answerAt: 0, isStopped: false },
          ].slice(-KEEP)
        })
        wake($)
        if (isFirst && showPane) void openPane($)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The engine storing the owner's prompt as a transcript row: tie the row to
  // its prompt, so a press on the prompt can scroll to it.
  on('session.append', async ($, e, next) => {
    await fresh($, e.agentId)
    const kind = e.origin.kind
    if (!e.agentId && e.door === 'prompt' && (kind === 'composer' || kind === 'bridge') && !e.message.isMeta) {
      const text = e.message.content
        .map(b => (b as { type: string; text?: unknown }).type === 'text' ? str((b as { text?: unknown }).text) : '')
        .join('\n')
        .trim()
      await noteRow($, text, e.uuid)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each prompt the owner typed, oldest first, with the first paragraph of the
  // main loop's answer under it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!showPane) {
      return <Text dimColor>The Thread pane is switched off in /config.</Text>
    }
    const entries = await read($, thread)
    const opened = await read($, openPrompts)
    const t = Math.max(await read($, now), await $.clock.now())
    const entry = (x: ThreadEntry) => {
      const id = `thread-${x.n}`
      const isOpen = opened.includes(id)
      const asked = oneLine(x.prompt)
      const isLong = asked.length > PROMPT_FOLD
      // Click the prompt to scroll the conversation to it.
      const shown = isOpen ? x.prompt : isLong ? `${asked.slice(0, PROMPT_FOLD)}…` : asked
      const reply = x.answer
        ? x.answer
        : x.isStopped ? '(stopped before an answer)' : '(working…)'
      return (
        <Box key={id} flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={ORANGE} bold>#{x.n} You</Text>
            <Text dimColor> · {span(t - x.promptAt)} ago</Text>
          </Text>
          {x.rowId
            ? (
              <Button key={`jump-${id}`} plain onPress={() => jumpTo($, x.rowId!)}>
                <Text>{shown}</Text>
              </Button>
            )
            : <Text>{shown}</Text>}
          {isLong && (
            <Button
              key={`open-${id}`}
              plain
              label={isOpen ? '▾ Hide the prompt' : '▸ Show the whole prompt'}
              onPress={() => togglePrompt($, id)}
            />
          )}
          <Text wrap="truncate-end">
            <Text color="success" bold>Claude</Text>
            {x.answerAt ? <Text dimColor> · {span(t - x.answerAt)} ago{x.isStopped ? ' · stopped' : ''}</Text> : null}
          </Text>
          <Text dimColor={!x.answer}>{reply}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{plural(entries.length, 'prompt')} in this conversation</Text>
        {entries.length === 0 && <Text dimColor>Nothing typed yet in this conversation.</Text>}
        {entries.map(entry)}
      </Box>
    )
  })
}
