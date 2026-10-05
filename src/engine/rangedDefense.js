// rangedDefense.js — reflexes against archers (skeletons, strays, bogged, pillagers).
//
// An archer's draw shows in its living_entity_flags (bit 0x01, "hand active"): on
// for ~1s before the arrow leaves, off at release. That second is the window — far
// too short for a model turn, so this runs on physicsTick:
//   - shield in the off-hand: face the archer and raise it for the draw, lower it
//     once the arrow has landed. In melee mineflayer-pvp owns the shield (it drops
//     it for each swing and raises it after), so with a pvp target we only raise;
//   - no shield: sidestep across the line of fire just before the release.
const state = require('../core/state')

const ARCHERS = new Set(['skeleton', 'stray', 'bogged', 'pillager'])
const THREAT_RANGE = 24
const SHIELD_HOLD_MS = 400   // keep the shield up this long after the draw ends (arrow flight)
// An arrow flies at where the bot is at release (~950ms into the draw): be moving
// across the line by then and keep moving through the flight.
const DODGE_AFTER_MS = 700
const DODGE_MS = 600
const SUMMARY_AFTER_MS = 3000  // journal an archer's tally once it hasn't drawn for this long

function drawing(bot, e) {
  const idx = bot.registry.entitiesByName[e.name]?.metadataKeys?.indexOf('living_entity_flags')
  return idx >= 0 && ((e.metadata?.[idx] || 0) & 1) === 1
}

// Nearest archer in line of sight; drawingOnly limits it to one mid-draw.
function nearestArcher(bot, range = THREAT_RANGE, drawingOnly = false) {
  const pos = bot.entity.position
  const eye = pos.offset(0, 1.62, 0)
  const { hasLineOfSight } = require('../perception/vision')
  return bot.nearestEntity(e =>
    ARCHERS.has(e.name) &&
    e.position.distanceTo(pos) < range &&
    (!drawingOnly || drawing(bot, e)) &&
    hasLineOfSight(eye, e.position, e.height || 1.8)
  )
}

function setupRangedDefense() {
  const bot = state.bot
  let raised = false, lastThreatAt = 0
  const drawSeen = new Map()   // archer id → ms its current draw started (-1: dodged)
  let dodgeUntil = 0, dodgeDir = 'left'
  // Per archer: how often we answered its draws. One journal record per encounter,
  // not one per arrow.
  const tally = new Map()   // id → { tag, shield, dodge, last }
  const count = (e, kind) => {
    const t = tally.get(e.id) || { tag: require('../perception/entityTag').entityTag(e), shield: 0, dodge: 0 }
    t[kind]++; t.last = Date.now(); tally.set(e.id, t)
  }
  const flushTally = (now) => {
    for (const [id, t] of tally) {
      if (now - t.last < SUMMARY_AFTER_MS) continue
      tally.delete(id)
      const what = [t.shield && `raised shield ${t.shield}x`, t.dodge && `sidestepped ${t.dodge}x`].filter(Boolean).join(', ')
      require('../core/utils').logEvent(`reflex: ${what} vs ${t.tag}'s arrows`)
    }
  }

  const hasShield = () => bot.inventory.slots[45]?.name === 'shield'
  const face = (e) => bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.85, 0), true).catch(() => {})

  bot.on('physicsTick', () => {
    if (!bot.entity || bot.health <= 0) return
    const now = Date.now()
    if (tally.size) flushTally(now)
    const threat = nearestArcher(bot, THREAT_RANGE, true)
    for (const id of drawSeen.keys()) if (!threat || id !== threat.id) drawSeen.delete(id)
    if (threat) {
      lastThreatAt = now
      if (!drawSeen.has(threat.id)) drawSeen.set(threat.id, now)
    }

    if (hasShield()) {
      // Our own flag, not bot.usingHeldItem: mineflayer clears that on every
      // entity_status packet for any entity, and re-raising restarts the shield's
      // 5-tick warm-up. pvp drops and re-raises it around swings on its own.
      // Not while retreating from a swarm: a raised shield slows the bot to a crawl.
      if (threat && !raised && !state.retreating) {
        // pvp already looks at its own target; turn only if that isn't the archer.
        if (bot.pvp?.target !== threat) face(threat)
        bot.activateItem(true)
        raised = true
        count(threat, 'shield')
        console.log(`  [SHIELD] up vs ${threat.name} at ${threat.position.distanceTo(bot.entity.position).toFixed(1)}m`)
      } else if (raised && now - lastThreatAt > SHIELD_HOLD_MS) {
        if (!bot.pvp?.target && !state.creeperReflex) bot.deactivateItem()   // in melee pvp keeps it up between swings
        raised = false
      }
      return
    }

    // No shield: one sidestep per draw, alternating sides so it isn't predictable.
    if (dodgeUntil && now >= dodgeUntil) {
      bot.setControlState(dodgeDir, false)
      dodgeUntil = 0
    }
    const drawStart = threat ? drawSeen.get(threat.id) : -1
    if (threat && !dodgeUntil && drawStart !== -1 && now - drawStart >= DODGE_AFTER_MS) {
      if (bot.pvp?.target !== threat) face(threat)
      dodgeDir = dodgeDir === 'left' ? 'right' : 'left'
      bot.setControlState(dodgeDir, true)
      dodgeUntil = now + DODGE_MS
      drawSeen.set(threat.id, -1)
      count(threat, 'dodge')
      console.log(`  [DODGE] ${dodgeDir} vs ${threat.name} at ${threat.position.distanceTo(bot.entity.position).toFixed(1)}m`)
    }
  })
}

module.exports = { setupRangedDefense, nearestArcher, ARCHERS }
