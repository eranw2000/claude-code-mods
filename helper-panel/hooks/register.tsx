import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  AgentSpawnResult,
  EngineInterface,
  ModelEffort,
  ModelForkResult,
  PluginOptions,
  Register,
  TurnCompleteInput,
} from 'claude-code'

import type { AskEntry, AskKind } from '../types'

// The Helper pane: a box over this conversation that answers and acts. Each question is
// answered by a fork of the session's own transcript ($.model.fork), so the
// model sees everything said so far, and neither the question nor the answer
// enters the conversation: they live here alone.
//
// A line starting with "!" is a request to act. It goes to a helper of type
// `fork` ($.agent.spawn): that helper inherits the conversation and its tools,
// runs in the background under the session's own permission rules and hooks,
// and its report arrives as its own turn.complete. A helper a mod starts adds
// no notification or row to the main conversation.
const PANE = 'helper-panel'
const entries = atom({ plugin: 'helper-panel', key: 'entries' } as const, [] as AskEntry[], {
  shape: 'entries-1',
})
const sessionId = atom({ plugin: 'helper-panel', key: 'sessionId' } as const, '')
const gen = atom({ plugin: 'helper-panel', key: 'gen' } as const, 0)
const now = atom({ plugin: 'helper-panel', key: 'now' } as const, 0)
// The pane opens by itself once per conversation (at the process start, or on
// the conversation's first prompt), never again on a reload: a reload runs
// session.start again, and a pane opened then would come in front of Agents.
const hasOpened = atom({ plugin: 'helper-panel', key: 'hasOpened' } as const, false)
// The main loop's newest reply, handed to the fork until the next prompt
// carries it in the transcript.
const lastAnswer = atom({ plugin: 'helper-panel', key: 'lastAnswer' } as const, '')

// The pane keeps this many questions, and this much of a question, of an
// answer, and of the newest reply handed to the fork.
const KEEP = 50
const QUESTION_KEEP = 2000
const ANSWER_KEEP = 8000
const REPLY_KEEP = 6000
// How much of a request names its helper in the Agents pane.
const DESCRIPTION_KEEP = 60
// The "thinking" clock moves on every second while a question is out.
const TICK_MS = 1000
// While a helper works, every this many ticks the pane checks it still exists.
const WATCH_EVERY = 5
const ORANGE = '#d9734e'
const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// What goes in front of the question. The fork has no tools, and the main
// work must not be picked up by it.
const LEAD =
  'A side question about this conversation so far, typed into a side pane. ' +
  'Answer it from what is in the conversation, briefly and plainly, in the language of the question. ' +
  'You have no tools here and nothing to do but answer: do not start, continue or promise any work. ' +
  'If what was typed asks for something to be done (a change, a fix, a command to run, something to create or send) ' +
  'rather than a question to answer, reply with exactly one line starting with PROPOSE: and then, in plain words and ' +
  'the language of the question, what would be done. The pane then offers a button that does it.\n\n' +
  'Question: '
// How an answer offers work: at its very start, so a word inside an answer is
// never taken for an offer.
const OFFER = /^PROPOSE:\s*/
// What goes in front of a request. The helper has tools, so it is held to the
// one thing that was typed, and the main work stays with the main thread.
const DO_LEAD =
  'A request typed into a side pane by the person you work for. ' +
  'Carry it out now with your tools, using what is in this conversation. ' +
  'Do only what this request asks: do not continue or pick up the main work. ' +
  'When it is done, report in a few plain lines, in the language of the request: what you did, and anything you could not do.\n\n' +
  'Request: '
const REPLY_LEAD =
  '\n\nThe newest reply of this conversation, which may be missing from what you can see above:\n'

let ticker: { cancel: () => void } | undefined
let ticks = 0
// Goes up on every clear (the button, /clear, a resume), synchronously, so a
// question whose submit was already running inserts and asks nothing after it.
let epoch = 0
// Goes up only when the conversation changes (/clear, a resume). A request to
// act answers to this one until its helper has been asked for, and not after:
// the engine keeps a helper running through a /clear, so a request is only
// ever cancelled before that.
let convo = 0
// Makes each entry's id unique within this module's life; askedAt covers a reload.
let made = 0
// Requests whose helper id is not on their entry yet, and what a helper reported
// in that time.
let spawning = 0
const early = new Map<string, TurnCompleteInput>()
// Helpers whose line a /clear took away, by agentId. The helper runs on, and the
// engine empties the saved list at a /clear, so the line waits here, in memory,
// for the report to bring it back.
const carried = new Map<string, AskEntry>()
// Each drawn Input is sent once. A sent field gets a new key, and the keys count
// as new again after a /clear, when the engine restarts the counter.
const consumed = new Set<string>()

