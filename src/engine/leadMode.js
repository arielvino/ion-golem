// leadMode.js — "lead" mode: the bot sets its own goals instead of waiting for orders.
//
// Off by default (an experiment). When a player switches it on (`!lead on`), an idle
// bot with nothing on its agenda gets a turn to pick a goal of its own, at most once
// per LEAD_WAKE_MS. Players' requests still come first. Persisted per bot like the
// defend mode.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

const LEAD_WAKE_MS = 30000

function modeFile() { return state.BOT_DATA_DIR ? path.join(state.BOT_DATA_DIR, 'lead-mode.json') : null }

function isOn() {
  if (state.leadMode === undefined) {
    state.leadMode = false
    try { const f = modeFile(); if (f && fs.existsSync(f)) state.leadMode = JSON.parse(fs.readFileSync(f, 'utf8')).on === true } catch (e) {}
  }
  return state.leadMode
}

function setOn(on, by) {
  state.leadMode = on
  try { const f = modeFile(); if (f) fs.writeFileSync(f, JSON.stringify({ on, by, at: new Date().toISOString() })) } catch (e) {}
  console.log(`  [LEAD] ${on ? 'on' : 'off'} (set by ${by})`)
}

// Idle with an empty agenda: is it time to wake the model to choose a goal?
let lastWake = 0
function wantsWake() {
  if (!isOn() || Date.now() - lastWake < LEAD_WAKE_MS) return false
  lastWake = Date.now()
  return true
}

// Every player chat line. Returns true when the line was a !lead command (not for the AI).
function onPlayerChat(username, message) {
  const cmd = message.trim().match(/^!lead(?:\s+(on|off))?\s*$/i)
  if (!cmd) return false
  if (cmd[1]) { setOn(cmd[1].toLowerCase() === 'on', username); lastWake = 0 }
  const { sendChat } = require('../core/utils')
  sendChat(isOn()
    ? '[lead] ON: I pick my own goals when nobody gives me one.'
    : '[lead] OFF: I wait for players to give me goals.')
  return true
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  return isOn() ? ' LEAD=on' : ''
}

module.exports = { isOn, wantsWake, onPlayerChat, contextLine }
