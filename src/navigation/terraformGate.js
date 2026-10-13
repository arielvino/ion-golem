// terraformGate.js — where the pathfinder may change the world by itself on a walk.
//
// A walk under mineflayer-pathfinder may bridge: place a junk block (dirt, cobble…)
// under a step that has no floor. This gate is asked about every block it would place,
// as it plans; a "no" makes that step impossible and the plan goes around. Rules about
// where (not in a populated area, not next to a build…) belong here, and so does the
// same gate for the pathfinder digging, once it may.
//
// Today the only rule is a per-world switch a player sets with `!bridge on|off` (on by
// default). Combat chases never bridge: they use their own movements (bot.js).
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

// The blocks the pathfinder may spend on a bridge: what mining piles up anyway.
const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']
// Steps that place a block cost this much more than a plain step: a short walk
// around still beats bridging.
const PLACE_COST = 4

function modeFile() { return state.WORLD_DATA_DIR ? path.join(state.WORLD_DATA_DIR, 'bridge-mode.json') : null }

function isOn() {
  if (state.bridgeMode === undefined) {
    state.bridgeMode = true
    try { const f = modeFile(); if (f && fs.existsSync(f)) state.bridgeMode = JSON.parse(fs.readFileSync(f, 'utf8')).on !== false } catch (e) {}
  }
  return state.bridgeMode
}

function setOn(on, by) {
  state.bridgeMode = on
  try { const f = modeFile(); if (f) fs.writeFileSync(f, JSON.stringify({ on, by, at: new Date().toISOString() })) } catch (e) {}
  console.log(`  [BRIDGE] ${on ? 'on' : 'off'} (set by ${by})`)
}

// May the pathfinder place a block at `block` (the cell it would fill)?
function mayPlace(block) {
  return isOn()
}

// Hooked into Movements.exclusionAreasPlace: a cost, 100 = never.
function placeExclusion(block) {
  return mayPlace(block) ? 0 : 100
}

// Every player chat line. Returns true when the line was a !bridge command (not for the AI).
function onPlayerChat(username, message) {
  const cmd = message.trim().match(/^!bridge(?:\s+(on|off))?\s*$/i)
  if (!cmd) return false
  if (cmd[1]) setOn(cmd[1].toLowerCase() === 'on', username)
  const { sendChat } = require('../core/utils')
  sendChat(isOn()
    ? '[bridge] ON: walking, I may place dirt or cobble to cross a gap.'
    : '[bridge] OFF: walking, I never place blocks.')
  return true
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  return isOn() ? '' : ' BRIDGE=off'
}

module.exports = { SCAFFOLD_ITEMS, PLACE_COST, isOn, mayPlace, placeExclusion, onPlayerChat, contextLine }