// A cut that keeps a text within a length: the text, or its head and an ellipsis.
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

// A span as the status line writes it: 4s, 1m05s.
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

// The effort the manifest's picker chose; "session" (or anything else) names
// none, so the fork thinks as hard as the session does and costs no cache write.
function effortOf(options: PluginOptions): ModelEffort | undefined {
  const picked = options.effort
  return EFFORTS.find(level => level === picked)
}

// What a settled fork leaves on its entry.
function settle(entry: AskEntry, r: ModelForkResult | undefined, doneAt: number, failure: string): AskEntry {
  if (r?.isAnswered) {
    const text = r.text.trim()
    const offered = text.replace(OFFER, '').trim()
    const canDo = OFFER.test(text) && offered !== ''
    return {
      ...entry,
      status: 'answered',
      answer: fit(canDo ? offered : text, ANSWER_KEEP),
      ...(canDo ? { canDo: true } : {}),
      doneAt,
      outputTokens: r.usage.output_tokens,
      cacheReadTokens: r.usage.cache_read_input_tokens,
    }
  }
  let note = failure
  if (r && !r.isAnswered) {
    if (r.reason === 'nothing-to-fork') {
      note = 'Nothing to ask about yet: the first turn of this conversation has not finished.'
    } else if (r.reason === 'api-error') {
      note = `The API answered with an error (${r.status}, ${r.error}). Try again.`
    } else if (r.reason === 'empty-reply') {
      note = 'The model sent back no text. Try again.'
    } else {
      note = 'The call was cut short before an answer came.'
    }
  }
  return { ...entry, status: 'failed', doneAt, note }
}

// A request whose helper has not reported. Entries with no kind are questions.
function isHelperOut(x: AskEntry): boolean {
  return x.kind === 'do' && x.status === 'asking'
}

// What a helper's end leaves on its entry.
function settleHelper(entry: AskEntry, e: TurnCompleteInput, doneAt: number): AskEntry {
  const { closedByWatch: _reopened, ...open } = entry
  if (e.reason === 'answer') {
    return {
      ...open,
      status: 'answered',
      answer: fit(e.answer.trim(), ANSWER_KEEP),
      doneAt,
      outputTokens: e.usage?.output_tokens ?? 0,
      cacheReadTokens: e.usage?.cache_read_input_tokens ?? 0,
    }
  }
  const note =
    e.reason === 'aborted'
      ? 'The helper was stopped before it finished. Look in the Agents tab for what it did.'
      : e.reason === 'refusal'
        ? 'The model refused this request.'
        : 'The helper hit an API error before it finished. Look in the Agents tab for what it did.'
  return { ...open, status: 'failed', doneAt, note }
}

// A helper's end: its report goes on its entry, also on one the check below had
// closed. Unmatched while a start is out, it may be that start's helper, so it is
// held for the id. Exported for the tests.
export async function finishHelper($: EngineInterface, e: TurnCompleteInput) {
  const doneAt = await $.clock.now()
  const lost = e.agentId ? carried.get(e.agentId) : undefined
  await update($, entries, list => {
    let matched = false
    const next = list.map(x => {
      if (x.agentId !== e.agentId || !(isHelperOut(x) || x.closedByWatch)) return x
      matched = true
      return settleHelper(x, e, doneAt)
    })
    if (matched) return next
    if (lost) return withinLimit([...next, settleHelper(lost, e, doneAt)])
    // Held inside the write, so the holding agrees with the list it saw.
    if (spawning > 0 && e.agentId) early.set(e.agentId, e)
    return next
  })
  if (e.agentId) carried.delete(e.agentId)
}

