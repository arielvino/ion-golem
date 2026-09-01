// Shared utility functions

const state = require('./state')

// --- Centralized chat queue (600ms cooldown to avoid spam kick) ---
const chatQueue = []
let chatDraining = false
async function drainChatQueue() {
  if (chatDraining) return
  chatDraining = true
  while (chatQueue.length > 0) {
    const line = chatQueue.shift()
    try { state.bot.chat(line) } catch (e) { console.warn('  [CHAT] send err:', e.message) }
    // Always cool down after a send (even when the queue is momentarily empty),
    // so the drainer holds the throttle long enough that a single line arriving
    // right after can't fire instantly and escape the cooldown.
    await new Promise(r => setTimeout(r, 600))
  }
  chatDraining = false
}

function sendChat(text) {
  if (!text) return
  const MAX = 230
  if (text.length <= MAX) { chatQueue.push(text); drainChatQueue(); return }
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text]
  let line = ''
  for (const s of sentences) {
    if (line.length + s.length > MAX && line.length > 0) {
      chatQueue.push(line.trim())
      line = ''
    }
    line += s
  }
  if (line.trim()) chatQueue.push(line.trim())
  drainChatQueue()
}

/** Send a debug-only chat message (suppressed when not in --debug mode) */
function debugChat(text) {
  if (state.debugMode) sendChat(text)
}

/** Log a concise event to the rolling history (shown to AI as HISTORY=) */
function logEvent(msg) {
  state.eventLog.push({ ts: Date.now(), msg })
  if (state.eventLog.length > state.MAX_EVENT_LOG) state.eventLog.shift()
}

/** Normalize a user/AI-supplied item or block name to canonical form ("Oak Log" -> "oak_log") */
function normalizeItemName(name) {
  return (name || '').toLowerCase().replace(/ /g, '_')
}

/** Bidirectional substring match — true if either name contains the other ("oak_log" ~ "log") */
function fuzzyMatch(a, b) {
  return a.includes(b) || b.includes(a)
}

// Usernames the engine uses for non-player actors: 'self' for autonomous loop
// turns, 'auto' for reflexes, 'event' for game events. None is ever a real
// player, so a player lookup on one silently resolves to nothing — which reads
// in chat as "I can't see you" while the player stands a metre away.
const PSEUDO_USERNAMES = new Set(['self', 'auto', 'event'])

function isPseudoUsername(name) {
  return PSEUDO_USERNAMES.has(name)
}

/**
 * Resolve an action's intended player from whatever names it has to work with
 * (an explicit action target, then the requesting username), returning a real
 * key of bot.players or null.
 *
 * With no usable candidate, fall back to a player named in the current task
 * title. Autonomous turns arrive as 'self', and the requesting username is
 * in-memory only while the task stack is persisted — so after a restart a
 * restored "follow Sargon564" task has the name in its title and nowhere else.
 * A candidate that IS a real name but isn't online returns null instead: the
 * caller asked for someone specific and deserves an honest miss.
 */
function resolvePlayerName(...candidates) {
  const bot = state.bot
  if (!bot) return null
  const names = Object.keys(bot.players).filter(n => n !== bot.username)
  let asked = false
  for (const cand of candidates) {
    if (!cand || isPseudoUsername(cand)) continue
    asked = true
    const hit = names.find(n => n === cand) ||
      names.find(n => n.toLowerCase() === cand.toLowerCase())
    if (hit) return hit
  }
  if (asked) return null
  const title = state.taskStack.length ? state.taskStack[state.taskStack.length - 1].t : ''
  if (!title) return null
  return names.find(n => title.toLowerCase().includes(n.toLowerCase())) || null
}

const MAX_FAILURES = 5

/** Record a recent failure reason (shown to AI as RECENT_FAILS=), keeping the last few */
function recordFailure(msg) {
  state.lastFailures.push(msg)
  if (state.lastFailures.length > MAX_FAILURES) state.lastFailures.shift()
}

/**
 * Parse a "name:x,y,z" targeting string (explicit world coords) into
 * { name, x, y, z }. Returns null if the string isn't in that form, so callers
 * can fall back to a plain name lookup.
 */
function parseCoordTarget(target) {
  const m = (target || '').match(/^(.+?):(-?\d+),(-?\d+),(-?\d+)$/)
  if (!m) return null
  return { name: m[1], x: parseInt(m[2], 10), y: parseInt(m[3], 10), z: parseInt(m[4], 10) }
}

/** Drop any queued actions whose actionStr starts with the given prefix */
function clearQueuedActions(prefix) {
  state.actionQueue = state.actionQueue.filter(a => !a.actionStr.startsWith(prefix))
}

module.exports = { sendChat, debugChat, logEvent, normalizeItemName, recordFailure, fuzzyMatch, parseCoordTarget, clearQueuedActions, isPseudoUsername, resolvePlayerName }
