// Shared utility functions

const state = require('./state')

// --- Centralized chat queue (throttled to stay under the vanilla spam kick) ---
// Vanilla adds 20 to a per-player counter for every chat line or command and drains
// 1 per tick, kicking above 200. One line per second is break-even, so any spacing
// under 1000ms gets kicked by a SUSTAINED stream no matter how small the burst.
const CHAT_SPACING_MS = 1100
const CHAT_MAX_BACKLOG = 10    // past this, drop the oldest line (debug lines first)
const DEBUG_MAX_BACKLOG = 3    // past this, new debug lines are dropped, not queued
const chatQueue = []           // { text, debug }
let chatDraining = false
async function drainChatQueue() {
  if (chatDraining) return
  chatDraining = true
  while (chatQueue.length > 0) {
    const { text } = chatQueue.shift()
    try { state.bot.chat(text) } catch (e) { console.warn('  [CHAT] send err:', e.message) }
    // Always cool down after a send (even when the queue is momentarily empty),
    // so the drainer holds the throttle long enough that a single line arriving
    // right after can't fire instantly and escape the cooldown.
    await new Promise(r => setTimeout(r, CHAT_SPACING_MS))
  }
  chatDraining = false
}

function enqueueChat(text, debug) {
  if (debug && chatQueue.length >= DEBUG_MAX_BACKLOG) return
  chatQueue.push({ text, debug })
  while (chatQueue.length > CHAT_MAX_BACKLOG) {
    const i = chatQueue.findIndex(l => l.debug)
    const [dropped] = chatQueue.splice(i >= 0 ? i : 0, 1)
    console.warn(`  [CHAT] backlog full, dropped: ${dropped.text.slice(0, 60)}`)
  }
}

function sendChat(text, debug = false) {
  if (!text) return
  if (state.chatMuted) { console.log(`  [MUTED] ${text}`); return }
  const MAX = 230
  if (text.length <= MAX) { enqueueChat(text, debug); drainChatQueue(); return }
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text]
  let line = ''
  for (const s of sentences) {
    if (line.length + s.length > MAX && line.length > 0) {
      enqueueChat(line.trim(), debug)
      line = ''
    }
    line += s
  }
  if (line.trim()) enqueueChat(line.trim(), debug)
  drainChatQueue()
}

// A backlog from before a disconnect must not replay into the new session —
// that is exactly how a spam kick turns into a kick-rejoin-kick loop.
function clearChatQueue() { chatQueue.length = 0 }

/** Send a debug-only chat message (suppressed when not in --debug mode) */
function debugChat(text) {
  if (state.debugMode) sendChat(text, true)
}

/** Record a concise event in the journal (shown to AI once, as NEW=) */
function logEvent(msg) {
  state.journal?.record(msg)
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

// The online player an action names (exact, then case-insensitive), as a real key
// of bot.players — or null when no name was given or that player isn't online.
function resolvePlayerName(name) {
  const bot = state.bot
  if (!bot || !name || isPseudoUsername(name)) return null
  const names = Object.keys(bot.players).filter(n => n !== bot.username)
  return names.find(n => n === name) || names.find(n => n.toLowerCase() === name.toLowerCase()) || null
}

const MAX_FAILURES = 5

/** Record a recent failure reason (shown to AI as RECENT_FAILS=), keeping the last few */
function recordFailure(msg) {
  state.lastFailures.push(msg)
  state.journal?.record(`✗ ${msg}`)
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

module.exports = { sendChat, debugChat, clearChatQueue, logEvent, normalizeItemName, recordFailure, fuzzyMatch, parseCoordTarget, clearQueuedActions, isPseudoUsername, resolvePlayerName }
