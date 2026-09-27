// Core engine loop — non-blocking architecture
// Long-running actions run as detached background tasks so chat is always responsive.
const state = require('../core/state')
const { sleep, stopAll, AbortError } = require('../core/tick')
const { handleMessages, abortResponse } = require('../ai/ai')
const { executeAction } = require('../actions')
const { stackTopTitle, stackTop } = require('./tasks')
const { launchBackground, isBackgroundRunning, consumeBackgroundResult } = require('./backgroundTask')
const { preCheck } = require('./guard')
const { FOOD_STARVING } = require('../config/safety')
const { c, color } = require('../lib/colors')

const TICK_MS = 100
const COOLDOWN = 5000          // ms between ticks (model turns); player chat zeroes it
const MAX_NO_ACTION = 3        // after 3 rounds with no action output, pause

let loopCountdown = 0          // counts down, triggers at 0. Start at 0 = first tick fires on spawn

// No-progress watchdog: force-interrupt a TRAVEL task wedged with zero progress, for hangs
// no one issues `stop` for. Scoped to pure-travel actions (mining/follow/sail legitimately
// idle or dig-in-place). Baseline resets on movement OR alt advance, so it only fires on
// genuine total stall — never on an alternative that just started.
const WATCHDOG_MS = 60000           // travel task stuck this long with no progress → kill
const WATCHDOG_MOVE = 1             // blocks of position delta that count as progress
const TRAVEL_ACTIONS = new Set(['goto', 'goto~', 'goto!', 'digto', 'come', 'swimup'])
let wdBaseline = null               // { task, x, y, z, alt, t }

// --- Hard interrupt: full stop (used for kicks, disconnects, etc.) ---
// keepResponse: a streamed [ACTION:stop] fires this mid-reply — the reply that asked
// for the stop must keep streaming (its later actions are the requeue).
function interrupt({ keepResponse = false } = {}) {
  state.abortSignal = true
  state.interrupted = true
  state.actionQueue = []
  stopAll()
  if (!keepResponse) abortResponse()  // cancel in-flight AI response (keeps persistent process alive)
  try { state.bot.pathfinder.setGoal(null) } catch(e) {}
  try { state.bot.clearControlStates() } catch(e) {}
  // Do NOT fake the bg task's status here. The coroutine is still unwinding; let it report
  // its REAL terminal status when it actually observes abortSignal (bounded by raceAbort,
  // so ~200ms typical). processActionQueue gates the next action on the true
  // isBackgroundRunning(), so faking 'aborted' would re-arm the queue (abortSignal=false)
  // before the old task dies — the requeue race. Truthful status makes stop+requeue safe.
  state.currentTask = null
  loopCountdown = 0  // trigger immediate engine tick
}

// --- Soft interrupt: abort AI response only, preserve running actions/bg tasks ---
// Used for player chat: lets current work continue while freeing the AI provider
// for the player's message. The player's response will override actions if needed.
function softInterrupt() {
  abortResponse()
  loopCountdown = 0
}

// --- Process action queue: launch first action as background, chaining handles the rest ---
function processActionQueue() {
  // Backstop: a `stop` should be intercepted at parse-time (ai.js) and never reach the
  // queue, but if one arrives via another path, preempt it here too. interrupt() leaves
  // the bg task truthfully 'running', so the gate below returns and the remainder
  // dispatches on a later tick once the killed task settles — no re-arm race.
  const stopIdx = state.actionQueue.findIndex(a => a.actionStr.split(':')[0] === 'stop')
  if (stopIdx !== -1) {
    const after = state.actionQueue.slice(stopIdx + 1)
    interrupt()
    state.actionQueue = after
  }
  if (isBackgroundRunning() || state.actionQueue.length === 0) return
  state.abortSignal = false  // clear abort from previous interrupt — new work starts fresh
  const next = state.actionQueue.shift()
  state.consecutivePlaceFails = 0
  console.log(color(c.white, `  [BG] launching: ${next.actionStr}`))
  launchBackground(next.actionStr, next.username, executeAction)
}

// --- No-progress watchdog: self-heal travel hangs the model never sends stop for ---
function checkWatchdog() {
  const t = state.backgroundTask
  if (!t || t.status !== 'running' || !TRAVEL_ACTIONS.has(t.action)) { wdBaseline = null; return }
  const p = state.bot?.entity?.position
  if (!p) return
  const now = Date.now()
  // New task, or position moved, or alternative advanced → (re)set the liveness baseline
  const moved = wdBaseline && Math.hypot(p.x - wdBaseline.x, p.y - wdBaseline.y, p.z - wdBaseline.z) > WATCHDOG_MOVE
  if (!wdBaseline || wdBaseline.task !== t || moved || t.currentAlt !== wdBaseline.alt) {
    wdBaseline = { task: t, x: p.x, y: p.y, z: p.z, alt: t.currentAlt, t: now }
    return
  }
  if (now - wdBaseline.t > WATCHDOG_MS) {
    console.log(color(c.red, `  [WATCHDOG] ${t.action}:${t.target} stuck ${Math.round((now - wdBaseline.t) / 1000)}s, no progress — force interrupt`))
    wdBaseline = null
    interrupt()
  }
}

