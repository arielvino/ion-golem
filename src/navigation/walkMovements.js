// walkMovements.js — the pathfinder's rules, built the same way for the live bot and for
// a plan replayed offline (tools/plan-replay.js).
const { Movements } = require('mineflayer-pathfinder')
const terraformGate = require('./terraformGate')

// Two sets of pathfinder rules. `chase` (the default, for combat chases and the
// reflexes' reach check) never places a block: a fight doesn't build toward a mob.
// `walk` (navigation's walks) may bridge a gap with junk blocks and dig through what
// is in its way, where the gate allows (live: terraformGate's; a replay passes one
// built from the recorded facts). Neither towers: pillaring is an explicit action.
function makeMovements(bot, walk, gate = terraformGate) {
  const mv = new Movements(bot)
  mv.allowSprinting = true
  mv.canOpenDoors = true
  mv.canDig = false
  mv.allow1by1towers = false
  mv.allowParkour = true
  mv.maxDropDown = 4
  mv.scafoldingBlocks = []
  if (walk) {
    mv.scafoldingBlocks = terraformGate.SCAFFOLD_ITEMS.map(n => bot.registry.itemsByName[n]?.id).filter(id => id !== undefined)
    mv.placeCost = terraformGate.PLACE_COST
    mv.exclusionAreasPlace.push(gate.placeExclusion)
    // XRAY(planning): the pathfinder plans over the live world. Its dig safety
    // (dontCreateFlow, dontMineUnderFallingBlock: no dig next to a liquid or under
    // sand/gravel) can react to blocks the bot never saw. Allowed: it only drops
    // steps from the plan; nothing it reads reaches memory or the model.
    mv.canDig = true
    mv.digCost = terraformGate.DIG_COST
    mv.exclusionAreasBreak.push(gate.breakExclusion)
  }
  return mv
}

// Cave walks (actions/cave.js): the walk's rules, with no drop the bot takes damage from. The
// way out may also tower up 1x1: it climbs back the drops the way in went down.
function makeCaveMovements(bot, { out = false } = {}) {
  const mv = makeMovements(bot, true)
  mv.maxDropDown = 3
  if (out) mv.allow1by1towers = true
  return mv
}

module.exports = { makeMovements, makeCaveMovements }
