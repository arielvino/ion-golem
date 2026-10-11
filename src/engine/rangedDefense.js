// rangedDefense.js — reflexes against archers: skeletons, strays, bogged, pillagers,
// and players holding a bow, crossbow or trident.
//
// An archer's draw shows in its living_entity_flags (bit 0x01, "hand active"): on
// for ~1s before the arrow leaves, off at release. That second is the window — far
// too short for a model turn, so this runs on physicsTick:
//   - shield in the off-hand: face the archer and raise it for the draw, lower it
//     once the arrow has landed. In melee mineflayer-pvp owns the shield (it drops
//     it for each swing and raises it after), so with a pvp target we only raise;
//   - no shield: juke. Late in the draw, lean sideways; just before the release is
//     due, cut the other way. An archer that leads its target aims where the lean
//     was taking us. Up close the shot lands within a tick of the release, so
//     waiting to see it is too late: the cut goes on the draw's clock.
const state = require('../core/state')

const ARCHERS = new Set(['skeleton', 'stray', 'bogged', 'pillager'])
const BOWS = new Set(['bow', 'crossbow', 'trident'])
const isArcher = (e) => ARCHERS.has(e.name) || (e.type === 'player' && BOWS.has(e.heldItem?.name))
const THREAT_RANGE = 24
const SHIELD_HOLD_MS = 400   // keep the shield up this long after the draw ends (arrow flight)
// Per weapon, ms after we see the draw start: lean from `lean`, so we're moving
// sideways when the archer takes its aim; cut the other way at `cut`, just before
// the release is due, or at the release if we see it first. A full bow draw is 20
// ticks; a trident throws after 10. A crossbow's draw is its loading, and the shot
// comes whenever its holder likes after that: no clock, cut at the release.
// The cut lasts CUT_MS (the flight and then some). A lean lasts at least
// LEAN_HOLD_MS before its cut. A draw that's past its cut, held or turned on us
// late, gets cut after cut: the release may come any tick.
const JUKE = {
  bow: { lean: 500, cut: 850 },
  trident: { lean: 100, cut: 400 },
  crossbow: { lean: 500, cut: null }
}
const MOB_WEAPON = { skeleton: 'bow', stray: 'bow', bogged: 'bow', pillager: 'crossbow' }
const jukeTiming = (e) => JUKE[e.type === 'player' ? e.heldItem?.name : MOB_WEAPON[e.name]] || JUKE.bow
const LEAN_HOLD_MS = 250
const CUT_MS = 600
const SUMMARY_AFTER_MS = 3000  // journal an archer's tally once it hasn't drawn for this long

function drawing(bot, e) {
  const idx = bot.registry.entitiesByName[e.name]?.metadataKeys?.indexOf('living_entity_flags')
  return idx >= 0 && ((e.metadata?.[idx] || 0) & 1) === 1
}

// Whether the archer is looking our way: its head yaw within AIM_TOLERANCE of the
// bearing to us, and its pitch within it of the straight line (an arc to us at
// these ranges stays well inside that). A drawing player aiming elsewhere — an
// ally hunting a skeleton — is no threat.
const AIM_TOLERANCE = 25 * Math.PI / 180
function aimedAt(bot, e) {
  const d = bot.entity.position.offset(0, 1, 0).minus(e.position.offset(0, (e.height || 1.8) * 0.85, 0))
  const h = Math.hypot(d.x, d.z)
  const bearing = Math.atan2(-d.x, -d.z)   // mineflayer yaw: 0 faces -z, +π/2 faces -x
  const yawOff = Math.abs(Math.atan2(Math.sin((e.headYaw ?? e.yaw) - bearing), Math.cos((e.headYaw ?? e.yaw) - bearing)))
  return yawOff <= AIM_TOLERANCE && Math.abs(e.pitch - Math.atan2(d.y, h)) <= AIM_TOLERANCE
}

// Nearest archer in line of sight; drawingOnly limits it to one mid-draw and
// aiming at us.
function nearestArcher(bot, range = THREAT_RANGE, drawingOnly = false) {
  const pos = bot.entity.position
  const eye = pos.offset(0, 1.62, 0)
  const { hasLineOfSight } = require('../perception/vision')
  return bot.nearestEntity(e =>
    isArcher(e) &&
    e.position.distanceTo(pos) < range &&
    (!drawingOnly || (drawing(bot, e) && aimedAt(bot, e))) &&
    hasLineOfSight(eye, e.position, e.height || 1.8)
  )
}

function setupRangedDefense() {
  const bot = state.bot
  let raised = false, lastThreatAt = 0
  // Every archer's current draw, aimed or not: the ms its hand went up. One that
  // draws aside and then turns to us can loose at once, so the clock can't start
  // at the turn.
  const drawStart = new Map()
  const aimedDraws = new Set()   // archers whose current draw has been aimed at us
  // The juke: which way we lean ('left'/'right'), then cut. cutUntil = 0: not cutting.
  let lean = null, leanSince = 0, cut = null, cutUntil = 0, side = 'left'
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
    const pos = bot.entity.position
    for (const e of Object.values(bot.entities)) {
      if (drawStart.has(e.id) || e === bot.entity || !isArcher(e) || !drawing(bot, e)) continue
      if (e.position.distanceTo(pos) < THREAT_RANGE) drawStart.set(e.id, now)
    }
    // A draw that ended has just loosed (or given up): a release at us if it was
    // aimed at us. Aim wavering mid-draw is not a release.
    let released = null
    for (const id of drawStart.keys()) {
      const e = bot.entities[id]
      if (e && drawing(bot, e)) continue
      drawStart.delete(id)
      if (aimedDraws.delete(id) && e) released = e
    }
    if (threat) {
      lastThreatAt = now
      aimedDraws.add(threat.id)
      if (!drawStart.has(threat.id)) drawStart.set(threat.id, now)
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

    // No shield: the juke. Lean late in the draw, cut the other way when the
    // release is due or seen.
    const opposite = (d) => d === 'left' ? 'right' : 'left'
    if (cut && now >= cutUntil) { bot.setControlState(cut, false); cut = null }
    const timing = threat && jukeTiming(threat)
    const drawn = threat ? now - drawStart.get(threat.id) : 0
    // A draw already past its cut when it turns on us gets the cut at once, no lean.
    const late = threat && timing.cut !== null && drawn >= timing.cut
    if (threat && !lean && !cut && drawn >= timing.lean && !late) {
      if (bot.pvp?.target !== threat) face(threat)
      side = opposite(side)   // alternate, so the lean isn't predictable either
      lean = side
      leanSince = now
      bot.setControlState(lean, true)
    }
    const due = late && !cut && (!lean || now - leanSince >= LEAN_HOLD_MS)
    if (!released && due) released = threat
    if (released && !cut) {
      // No lean (a short draw): any way across the line beats standing still.
      const dir = lean ? opposite(lean) : (side = opposite(side))
      if (lean) bot.setControlState(lean, false)
      lean = null
      cut = dir
      bot.setControlState(cut, true)
      cutUntil = now + CUT_MS
      count(released, 'dodge')
      console.log(`  [DODGE] juke ${cut}${due ? ' (due)' : ''} vs ${released.username || released.name} at ${released.position.distanceTo(bot.entity.position).toFixed(1)}m`)
    }
    // The archer stopped without a release we saw (out of sight, gone): stop leaning.
    if (lean && !threat && !released) { bot.setControlState(lean, false); lean = null }
  })
}

module.exports = { setupRangedDefense, nearestArcher, ARCHERS }
