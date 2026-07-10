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

module.exports = { sendChat, debugChat, logEvent, normalizeItemName, recordFailure, fuzzyMatch, parseCoordTarget, clearQueuedActions }
