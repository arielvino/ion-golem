// playerSignals.js — what a player in sight does with their body, as journal records.
//
// Players talk with more than chat: a crouch-wave to say "here", a switch to a sword
// before a fight, going to bed to skip the night. The context shows where a player is,
// not these gestures, so the ones in line of sight become records.
const state = require('../core/state')
const { logEvent } = require('../core/utils')
const { hasLineOfSight } = require('../perception/vision')
const ranges = require('../config/ranges')

const CROUCH_GATHER_MS = 3000   // crouches within this are one record ("crouched ×3")
const HOLD_SETTLE_MS = 1500     // scrolling the hotbar: record what they settle on

let bound = null

function record(text) {
  console.log(`  [EVT] ${text}`)
  logEvent(text)
}

// A player other than the bot, close enough and in line of sight.
function seenPlayer(bot, entity) {
  if (!entity || entity.type !== 'player' || entity === bot.entity || !entity.username) return false
  if (!bot.entity) return false
  if (entity.position.distanceTo(bot.entity.position) > ranges.sight.playerVisibility) return false
  return hasLineOfSight(bot.entity.position.offset(0, 1.62, 0), entity.position, entity.height || 1.8)
}

function bind(bot) {
  if (bound === bot) return
  bound = bot

  const crouches = new Map()   // username → { n, timer }
  bot.on('entityCrouch', (e) => {
    if (!seenPlayer(bot, e)) return
    const c = crouches.get(e.username) || { n: 0, timer: null }
    c.n++
    if (!c.timer) {
      c.timer = setTimeout(() => {
        crouches.delete(e.username)
        record(`player: ${e.username} crouched${c.n > 1 ? ` ×${c.n}` : ''}`)
      }, CROUCH_GATHER_MS)
    }
    crouches.set(e.username, c)
  })

  const held = new Map()       // username → { name, timer }
  bot.on('entityEquip', (e) => {
    if (e?.type !== 'player' || e === bot.entity || !e.username) return
    const name = e.heldItem?.name || 'nothing'
    const h = held.get(e.username)
    if (!h) { held.set(e.username, { name, timer: null }); return }   // first sighting: not a change
    if (h.timer) clearTimeout(h.timer)
    h.timer = setTimeout(() => {
      h.timer = null
      const now = e.heldItem?.name || 'nothing'
      if (now === h.name) return
      h.name = now
      if (seenPlayer(bot, e)) record(`player: ${e.username} now holds ${now}`)
    }, HOLD_SETTLE_MS)
  })

  bot.on('entitySleep', (e) => { if (seenPlayer(bot, e)) record(`player: ${e.username} went to bed`) })
  bot.on('entityWake', (e) => { if (seenPlayer(bot, e)) record(`player: ${e.username} got out of bed`) })

  bot.on('playerLeft', (p) => { held.delete(p?.username); crouches.delete(p?.username) })
}

module.exports = { bind }
