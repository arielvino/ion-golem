// selfStatus.js — changes to the bot's own standing, as journal records.
//
// XP level, game mode and difficulty, losing the bed spawn, getting on or off a
// vehicle, and what the server prints on screen (title, action bar). The action bar
// is where the server explains itself — "You may not rest now; there are monsters
// nearby", "Respawn point set" — and nothing else ever reads it.
const { processNbtMessage } = require('prismarine-chat')
const { logEvent } = require('../core/utils')

const REPEAT_MS = 30000   // the same on-screen text again within this is one record

let bound = null

function record(text) {
  console.log(`  [EVT] ${text}`)
  logEvent(text)
}

// Plain text of an NBT text component, as node-minecraft-protocol decodes chat.
function nbtText(bot, nbt) {
  try {
    const ChatMessage = require('prismarine-chat')(bot.registry)
    return ChatMessage.fromNotch(processNbtMessage(nbt)).toString().trim()
  } catch { return '' }
}

function bind(bot) {
  if (bound === bot) return
  bound = bot

  let level = bot.experience?.level ?? null
  bot.on('experience', () => {
    const now = bot.experience.level
    if (level !== null && now !== level) record(`xp: level ${level} → ${now}`)
    level = now
  })

  let mode = bot.game?.gameMode ?? null
  let difficulty = bot.game?.difficulty ?? null
  bot.on('game', () => {
    const now = bot.game.gameMode
    if (mode && now && now !== mode) record(`game: mode ${mode} → ${now}`)
    mode = now || mode
    const diff = bot.game.difficulty
    if (difficulty && diff && diff !== difficulty) record(`game: difficulty ${difficulty} → ${diff}`)
    difficulty = diff || difficulty
  })

  bot.on('spawnReset', () => record('spawn: no bed or respawn anchor to respawn at (missing or blocked), so the bed spawn point is gone'))

  bot.on('mount', () => { if (bot.vehicle) record(`vehicle: got on ${bot.vehicle.name || 'a vehicle'}`) })
  bot.on('dismount', (v) => record(`vehicle: got off ${v?.name || 'a vehicle'}`))

  const shown = new Map()   // text → ms last recorded
  const onScreen = (kind, text) => {
    if (!text) return
    const t = Date.now()
    if (t - (shown.get(text) || 0) < REPEAT_MS) return
    shown.set(text, t)
    record(`${kind}: "${text}"`)
  }
  // The server's own explanations come as overlay system chat (mineflayer's actionBar);
  // /title sends dedicated packets, which mineflayer either drops (action bar) or
  // passes on undecoded when the text is styled (title), so read those directly.
  bot.on('actionBar', (msg) => onScreen('action bar', msg?.toString().trim()))
  bot._client.on('action_bar', (p) => onScreen('action bar', nbtText(bot, p.text)))
  bot._client.on('set_title_text', (p) => onScreen('title', nbtText(bot, p.text)))
  bot._client.on('set_title_subtitle', (p) => onScreen('subtitle', nbtText(bot, p.text)))
}

module.exports = { bind }