// Marks a helper as stopped when it ended with no report. Only the helpers known
// before the list was read are judged, as a newer one is not in it.
export async function closeGone($: EngineInterface) {
  const before = await read($, entries)
  const sampled = new Set(before.filter(isHelperOut).flatMap(x => (x.agentId ? [x.agentId] : [])))
  let agents: AgentInfo[]
  try {
    agents = await $.agent.list()
  } catch {
    return
  }
  const ended: readonly string[] = ['completed', 'failed', 'killed']
  const live = new Set(agents.filter(a => !ended.includes(a.status)).map(a => a.id))
  const doneAt = await $.clock.now()
  await update($, entries, list =>
    list.map(x =>
      isHelperOut(x) && x.agentId && sampled.has(x.agentId) && !live.has(x.agentId)
        ? {
            ...x,
            status: 'failed' as const,
            closedByWatch: true,
            doneAt,
            note: 'The helper stopped before it sent a report. Look in the Agents tab for what it did.',
          }
        : x,
    ),
  )
}

// The list's limit counts finished lines only: a helper still working keeps its
// place, or its report would have nowhere to land.
function withinLimit(list: AskEntry[]): AskEntry[] {
  let extra = list.length - KEEP
  return list.filter(x => {
    if (extra <= 0 || isHelperOut(x)) return true
    extra -= 1
    return false
  })
}

function tick($: EngineInterface) {
  void (async () => {
    const list = await read($, entries)
    if (!list.some(x => x.status === 'asking')) {
      ticker?.cancel()
      ticker = undefined
      return
    }
    await update($, now, () => Date.now())
    ticks += 1
    if (ticks % WATCH_EVERY === 0 && list.some(x => isHelperOut(x) && x.agentId)) await closeGone($)
  })()
}

function wake($: EngineInterface) {
  if (!ticker) ticker = $.clock.every(TICK_MS, () => tick($))
}

// The prompt the fork gets: the lead, the question, and the newest reply when
// the transcript the fork reads does not carry it yet.
function forkPrompt(question: string, reply: string): string {
  return LEAD + question + (reply ? REPLY_LEAD + reply : '')
}

// The helper's first turn: the lead, the request, and the newest reply as a
// question gets it.
function doPrompt(request: string, reply: string): string {
  return DO_LEAD + request + (reply ? REPLY_LEAD + reply : '')
}

// What a line asks for: "!" in front is a request to act, the rest a question.
function parseLine(text: string): { kind: AskKind; body: string } {
  const line = text.trim()
  return line.startsWith('!') ? { kind: 'do', body: line.slice(1).trim() } : { kind: 'ask', body: line }
}

function current(kind: AskKind): number {
  return kind === 'do' ? convo : epoch
}

// Puts a new entry on the list and returns it; undefined when a clear got there
// first. `typed` is a line sent from the box: the Do it button sends none, so the
// box keeps what is being typed in it.
async function begin($: EngineInterface, body: string, kind: AskKind, typed: boolean): Promise<AskEntry | undefined> {
  const mine = current(kind)
  const askedAt = await $.clock.now()
  made += 1
  const id = `${askedAt}-${made}`
  // Always for a typed line, even one a clear is about to drop: the field gets a
  // new key, so a dropped line cannot leave the box refusing what is typed next.
  if (typed) await update($, gen, n => n + 1)
  if (current(kind) !== mine) return undefined
  const entry: AskEntry = {
    id,
    kind,
    question: fit(body, QUESTION_KEEP),
    askedAt,
    status: 'asking',
    answer: '',
    doneAt: 0,
    note: '',
    outputTokens: 0,
    cacheReadTokens: 0,
  }
  // Checked inside the write, which can run again: a /clear can land during it.
  let placed = false
  await update($, entries, list => {
    placed = current(kind) === mine
    return placed ? withinLimit([...list, entry]) : list
  })
  if (!placed) return undefined
  await update($, now, () => askedAt)
  wake($)
  return entry
}

