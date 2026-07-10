// Core engine loop — non-blocking architecture
// Long-running actions run as detached background tasks so chat is always responsive.
const state = require('../core/state')
const { sleep, stopAll, AbortError } = require('../core/tick')
const { handleMessage, abortResponse } = require('../ai/ai')
const { executeAction } = require('../actions')
const { stackTopTitle, stackTop, stackTitles, saveStack } = require('./tasks')
const { launchBackground, isBackgroundRunning, consumeBackgroundResult } = require('./backgroundTask')
const { preCheck } = require('./guard')
const { FOOD_STARVING } = require('../config/safety')
const { c, color } = require('../lib/colors')

const TICK_MS = 100
const COOLDOWN = 5000          // ms between autonomous mainLoop triggers
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
function interrupt() {
  state.abortSignal = true
  state.interrupted = true
  state.actionQueue = []
  stopAll()
  abortResponse()  // cancel in-flight AI response (keeps persistent process alive)
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
  state.lastActionUsername = next.username
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
  // First idle tick after work ended (or on spawn): announce once, then go quiet.
  if (!state.idleAnnounced) return 'going-idle'
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

// --- Main autonomous loop (work on task stack) ---
async function mainLoop(wasInterrupted) {
  const bot = state.bot
  state.loopRunning = true

  // Back off on repeated API failures
  if (state.apiFailCount >= 3) {
    const delaySec = Math.min(state.apiFailCount * 30, 300)
    console.log(`  [API] skipping loop, retrying in ${delaySec}s (fail #${state.apiFailCount})`)
    state.loopRunning = false
    setTimeout(() => { state.apiFailCount = Math.max(state.apiFailCount - 1, 0) }, delaySec * 1000)
    return
  }

  try {
    const username = state.lastActionUsername || 'self'

    // Auto-pop time-sensitive tasks when conditions change
    const isDay = bot.time.timeOfDay < 12000
    while (state.taskStack.length > 0) {
      const top = state.taskStack[state.taskStack.length - 1]
      const nightTask = /survive.*night|shelter.*night|hide.*night|wait.*morning|night.*safe/i.test(top.t)
      if (nightTask && isDay) {
        state.taskStack.pop()
        saveStack()
        const { logTaskAction } = require('../world/memory')
        logTaskAction('auto-pop', top.t, 'daytime', state.taskStack.map(e => e.t).join(' > ') || '(empty)')
        console.log(`  [STACK] auto-popped "${top.t}" (it's daytime now)`)
      } else break
    }

    const topTitle = stackTopTitle()

    // If stack is empty, report and go idle
    if (!topTitle) {
      console.log(color(c.yellow, '\n  [LOOP] stack empty, reporting and going idle'))
      await handleMessage('self',
        `[SELF-CHECK] stack=empty`,
        username)
      state.loopRunning = false
      return
    }

    // Stuck detection
    if (state.noActionRounds >= MAX_NO_ACTION) {
      console.log(color(c.yellow, '\n  [LOOP] stuck 3x — reporting to player'))
      state.noActionRounds = 0
      const top = stackTop()
      const taskDesc = top.d ? `"${top.t}" (${top.d})` : `"${top.t}"`
      await handleMessage('self',
        `[SELF-CHECK] stuck=${taskDesc}`,
        username)
      state.loopRunning = false
      return
    }

    const top = stackTop()
    const taskDesc = top.d ? `"${top.t}" (${top.d})` : `"${top.t}"`
    console.log(color(c.white, `\n  [LOOP] working on: ${taskDesc} (stack depth: ${state.taskStack.length}, idle rounds: ${state.noActionRounds})`))
    const beforeQLen = state.actionQueue.length
    await handleMessage('self',
      `[SELF-CHECK] task=${taskDesc}`,
      username)

    // Check if Claude actually produced actions
    if (state.actionQueue.length === beforeQLen) {
      state.noActionRounds++
      console.log(color(c.yellow, `\n  [LOOP] no actions produced (round ${state.noActionRounds}/${MAX_NO_ACTION})`))
      state.loopRunning = false
      return
    }

    state.noActionRounds = 0

  } catch (err) {
    console.error('  [LOOP] error:', err.message)
  }

  state.loopRunning = false
}

// --- Monitor mode: AI observes while actions are running ---
async function monitorLoop() {
  const username = state.lastActionUsername || 'self'
  state.loopRunning = true
  try {
    const { getBackgroundSummary } = require('./backgroundTask')
    const summary = getBackgroundSummary() || 'running'
    const queueLen = state.actionQueue.length
    console.log(color(c.white, `\n  [MONITOR] actions active: ${summary}, queue: ${queueLen}`))
    const beforeQLen = state.actionQueue.length
    await handleMessage('self',
      `[MONITOR] task=${summary} queue=${queueLen}`,
      username)
    // Don't increment noActionRounds in monitor mode — no-action is expected
  } catch (err) {
    console.error('  [MONITOR] error:', err.message)
  }
  state.loopRunning = false
}

// --- Core engine loop ---
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
    const wasInterrupted = state.interrupted
    state.interrupted = false

    // Skip only if mid-API-call (never skip for background tasks)
    if (state.msgPending) continue

    try {
      // Priority 1: Chat/event messages — process all queued messages
      if (state.messageQueue.length > 0) {
        state.msgPending = true
        try {
          while (state.messageQueue.length > 0) {
            const msg = state.messageQueue.shift()
            await handleMessage(msg.username, msg.message, msg.historyAs)
          }
        } finally {
          state.msgPending = false
        }
      }

      // Priority 2: Harvest completed background task result
      const bgResult = consumeBackgroundResult()
      if (bgResult) {
        console.log(color(c.white, `  [BG] finished: ${bgResult.actionStr} → ${bgResult.status}${bgResult.error ? ': ' + bgResult.error : ''} (${Math.round((Date.now() - bgResult.startedAt) / 1000)}s)`))
      }

      // Priority 2.5: No-progress watchdog — kill a travel task wedged with zero progress
      checkWatchdog()

      // Priority 3: Process action queue (launch next if no bg running)
      processActionQueue()

      // Priority 4: Autonomous loop — MONITOR while actions run, SELF-CHECK when there's a
      // goal, and when fully idle call the model ONLY if idleWakeReason finds a real signal
      // (threat, critical status, finished task, or the one-shot going-idle report). An empty
      // stack with nothing running, no chat, and nothing wrong burns zero model calls.
      const actionsRunning = isBackgroundRunning() || state.actionQueue.length > 0
      const hasWork = state.taskStack.length > 0 || actionsRunning
      const canRun = state.apiFailCount < 3 && !state.msgPending
      if (hasWork) {
        state.idleAnnounced = false  // re-arm the one-shot idle report for when work ends
        if (canRun) {
          if (actionsRunning) {
            await monitorLoop()
          } else {
            state.abortSignal = false
            await mainLoop(wasInterrupted)
            processActionQueue()
          }
        }
      } else if (canRun) {
        const wake = idleWakeReason(bgResult)
        if (wake) {
          state.idleAnnounced = true
          console.log(color(c.cyan, `  [LOOP] idle wake: ${wake}`))
          await mainLoop(wasInterrupted)
          processActionQueue()
        }
        // else: nothing to do — skip the model entirely (conservative)
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
