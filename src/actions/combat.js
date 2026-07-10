// Combat actions — attack
const state = require('../core/state')
const { raceAbort, AbortError, stopAll, waitForEventOrTimeout } = require('../core/tick')
const { sendChat, fuzzyMatch } = require('../core/utils')
const { logGameEvent } = require('../world/memory')

async function doAttack(targetName) {
  stopAll()
  const bot = state.bot
  const normalized = targetName.toLowerCase().replace(/s$/, '')
  state.currentTask = `attacking ${targetName}`

  const entity = bot.nearestEntity(e => {
    const eName = (e.name || '').toLowerCase()
    const eUser = (e.username || '').toLowerCase()
    return (eName && (fuzzyMatch(eName, normalized))) ||
           (eUser && (fuzzyMatch(eUser, normalized)))
  })

  if (!entity) { sendChat(`No ${targetName} nearby!`); state.currentTask = null; return false }
  const label = entity.username || entity.name
  console.log(`  found ${label} dist=${Math.round(bot.entity.position.distanceTo(entity.position))}`)

  let killed = false
  let waiter = null
  try {
    bot.pvp.attack(entity)
    // Wait until pvp reports it stopped, or 30s; the timeout stops the attack.
    waiter = waitForEventOrTimeout(bot, 'stoppedAttacking', 30000, () => bot.pvp.stop())
    await raceAbort(waiter, 30000)
    if (!entity.isValid) {
      const pos = entity.position
      logGameEvent('kill', entity.name || entity.username, 1, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), { weapon: bot.heldItem?.name || 'hand' })
      console.log('  killed!'); sendChat('Got it!')
      killed = true
    }
    else console.log('  stopped attacking')
  } catch (err) {
    if (err instanceof AbortError) { bot.pvp.stop(); throw err }
    else console.error('  pvp err:', err.message)
  } finally {
    if (waiter) waiter.cancel()
  }
  state.currentTask = null
  // Success = the target actually died. Stopping/timing out without a kill is not "done".
  return killed
}

module.exports = { doAttack }