// --- Idle wake gate: when the bot is fully idle (no goals, no actions, no queued chat),
// decide whether there's any real reason to spend a model call. Returns a short reason
// string to wake, or null to stay silent. This is the heart of conservative AI usage:
// with an empty stack, nothing running, no threats and nothing wrong, we never call Claude.
function idleWakeReason(bgResult) {
  // A background task just finished — let the model see the outcome and decide what's next.
  if (bgResult) return 'task-finished'
  // A [CTX:...] view the model asked for is still queued. renderPending() only runs
  // while building a turn's context, so with an empty stack there is no next turn to
  // deliver it on — the bot promises to look, goes quiet, and the request sits
  // forever. The model asking is itself the signal that a call is worth spending.
  if (state.ctxRequests.length > 0) return 'ctx-pending'
  // Threats / critical self-status — must react even with an empty stack. preCheck encodes
  // the same hostile-scan (range 12), low-health (<=6) and drowning rules nav uses.
  try {
    const check = preCheck({ ignoreMsgs: true })
    if (check) return check.interrupt   // 'hostile' | 'low_health' | 'drowning'
  } catch (e) { /* AbortError mid-idle — nothing to react to */ }
  // Starving: food at 0 means health will start ticking down — wake to eat.
  if (state.bot?.food === FOOD_STARVING) return 'starving'
  return null
}

// --- The autonomous line: what the bot's own state asks of this turn ---
// MONITOR while actions run, SELF-CHECK on the focused goal, and when fully idle
// only if idleWakeReason finds a real signal. null = nothing of our own to raise.
function autonomousLine(bgResult) {
  const actionsRunning = isBackgroundRunning() || state.actionQueue.length > 0
  if (actionsRunning) {
    const { getBackgroundSummary } = require('./backgroundTask')
    const summary = getBackgroundSummary() || 'running'
    const queueLen = state.actionQueue.length
    console.log(color(c.white, `\n  [MONITOR] actions active: ${summary}, queue: ${queueLen}`))
    return { kind: 'monitor', line: `[MONITOR] task=${summary} queue=${queueLen}` }
  }
  if (stackTopTitle()) {
    const top = stackTop()
    const taskDesc = top.d ? `"${top.t}" (${top.d})` : `"${top.t}"`
    if (state.noActionRounds >= MAX_NO_ACTION) {
      console.log(color(c.yellow, '\n  [LOOP] stuck 3x — reporting to player'))
      state.noActionRounds = 0
      return { kind: 'stuck', line: `[SELF-CHECK] stuck=${taskDesc}` }
    }
    console.log(color(c.white, `\n  [LOOP] working on: ${taskDesc} (path depth: ${state.taskStack.length}, idle rounds: ${state.noActionRounds})`))
    return { kind: 'task', line: `[SELF-CHECK] task=${taskDesc}` }
  }
  const wake = idleWakeReason(bgResult)
  if (!wake) return null
  console.log(color(c.cyan, `  [LOOP] idle wake: ${wake}`))
  return { kind: 'idle', line: '[SELF-CHECK] agenda=idle' }
}

// --- Core engine loop ---
// One tick = at most ONE model turn, carrying everything pending at once: queued
// chat and events plus the bot's own autonomous line. Ticks are COOLDOWN apart;
// player chat zeroes the countdown (softInterrupt) so it is answered at once.
async function startEngine() {
  if (state.engineRunning) return
  state.engineRunning = true
  console.log('  [ENGINE] started (non-blocking)')

  while (state.engineRunning) {
    await sleep(TICK_MS)
    loopCountdown -= TICK_MS
    if (loopCountdown > 0) continue

    // === TICK FIRES ===
    loopCountdown = COOLDOWN
    state.interrupted = false

    try {
      // Bookkeeping first, so the turn sees the current state.
      const bgResult = consumeBackgroundResult()
      if (bgResult) {
        console.log(color(c.white, `  [BG] finished: ${bgResult.actionStr} → ${bgResult.status}${bgResult.error ? ': ' + bgResult.error : ''} (${Math.round((Date.now() - bgResult.startedAt) / 1000)}s)`))
      }
      checkWatchdog()
      processActionQueue()

      if (state.aiPaused) continue
      // Back off on repeated API failures
      if (state.apiFailCount >= 3) {
        const delaySec = Math.min(state.apiFailCount * 30, 300)
        console.log(`  [API] skipping turn, retrying in ${delaySec}s (fail #${state.apiFailCount})`)
        loopCountdown = delaySec * 1000
        state.apiFailCount = Math.max(state.apiFailCount - 1, 0)
        continue
      }

      const messages = state.messageQueue.splice(0)
      const own = autonomousLine(bgResult)
      if (!messages.length && !own) continue  // nothing to say: no model call
      const batch = own ? [...messages, { username: 'self', message: own.line }] : messages
      const fromPlayer = messages.some(m => m.username !== 'self' && m.username !== 'event')

      const beforeActionOps = state.actionOpCount
      const beforePlanOps = state.planOpCount
      // A turn answering a player isn't aborted by more chat; a self-only turn is.
      state.msgPending = fromPlayer
      let result
      try {
        result = await handleMessages(batch)
      } finally {
        state.msgPending = false
      }
      if (result === 'aborted') {
        // Chat cut in: requeue what this turn carried; the next tick runs it all again.
        state.messageQueue.unshift(...messages)
        continue
      }
      processActionQueue()

      // Progress = emitted actions or a plan edit. A turn that only decomposes a
      // goal or picks a strategy is real work, not a stall. Counted, not measured off
      // the queue length: streamed actions launch (and leave the queue) mid-reply.
      if (own?.kind === 'task' && !fromPlayer) {
        if (state.actionOpCount === beforeActionOps && state.planOpCount === beforePlanOps) {
          state.noActionRounds++
          console.log(color(c.yellow, `\n  [LOOP] no actions or plan edits (round ${state.noActionRounds}/${MAX_NO_ACTION})`))
        } else {
          state.noActionRounds = 0
        }
      }
    } catch (err) {
      console.error(color(c.red, `[ENGINE] tick error: ${err.message}`))
    }
  }

  console.log('  [ENGINE] stopped')
}

function stopEngine() {
  state.engineRunning = false
}

module.exports = { startEngine, stopEngine, interrupt, softInterrupt, processActionQueue }
