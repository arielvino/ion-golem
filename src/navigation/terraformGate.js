// terraformGate.js — where the pathfinder may change the world by itself on a walk.
//
// A walk under mineflayer-pathfinder may bridge (place a junk block — dirt, cobble… —
// under a step that has no floor) and dig (break a block in its way). This gate is
// asked about every block it would place or break, as it plans; a "no" makes that step
// impossible and the plan goes around. Rules about where (not in a populated area, not
// next to a build…) belong here.
//
// Today: a per-world switch for each, `!bridge on|off` and `!dig on|off` (both on by
// default). Digging also keeps digBlock's rules: no-unpermitted-breaking mode, never a
// block the bot built (blueprint or path), never one that needs a tool it doesn't have.
// Combat chases do neither: they use their own movements (bot.js).
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

// The blocks the pathfinder may spend on a bridge: what mining piles up anyway.
const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']
// Steps that place a block cost this much more than a plain step: a short walk
// around still beats bridging.
const PLACE_COST = 4
// A dug block's cost is (1 + 3 × dig seconds) × this: stone with a pickaxe ~4.4, so a
// short walk around still beats digging through.
const DIG_COST = 2

// The two switches, each persisted per world: bridge → bridge-mode.json, dig → dig-mode.json.
const SWITCHES = {
  bridge: { on: 'walking, I may place dirt or cobble to cross a gap.', off: 'walking, I never place blocks.' },
  dig: { on: 'walking, I may dig through what is in my way.', off: 'walking, I never break blocks.' }
}
const modes = {}

function modeFile(kind) { return state.WORLD_DATA_DIR ? path.join(state.WORLD_DATA_DIR, `${kind}-mode.json`) : null }

function isOn(kind) {
  if (modes[kind] === undefined) {
    modes[kind] = true
    try { const f = modeFile(kind); if (f && fs.existsSync(f)) modes[kind] = JSON.parse(fs.readFileSync(f, 'utf8')).on !== false } catch (e) {}
  }
  return modes[kind]
}

function setOn(kind, on, by) {
  modes[kind] = on
  try { const f = modeFile(kind); if (f) fs.writeFileSync(f, JSON.stringify({ on, by, at: new Date().toISOString() })) } catch (e) {}
  console.log(`  [${kind.toUpperCase()}] ${on ? 'on' : 'off'} (set by ${by})`)
}

// What the gate decides from. Live: this world's switches and the bot's memory. A plan
// replayed offline (tools/plan-replay.js) passes the ones recorded when it timed out.
const liveFacts = {
  bridgeOn: () => isOn('bridge'),
  digOn: () => isOn('dig'),
  permitted: () => require('../engine/breakPermission').permitted(),
  // Never dig a block the bot built (blueprint or path).
  isProtected: (x, y, z) => !!state.stmts?.isPlaced?.get(x, y, z) || require('../world/memory').isPathBlock(x, y, z),
  items: () => state.bot.inventory.items()
}

function gateFor(facts) {
  // May the pathfinder place a block at `block` (the cell it would fill)?
  const mayPlace = (block) => facts.bridgeOn()
  // May the pathfinder break `block`? Asked while planning, so it decides without a
  // word; the dig itself still goes through breakPermission.mayBreak, which reports.
  const mayBreak = (block) => {
    if (!facts.digOn()) return false
    if (!facts.permitted()) return false
    const { x, y, z } = block.position
    if (facts.isProtected(x, y, z)) return false
    // A block that drops nothing without a tool we don't have: digBlock refuses it too.
    // XRAY(planning): `block` is the planner's, from the live world, maybe one never seen.
    if (block.harvestTools && !facts.items().some(i => block.harvestTools[i.type])) return false
    return true
  }
  // Hooked into Movements.exclusionAreasPlace / exclusionAreasBreak: a cost, 100 = never.
  return {
    mayPlace,
    mayBreak,
    placeExclusion: (block) => mayPlace(block) ? 0 : 100,
    breakExclusion: (block) => mayBreak(block) ? 0 : 100
  }
}
const { mayPlace, mayBreak, placeExclusion, breakExclusion } = gateFor(liveFacts)

// Every player chat line. Returns true when the line was a !bridge or !dig command (not for the AI).
function onPlayerChat(username, message) {
  const cmd = message.trim().match(/^!(bridge|dig)(?:\s+(on|off))?\s*$/i)
  if (!cmd) return false
  const kind = cmd[1].toLowerCase()
  if (cmd[2]) setOn(kind, cmd[2].toLowerCase() === 'on', username)
  const { sendChat } = require('../core/utils')
  const on = isOn(kind)
  sendChat(`[${kind}] ${on ? 'ON' : 'OFF'}: ${SWITCHES[kind][on ? 'on' : 'off']}`)
  return true
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  return (isOn('bridge') ? '' : ' BRIDGE=off') + (isOn('dig') ? '' : ' DIG=off')
}

module.exports = { SCAFFOLD_ITEMS, PLACE_COST, DIG_COST, isOn, gateFor, mayPlace, mayBreak, placeExclusion, breakExclusion, onPlayerChat, contextLine }
