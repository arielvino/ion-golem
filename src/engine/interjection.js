// Interjections — short actions that cut into the running task instead of waiting
// behind it. Lighting a dark staircase can't wait for the staircase to end: by then
// the bot is at the bottom and the dark stretch is behind it.
//
// An interjection is an action of an INTERJECTABLE kind that leads its command (no
// other action of the same reply was queued before it) while a task is already
// running. It goes to the head of the queue, flagged, and leaves the queue behind it
// alone: it is a side step, not a new plan. A task with safe points (runStrategy, between
// two steps) runs it there with runInterjections() and goes on where it was. A task
// without one leaves it at the head of the queue, so it runs next.
// Anywhere else in a command it is an ordinary action: in "staircase, then torch" the
// torch goes up at the bottom.
const state = require('../core/state')
const { normalizeItemName } = require('../core/utils')
const { c, color } = require('../lib/colors')

const LIGHT_ITEMS = new Set(['glowstone', 'shroomlight', 'end_rod'])
const isLightItem = (name) => /(torch|lantern)$/.test(name) || LIGHT_ITEMS.has(name)

// place:<light source>[:X,Y,Z], a single action (not a fallback chain).
function isInterjectable(actionStr) {
  if (actionStr.includes('|')) return false
  const [verb, item] = actionStr.split(':')
  return verb === 'place' && !!item && isLightItem(normalizeItemName(item))
}

// Queues `entry` as an interjection when it is one, returns whether it did. `leading`:
// nothing of the same command was queued before it.
function queueInterjection(entry, leading) {
  const { isBackgroundRunning } = require('./backgroundTask')
  if (!leading || !isBackgroundRunning() || !isInterjectable(entry.actionStr)) return false
  const at = state.actionQueue.findIndex(a => !a.interject)
  state.actionQueue.splice(at === -1 ? state.actionQueue.length : at, 0, { ...entry, interject: true })
  console.log(color(c.green, `\n  -> interjection: ${entry.actionStr} (cuts into ${state.backgroundTask.actionStr})`))
  return true
}

// A running task's safe point: runs the interjections waiting at the head of the queue.
// Returns the ms they took, for the task to add to its deadline. An abort propagates.
async function runInterjections() {
  if (!state.actionQueue[0]?.interject) return 0
  const { executeAction } = require('../actions')
  const started = Date.now()
  const task = state.currentTask
  while (state.actionQueue[0]?.interject && !state.abortSignal) {
    const { actionStr, username } = state.actionQueue.shift()
    console.log(color(c.white, `  [INTERJECT] ${actionStr} into ${state.backgroundTask?.actionStr}`))
    await executeAction(actionStr, username)
  }
  state.currentTask = task
  return Date.now() - started
}

module.exports = { isInterjectable, queueInterjection, runInterjections }
