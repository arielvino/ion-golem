// breakPermission.js — "no unpermitted breaking" mode.
//
// When a player switches it on (`!nobreak on`), the bot breaks no block — not to mine, not
// to tunnel, not to clear a build site — unless the action it is running right now was
// approved by a player in chat. The model cannot approve itself: it asks with
// [ASKBREAK:<action>], the CODE posts the request, and only a player's reply grants it.
// An approval covers that exact action string for GRANT_MS, so retrying the same approved
// action needs no second yes, but any other action does.
//
// Enforcement lives at the only two places a block is ever broken: digBlock (everything
// digs through it) and swim-up's head clearance. mineflayer-pathfinder has canDig=false.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

const GRANT_MS = 10 * 60 * 1000
const PENDING_MS = 5 * 60 * 1000
const APPROVE_RE = /^\s*(yes|y|yeah|yep|ok|okay|sure|approved?|allow(ed)?|go( ahead)?|כן|אוקיי?|מאשרת?|מאושרת?|סבבה|יאללה|קדימה)(\s|[.!]|$)/i
const DENY_RE = /^\s*(no|n|nope|deny|denied|don'?t|לא|אל|אסור)(\s|[.!,]|$)/i

// Action strings compare case- and whitespace-insensitively.
const norm = (a) => String(a || '').toLowerCase().replace(/\s+/g, '')

function modeFile() { return state.BOT_DATA_DIR ? path.join(state.BOT_DATA_DIR, 'break-mode.json') : null }

function ensure() {
  if (state.breakMode) return
  let mode = 'free'
  try { const f = modeFile(); if (f && fs.existsSync(f)) mode = JSON.parse(fs.readFileSync(f, 'utf8')).mode === 'ask' ? 'ask' : 'free' } catch (e) {}
  state.breakMode = mode
  state.breakGrants = []
  state.breakPending = null
  state.breakBlocked = null
}

function setMode(mode, by) {
  ensure()
  state.breakMode = mode
  state.breakGrants = []
  state.breakPending = null
  state.breakBlocked = null
  try { const f = modeFile(); if (f) fs.writeFileSync(f, JSON.stringify({ mode, by, at: new Date().toISOString() })) } catch (e) {}
  console.log(`  [BREAK] mode=${mode} (set by ${by})`)
}

// The action the bot is executing right now: the current alternative of the background task.
function currentAction() {
  const t = state.backgroundTask
  if (!t || t.status !== 'running') return null
  return { alt: t.target ? `${t.action}:${t.target}` : t.action, full: t.actionStr }
}

function activeGrants() {
  const now = Date.now()
  state.breakGrants = state.breakGrants.filter(g => g.until > now)
  return state.breakGrants
}

// Called right before a block would be broken. true = go ahead.
function mayBreak(blockName, pos, reason) {
  ensure()
  if (state.breakMode !== 'ask') return true
  const cur = currentAction()
  if (cur && activeGrants().some(g => g.action === norm(cur.alt) || g.action === norm(cur.full))) return true
  state.breakBlocked = {
    action: cur ? cur.alt : null, block: blockName,
    pos: pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '?', reason: reason || null, at: Date.now(),
  }
  console.log(`  [BREAK] refused ${blockName}@${state.breakBlocked.pos} (${reason || 'dig'}) during ${cur ? cur.alt : 'no action'} — not approved`)
  return false
}

// [ASKBREAK:<action>] from the model → the bot posts the request itself.
function requestBreak(action) {
  ensure()
  const a = String(action || '').trim()
  if (!a) return
  if (state.breakMode !== 'ask') return
  if (activeGrants().some(g => g.action === norm(a))) return
  if (state.breakPending && state.breakPending.key === norm(a) && Date.now() - state.breakPending.at < PENDING_MS) return
  state.breakPending = { action: a, key: norm(a), at: Date.now() }
  const { sendChat } = require('../core/utils')
  sendChat(`[permission] I want to break blocks for: ${a} — reply "yes" to allow or "no" to refuse.`)
  console.log(`  [BREAK] requested: ${a}`)
}

// Every player chat line. Returns true when the line was a !nobreak command (not for the AI);
// an approval/refusal is recorded here but still reaches the AI like any other chat.
function onPlayerChat(username, message) {
  ensure()
  const m = message.trim()
  const cmd = m.match(/^!nobreak(?:\s+(on|off))?\s*$/i)
  if (cmd) {
    const { sendChat } = require('../core/utils')
    if (cmd[1]) setMode(cmd[1].toLowerCase() === 'on' ? 'ask' : 'free', username)
    sendChat(state.breakMode === 'ask'
      ? '[permission] no-unpermitted-breaking is ON: I break nothing without a player\'s yes.'
      : '[permission] no-unpermitted-breaking is OFF.')
    return true
  }
  const p = state.breakPending
  if (state.breakMode !== 'ask' || !p || Date.now() - p.at > PENDING_MS) return false
  const { sendChat } = require('../core/utils')
  if (APPROVE_RE.test(m)) {
    state.breakGrants.push({ action: p.key, label: p.action, by: username, until: Date.now() + GRANT_MS })
    state.breakPending = null
    state.breakBlocked = null
    sendChat(`[permission] approved by ${username}: ${p.action}`)
    console.log(`  [BREAK] approved by ${username}: ${p.action}`)
  } else if (DENY_RE.test(m)) {
    state.breakPending = null
    state.breakDenied = { action: p.action, by: username, at: Date.now() }
    sendChat(`[permission] refused by ${username}: ${p.action}`)
    console.log(`  [BREAK] refused by ${username}: ${p.action}`)
  }
  return false
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  ensure()
  if (state.breakMode !== 'ask') return ''
  const now = Date.now()
  const parts = ['mode:ask_first']
  const g = activeGrants()
  if (g.length) parts.push(`approved: ${g.map(x => `${x.label} (by ${x.by}, ${Math.ceil((x.until - now) / 60000)}min left)`).join(', ')}`)
  const p = state.breakPending
  if (p && now - p.at < PENDING_MS) parts.push(`pending: ${p.action} (asked ${Math.round((now - p.at) / 1000)}s ago)`)
  const d = state.breakDenied
  if (d && now - d.at < PENDING_MS) parts.push(`refused: ${d.action} (by ${d.by})`)
  const b = state.breakBlocked
  if (b && now - b.at < 60000) parts.push(`blocked: ${b.block}@${b.pos} during ${b.action || 'no action'} (${Math.round((now - b.at) / 1000)}s ago)`)
  return ` BREAK=[${parts.join(' | ')}]`
}

module.exports = { mayBreak, requestBreak, onPlayerChat, contextLine, setMode, APPROVE_RE, DENY_RE }
