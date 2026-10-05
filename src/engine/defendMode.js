// defendMode.js — "defend" mode: strike hostiles first instead of waiting to be hit.
//
// On by default: the autonomous layer attacks any hostile that comes within
// DEFEND_RANGE in line of sight, with no model turn in between. A player can switch it
// off (`!defend off`); off, the bot only fights back once it takes damage. Persisted
// per bot like the break mode.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

const DEFEND_RANGE = 8

function modeFile() { return state.BOT_DATA_DIR ? path.join(state.BOT_DATA_DIR, 'defend-mode.json') : null }

function isOn() {
  if (state.defendMode === undefined) {
    state.defendMode = true
    try { const f = modeFile(); if (f && fs.existsSync(f)) state.defendMode = JSON.parse(fs.readFileSync(f, 'utf8')).on !== false } catch (e) {}
  }
  return state.defendMode
}

function setOn(on, by) {
  state.defendMode = on
  try { const f = modeFile(); if (f) fs.writeFileSync(f, JSON.stringify({ on, by, at: new Date().toISOString() })) } catch (e) {}
  console.log(`  [DEFEND] ${on ? 'on' : 'off'} (set by ${by})`)
}

// Every player chat line. Returns true when the line was a !defend command (not for the AI).
function onPlayerChat(username, message) {
  const cmd = message.trim().match(/^!defend(?:\s+(on|off))?\s*$/i)
  if (!cmd) return false
  if (cmd[1]) setOn(cmd[1].toLowerCase() === 'on', username)
  const { sendChat } = require('../core/utils')
  sendChat(isOn()
    ? `[defend] ON: I attack hostiles within ${DEFEND_RANGE} blocks on sight.`
    : '[defend] OFF: I only fight back when hit.')
  return true
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  return isOn() ? ' DEFEND=on' : ''
}

module.exports = { DEFEND_RANGE, isOn, onPlayerChat, contextLine }
