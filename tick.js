// Cooperative yielding primitives — actions use these instead of sleep()
const state = require('./state')

const TICK_MS = 100

class AbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError' }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Single tick: sleep one interval then check abort
async function tick(ms = TICK_MS) {
  await new Promise(r => setTimeout(r, ms))
  if (state.abortSignal) throw new AbortError()
}

// Wait ~ms by calling tick repeatedly (abort-checked at each step)
async function tickWait(ms) {
  const ticks = Math.ceil(ms / TICK_MS)
  for (let i = 0; i < ticks; i++) await tick()
}

// Race a mineflayer async op against abort signal + timeout
async function raceAbort(promise, timeoutMs = 30000) {
  // Suppress unhandled rejection if original promise rejects after race is decided
  // (e.g. mineflayer's "Digging aborted" when stopDigging is called during abort)
  promise.catch(() => {})

  let check = null
  let timer = null

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        check = setInterval(() => {
          if (state.abortSignal) { clearInterval(check); check = null; reject(new AbortError()) }
        }, 200)
        promise.finally(() => { if (check) { clearInterval(check); check = null } })
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => { timer = null; reject(new Error('timeout')) }, timeoutMs)
      })
    ])
  } finally {
    // Always clean up to prevent leaks if promise hangs
    if (check) { clearInterval(check); check = null }
    if (timer) { clearTimeout(timer); timer = null }
  }
}

// Stop all ongoing movement/combat intervals
function stopAll() {
  state.followTarget = null
  if (state.followInterval) { clearInterval(state.followInterval); state.followInterval = null }
  if (state.activeSailTick) { try { clearInterval(state.activeSailTick) } catch(e) {}; state.activeSailTick = null }
  try { state.bot.pvp.stop() } catch (e) {}
  try { state.bot.setControlState('forward', false) } catch (e) {}
  try { state.bot.setControlState('back', false) } catch (e) {}
  try { state.bot.setControlState('left', false) } catch (e) {}
  try { state.bot.setControlState('right', false) } catch (e) {}
  try { state.bot.setControlState('jump', false) } catch (e) {}
  try { state.bot.setControlState('sneak', false) } catch (e) {}
  try { state.bot.setControlState('sprint', false) } catch (e) {}
}

function isAborted() { return state.abortSignal }

// Resolve when `event` fires on the bot, or after `ms`. onTimeout (optional) runs
// on the timeout path before resolving (e.g. to stop an action). The listener and
// timer are cleaned up automatically on natural settle; callers that race this
// against abort (via raceAbort) should also call the returned promise's .cancel()
// in a finally so the abort path doesn't leak the listener/timer. Returns the
// awaitable promise, with a .cancel() method attached.
function waitForEventOrTimeout(bot, event, ms, onTimeout) {
  let timer = null, onEvent = null
  const promise = new Promise((resolve) => {
    onEvent = () => resolve()
    timer = setTimeout(() => { if (onTimeout) onTimeout(); resolve() }, ms)
    bot.once(event, onEvent)
  })
  promise.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (onEvent) { bot.removeListener(event, onEvent); onEvent = null }
  }
  promise.finally(() => promise.cancel())
  return promise
}

module.exports = { tick, tickWait, raceAbort, AbortError, TICK_MS, sleep, stopAll, isAborted, waitForEventOrTimeout }