// Starts a helper on a request. Its report arrives at turn.complete. A /clear or
// a resume before the helper is asked for cancels the request, since a helper
// started after one would read the new, empty chat. From then on the helper runs
// on: a /clear takes its line, and its report brings the line back.
export async function act($: EngineInterface, request: string, typed = true) {
  const mine = convo
  const entry = await begin($, request, 'do', typed)
  if (!entry) return
  const { id } = entry
  const reply = await read($, lastAnswer)
  if (convo !== mine) return
  let started: AgentSpawnResult | undefined
  let failure = ''
  spawning += 1
  try {
    try {
      started = await $.agent.spawn({
        subagentType: 'fork',
        prompt: doPrompt(request, reply ?? ''),
        description: fit(`Helper pane: ${request}`, DESCRIPTION_KEEP),
      })
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
    const startedId = started?.agentId
    if (startedId) {
      let placed = false
      await update($, entries, list => {
        placed = list.some(x => x.id === id)
        return placed ? list.map(x => (x.id === id ? { ...x, agentId: startedId } : x)) : list
      })
      if (!placed) carried.set(startedId, { ...entry, agentId: startedId })
    }
  } finally {
    // Only now: until the id is on the entry, a report can only be held.
    spawning -= 1
  }
  const agentId = started?.agentId
  const reported = agentId ? early.get(agentId) : undefined
  if (agentId) early.delete(agentId)
  if (spawning === 0) early.clear()
  if (!agentId) {
    const doneAt = await $.clock.now()
    const why = started?.deny ?? (failure || 'no helper was started')
    await update($, entries, list =>
      list.map(x => (x.id === id ? { ...x, status: 'failed' as const, doneAt, note: `Could not start: ${why}` } : x)),
    )
    return
  }
  if (reported) await finishHelper($, reported)
}

// The Do it button: the offer is taken in the same write that checks it, so two
// presses start one helper. The line goes to the helper as it was typed.
export async function doIt($: EngineInterface, id: string) {
  const mine = convo
  let line = ''
  await update($, entries, list => {
    line = ''
    return list.map(x => {
      if (x.id !== id || !x.canDo) return x
      line = x.question
      const { canDo: _taken, ...rest } = x
      return rest
    })
  })
  if (line && convo === mine) await act($, line, false)
}

// Sends a typed question to a fork of the conversation and writes what comes
// back under it. A clear while the submit is still starting, or while the
// question is out, drops it: the answer was about the old list.
async function ask($: EngineInterface, question: string, effort: ModelEffort | undefined) {
  const mine = epoch
  const entry = await begin($, question, 'ask', true)
  if (!entry) return
  const { id } = entry

  const reply = await read($, lastAnswer)
  let r: ModelForkResult | undefined
  let failure = ''
  if (epoch !== mine) return
  try {
    const prompt = forkPrompt(question, reply ?? '')
    r = await $.model.fork(effort ? { prompt, effort } : { prompt })
  } catch (err) {
    failure = `Could not ask: ${err instanceof Error ? err.message : String(err)}`
  }
  if (epoch !== mine) return
  const doneAt = await $.clock.now()
  await update($, entries, list => list.map(x => (x.id === id ? settle(x, r, doneAt, failure) : x)))
}

// Enter on the drawn field: each field key is sent once.
export function submit($: EngineInterface, key: string, text: string, effort: ModelEffort | undefined) {
  const { kind, body } = parseLine(text)
  // Nothing to send leaves the field as it was, free to take the next try.
  if (!body || consumed.has(key)) return
  consumed.add(key)
  void (kind === 'do' ? act($, body) : ask($, body, effort))
}

// Opens the pane once per conversation by itself; the command and a person
// open it any time.
async function openOnce($: EngineInterface) {
  let first = false
  await update($, hasOpened, was => {
    first = !was
    return true
  })
  if (first) await $.ui.open({ id: PANE, title: 'Helper' })
}

async function openPane($: EngineInterface) {
  await update($, hasOpened, () => true)
  await $.ui.open({ id: PANE, title: 'Helper' })
}

// The clear button: drops the list, but not work still being done, whose
// report would otherwise have nowhere to land. A question whose submit is
// already running stops at its next check.
async function forget($: EngineInterface) {
  epoch += 1
  await update($, entries, list => list.filter(isHelperOut))
}

// What a new conversation starts from: nothing of the old one stays on the list.
// A helper still at work is remembered, so its report can bring its line back.
// Exported for the tests.
export async function startOver($: EngineInterface) {
  convo += 1
  epoch += 1
  consumed.clear()
  await update($, entries, list => {
    for (const x of list) if (isHelperOut(x) && x.agentId) carried.set(x.agentId, x)
    return []
  })
  await update($, hasOpened, () => false)
  await update($, lastAnswer, () => '')
}

// A question still out when the module reloaded is closed, since its answer
// can no longer arrive. A helper with an agentId lives on and still reports; one
// without is closed and not sent again, so the work is not done twice.
async function closeLost($: EngineInterface) {
  const doneAt = await $.clock.now()
  let helperOut = false
  await update($, entries, list => {
    helperOut = false
    return list.map(x => {
      if (x.status !== 'asking') return x
      if (x.kind !== 'do') {
        return { ...x, status: 'failed' as const, doneAt, note: 'The pane reloaded before the answer came. Ask again.' }
      }
      if (x.agentId) {
        helperOut = true
        return x
      }
      return {
        ...x,
        status: 'failed' as const,
        doneAt,
        note: 'The pane reloaded while this was starting. Check the Agents tab before sending it again.',
      }
    })
  })
  // The reload cancelled the old module's timer.
  if (helperOut) wake($)
}

// A /clear or a resume starts another conversation under a new id. session.end
// resets at once, and this check follows the id. Only the main loop's events ask:
// a helper's hook may read its own id.
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
  if (moved) await startOver($)
}

