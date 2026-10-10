// Combat actions — attack
const state = require('../core/state')
const { raceAbort, AbortError, stopAll, waitForEventOrTimeout } = require('../core/tick')
const { sendChat, fuzzyMatch, logEvent, recordFailure } = require('../core/utils')
const { logGameEvent } = require('../world/memory')
const { entityTag, tagOf, findTagged } = require('../perception/entityTag')

// Melee damage per second (damage × attacks/s) for weapons pvp swings at full
// cooldown. A bare hand is 1 × 4 = 4; anything below that isn't worth equipping.
const MATERIALS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const SWORD_DMG = { wooden: 4, golden: 4, stone: 5, copper: 5, iron: 6, diamond: 7, netherite: 8 }
const AXE_DMG = { wooden: 7, golden: 7, stone: 9, copper: 9, iron: 9, diamond: 9, netherite: 10 }
const AXE_SPEED = { wooden: 0.8, golden: 1.0, stone: 0.8, copper: 0.8, iron: 0.9, diamond: 1.0, netherite: 1.0 }
const WEAPON_DPS = {}
for (const m of MATERIALS) {
  WEAPON_DPS[`${m}_sword`] = SWORD_DMG[m] * 1.6
  WEAPON_DPS[`${m}_axe`] = AXE_DMG[m] * AXE_SPEED[m]
}

// Hold the highest-DPS weapon in the inventory, if it beats what's in hand.
async function equipBestWeapon(bot) {
  const dps = (item) => (item && WEAPON_DPS[item.name]) || 4
  const best = bot.inventory.items().reduce((a, b) => (dps(b) > dps(a) ? b : a), null)
  if (!best || dps(best) <= dps(bot.heldItem)) return
  try { await raceAbort(bot.equip(best, 'hand'), 5000) } catch (e) {
    if (e instanceof AbortError) throw e
    console.log(`  equip ${best.name} failed: ${e.message}`)
  }
}

// A shield in the inventory goes to an empty off-hand; rangedDefense raises it.
async function equipShield(bot) {
  if (bot.inventory.slots[45]) return
  const shield = bot.inventory.items().find(i => i.name === 'shield')
  if (!shield) return
  try { await raceAbort(bot.equip(shield, 'off-hand'), 5000) } catch (e) {
    if (e instanceof AbortError) throw e
    console.log(`  equip shield failed: ${e.message}`)
  }
}

async function doAttack(targetName) {
  stopAll()
  const bot = state.bot
  const normalized = targetName.toLowerCase().replace(/s$/, '')
  state.currentTask = `attacking ${targetName}`

  // 'cow#a3f9' names one animal; a bare 'cow' means the nearest one.
  const entity = tagOf(targetName) ? findTagged(targetName) : bot.nearestEntity(e => {
    const eName = (e.name || '').toLowerCase()
    const eUser = (e.username || '').toLowerCase()
    return (eName && (fuzzyMatch(eName, normalized))) ||
           (eUser && (fuzzyMatch(eUser, normalized)))
  })

  if (!entity) { sendChat(`No ${targetName} nearby!`); recordFailure(`attack:${targetName} - none nearby`); state.currentTask = null; return false }
  const label = entityTag(entity)
  console.log(`  found ${label} dist=${Math.round(bot.entity.position.distanceTo(entity.position))}`)

  let killed = false
  let timedOut = false
  let waiter = null
  try {
    await equipBestWeapon(bot)
    await equipShield(bot)
    bot.pvp.attack(entity)
    // Wait until pvp reports it stopped attacking this target, or 30s; the timeout
    // stops the attack. stopAll() above didn't await pvp.stop(), so the previous
    // attack's stoppedAttacking can still arrive: it names that attack's target.
    waiter = waitForEventOrTimeout(bot, 'stoppedAttacking', 30000, () => { timedOut = true; bot.pvp.stop() }, (target) => target === entity)
    await raceAbort(waiter, 30000)
    if (!entity.isValid && require('../engine/creeperDefense').didExplode(entity)) {
      console.log('  exploded'); logEvent(`attack: ${label} exploded`)
      killed = true   // the threat is gone, though not by our hand
    } else if (!entity.isValid) {
      const pos = entity.position
      logGameEvent('kill', entity.name || entity.username, 1, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), { weapon: bot.heldItem?.name || 'hand', tag: label, uuid: entity.uuid })
      console.log('  killed!'); logEvent(`attack: killed ${label}`); sendChat('Got it!')
      killed = true
    }
    else {
      console.log('  stopped attacking')
      const d = bot.entity.position.distanceTo(entity.position).toFixed(1)
      recordFailure(`attack:${targetName} - ${timedOut ? 'still alive after 30s of fighting' : 'gave up the chase (lost the target or no path to it)'}, ${label} ${d}m away`)
    }
  } catch (err) {
    if (err instanceof AbortError) { bot.pvp.stop(); throw err }
    else { console.error('  pvp err:', err.message); recordFailure(`attack:${targetName} - ${err.message}`) }
  } finally {
    if (waiter) waiter.cancel()
    // pvp raises the shield after every swing and never lowers it when the fight
    // ends: left up, it slows every step and the bot walks around blocking.
    // (bot.usingHeldItem can't tell: mineflayer clears it on any entity_status.)
    // Not while the creeper reflex holds it against a fuse.
    if (bot.inventory.slots[45]?.name === 'shield' && !state.creeperReflex) bot.deactivateItem()
  }
  state.currentTask = null
  // Success = the target actually died. Stopping/timing out without a kill is not "done".
  return killed
}

module.exports = { doAttack }
