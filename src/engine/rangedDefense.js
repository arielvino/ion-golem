// rangedDefense.js — reflexes against archers: skeletons, strays, bogged, pillagers,
// and players holding a bow or crossbow.
//
// An archer's draw shows in its living_entity_flags (bit 0x01, "hand active"): on
// for ~1s before the arrow leaves, off at release. That second is the window — far
// too short for a model turn, so this runs on physicsTick:
//   - shield in the off-hand: face the archer and raise it for the draw, lower it
//     once the arrow has landed. In melee mineflayer-pvp owns the shield (it drops
//     it for each swing and raises it after), so with a pvp target we only raise;
//   - no shield: juke. Late in the draw, lean sideways; at the release, cut the
//     other way. An archer that leads its target aims where the lean was taking us.
const state = require('../core/state')

const ARCHERS = new Set(['skeleton', 'stray', 'bogged', 'pillager'])
const BOWS = new Set(['bow', 'crossbow'])
const isArcher = (e) => ARCHERS.has(e.name) || (e.type === 'player' && BOWS.has(e.heldItem?.name))
const THREAT_RANGE = 24
const SHIELD_HOLD_MS = 400   // keep the shield up this long after the draw ends (arrow flight)
// A full bow draw is ~1s. Lean from LEAN_AFTER_MS into it, so we're moving sideways
// when the archer takes its aim; at the release cut the other way for CUT_MS (the
// arrow's flight and then some).
const LEAN_AFTER_MS = 500
const CUT_MS = 600
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
    isArcher(e) &&
    e.position.distanceTo(pos) < range &&
    (!drawingOnly || drawing(bot, e)) &&
    hasLineOfSight(eye, e.position, e.height || 1.8)
  )
}

function setupRangedDefense() {
  const bot = state.bot
  let raised = false, lastThreatAt = 0
  const drawSeen = new Map()   // archer id → ms its current draw started
  // The juke: which way we lean ('left'/'right'), then cut. cutUntil = 0: not cutting.
  let lean = null, cut = null, cutUntil = 0, side = 'left'
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
    // Drawing a bow or loading a crossbow: the shield would cancel it and facing
    // would spoil the aim.
    if (state.shooting) { raised = false; return }
    const now = Date.now()
    if (tally.size) flushTally(now)
    const threat = nearestArcher(bot, THREAT_RANGE, true)
    // An archer we saw drawing that no longer is has just loosed (or given up).
    let released = null
    for (const id of drawSeen.keys()) {
      if (threat && id === threat.id) continue
      drawSeen.delete(id)
      released = bot.entities[id] || null
    }
    if (threat) {
      lastThreatAt = now
      if (!drawSeen.has(threat.id)) drawSeen.set(threat.id, now)
    }

    if (hasShield()) {
      // Our own flag, not bot.usingHeldItem: it says whether this reflex raised the
      // shield (so only this reflex lowers it), and usingHeldItem also clears on a
      // main-hand change, where re-raising would restart the 5-tick warm-up.
      // pvp drops and re-raises it around swings on its own.
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

    // No shield: the juke. Lean late in the draw, cut the other way at the release.
    const opposite = (d) => d === 'left' ? 'right' : 'left'
    if (cut && now >= cutUntil) { bot.setControlState(cut, false); cut = null }
    if (threat && !lean && !cut && now - drawSeen.get(threat.id) >= LEAN_AFTER_MS) {
      if (bot.pvp?.target !== threat) face(threat)
      side = opposite(side)   // alternate, so the lean isn't predictable either
      lean = side
      bot.setControlState(lean, true)
    }
    if (released && !cut) {
      // No lean (a short draw): any way across the line beats standing still.
      const dir = lean ? opposite(lean) : (side = opposite(side))
      if (lean) bot.setControlState(lean, false)
      lean = null
      cut = dir
      bot.setControlState(cut, true)
      cutUntil = now + CUT_MS
      count(released, 'dodge')
      console.log(`  [DODGE] juke ${cut} vs ${released.username || released.name} at ${released.position.distanceTo(bot.entity.position).toFixed(1)}m`)
    }
    // The archer stopped without a release we saw (out of sight, gone): stop leaning.
    if (lean && !threat && !released) { bot.setControlState(lean, false); lean = null }
  })
}

module.exports = { setupRangedDefense, nearestArcher, ARCHERS }