export const register: Register = (on, options) => {
  // The switches in plugin.json's userConfig.
  const showPane = options.showPane !== false
  const effort = effortOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'helper-panel',
      description: 'Show the Helper pane: a box over this conversation that answers and does work, out of the chat',
    })
    const result = await next(e)
    await fresh($)
    await closeLost($)
    if (showPane) await openOnce($)
    return result
  })

  on('command.run', { command: 'helper-panel' }, async $ => {
    if (!showPane) {
      return { text: 'The Helper pane is switched off. Turn "Show the Helper pane" back on in /config.' }
    }
    await openPane($)
    return { text: 'Helper pane opened.' }
  })

  // A /clear or a resume ends this conversation while the process goes on: drop
  // its questions now, so the pane never shows them in the next one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      try {
        await startOver($)
        // '' is "not known yet": the next event adopts the new id without dropping.
        await update($, sessionId, () => '')
      } catch {}
    }
    return next(e)
  })

  // The owner's prompt: the next request carries the last reply, so the fork
  // no longer needs it; and a conversation whose pane never opened (after a
  // /clear) opens it, before the plugins beneath, so Agents stays the newest.
  on('prompt.submit', async ($, e, next) => {
    await fresh($)
    const kind = e.origin.kind
    if ((kind === 'composer' || kind === 'bridge') && !e.isMeta && e.text.trim()) {
      await update($, lastAnswer, () => '')
      if (showPane) await openOnce($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The main loop's newest reply, kept for the fork until the next prompt.
  on('turn.complete', async ($, e, next) => {
    await fresh($, e.agentId)
    if (!e.agentId) {
      const answer = fit(e.answer.trim(), REPLY_KEEP)
      if (answer) await update($, lastAnswer, () => answer)
    } else {
      await finishHelper($, e)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const list = await read($, entries)
    const n = await read($, gen)
    const at = await read($, now)
    const key = `q-${n}`

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Input
            key={key}
            placeholder="Ask about this chat, or ask for work to be done"
            submitLabel="send"
            rows={2}
            autoFocus
            onSubmit={(value, ev) => submit($, ev.element || key, value, effort)}
          />
        </Box>
        {list.length === 0 && (
          <Box flexDirection="column">
            <Text dimColor>Answers and reports stay here, out of the chat.</Text>
            <Text dimColor>Ask for work and you get a Do it button; start with ! to skip the button.</Text>
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" gap={3}>
            <Text dimColor>Start with ! to skip the Do it button.</Text>
            <Button key="clear" plain dimColor onPress={() => void forget($)}>
              clear answers
            </Button>
          </Box>
        )}
        {[...list].reverse().map(x => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{x.kind === 'do' ? `! ${x.question}` : x.question}</Text>
            {x.status === 'asking' && (
              <Text dimColor>{`${x.kind === 'do' ? 'working' : 'thinking'}… ${span(at - x.askedAt)}`}</Text>
            )}
            {x.status === 'answered' && <Markdown text={x.answer || '(no text)'} />}
            {x.status === 'answered' && x.canDo && (
              <Button key={`do-${x.id}`} onPress={() => void doIt($, x.id)}>
                Do it
              </Button>
            )}
            {x.status === 'answered' && (
              <Text dimColor>
                {span(x.doneAt - x.askedAt)} · {tokens(x.outputTokens)} out · {tokens(x.cacheReadTokens)} from cache
              </Text>
            )}
            {x.status === 'failed' && <Text dimColor>{x.note}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
