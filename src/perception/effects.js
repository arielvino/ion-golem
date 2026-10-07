// effects.js — the status effects the bot itself is under (poison, regeneration, …).
//
// The server sends an effect's duration once, when it is applied; mineflayer keeps
// the packet but not when it came, so note the arrival time to report what's left.
const state = require('../core/state')

const appliedAt = new Map()   // effect id → ms the current instance arrived
let bound = null

function bind(bot) {
  if (bound === bot) return
  bound = bot
  appliedAt.clear()
  bot.on('entityEffect', (e, effect) => { if (e === bot.entity) appliedAt.set(effect.id, Date.now()) })
  bot.on('entityEffectEnd', (e, effect) => { if (e === bot.entity) appliedAt.delete(effect.id) })
}

const snake = (name) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()

// [{ name, level, secondsLeft }] — secondsLeft null for an infinite effect.
function activeEffects() {
  const bot = state.bot
  if (!bot?.entity) return []
  bind(bot)
  const out = []
  for (const effect of Object.values(bot.entity.effects || {})) {
    const info = bot.registry.effects[effect.id]
    const name = info ? snake(info.name) : `effect#${effect.id}`
    let secondsLeft = null
    if (effect.duration >= 0) {
      const since = appliedAt.has(effect.id) ? (Date.now() - appliedAt.get(effect.id)) / 1000 : 0
      secondsLeft = Math.max(0, Math.round(effect.duration / 20 - since))
    }
    out.push({ name, level: effect.amplifier + 1, secondsLeft })
  }
  return out
}

// " effects=poison2(8s),fire_resistance(∞)" — empty when none.
function contextLine() {
  const list = activeEffects()
  if (!list.length) return ''
  return ` effects=${list.map(e => `${e.name}${e.level > 1 ? e.level : ''}(${e.secondsLeft === null ? '∞' : `${e.secondsLeft}s`})`).join(',')}`
}

module.exports = { bind, activeEffects, contextLine }
