// holdMode.js — a hold: the bot stops and stays put until a player lets it go on.
//
// Set by [ACTION:hold] (a player said "stop and wait"); released by [ACTION:resume] or
// by any other action from the model, since acting is no longer waiting. While held the
// engine raises no SELF-CHECK or MONITOR turns of its own: the model wakes only for
// player chat, events and real threats (hostiles, low health, drowning, starving), and
// the survival reflexes (fight back, eat, swim up) still run. Not persisted: a restart
// ends the hold.
const state = require('../core/state')

function isHeld() { return !!state.hold }

function hold(by) {
  state.hold = { by, at: Date.now() }
  console.log(`  [HOLD] on (asked by ${by})`)
}

function release(why) {
  if (!state.hold) return
  console.log(`  [HOLD] off (${why}) after ${Math.round((Date.now() - state.hold.at) / 1000)}s`)
  state.hold = null
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  return state.hold ? ` HOLD=${state.hold.by}` : ''
}

module.exports = { isHeld, hold, release, contextLine }
