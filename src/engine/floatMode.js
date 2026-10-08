// floatMode.js — "float" mode: stay at the water surface instead of sinking.
//
// On by default: the autonomous layer holds jump whenever the bot's eyes are under
// water and the pathfinder isn't steering. A player can switch it off (`!float off`)
// to let the bot stay under water on purpose; the drowning swimup still applies.
// Persisted per bot like the defend mode.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

function modeFile() { return state.BOT_DATA_DIR ? path.join(state.BOT_DATA_DIR, 'float-mode.json') : null }

function isOn() {
  if (state.floatMode === undefined) {
    state.floatMode = true
    try { const f = modeFile(); if (f && fs.existsSync(f)) state.floatMode = JSON.parse(fs.readFileSync(f, 'utf8')).on !== false } catch (e) {}
  }
  return state.floatMode
}

function setOn(on, by) {
  state.floatMode = on
  try { const f = modeFile(); if (f) fs.writeFileSync(f, JSON.stringify({ on, by, at: new Date().toISOString() })) } catch (e) {}
  console.log(`  [FLOAT] ${on ? 'on' : 'off'} (set by ${by})`)
}

// Every player chat line. Returns true when the line was a !float command (not for the AI).
function onPlayerChat(username, message) {
  const cmd = message.trim().match(/^!float(?:\s+(on|off))?\s*$/i)
  if (!cmd) return false
  if (cmd[1]) setOn(cmd[1].toLowerCase() === 'on', username)
  const { sendChat } = require('../core/utils')
  sendChat(isOn()
    ? '[float] ON: I keep to the water surface.'
    : '[float] OFF: I sink in water unless I swim; I still surface when out of air.')
  return true
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  return isOn() ? '' : ' FLOAT=off'
}

module.exports = { isOn, onPlayerChat, contextLine }
