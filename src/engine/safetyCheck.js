// Moments the bot's own safety needs a look. The engine turns one into a
// [SAFETY] turn; weighing it, and putting a safety goal above the rest, is the
// model's call (SELF-PRESERVATION in the prompt). Each reason asks once: dusk
// once a day (again after a death), not healing once until HP is back above
// the line.
const state = require('../core/state')

const NIGHT_START = 13000      // hostiles spawn in the open from about here
const NIGHT_END = 23000
const DUSK_WARN = 4800         // ticks before night: 4 real minutes to get ready
const HURT_HP = 10
const REGEN_FOOD = 18          // below this, HP doesn't come back by itself

const isNight = (t) => t >= NIGHT_START && t < NIGHT_END
function ticksToNight(t) {
  if (isNight(t)) return 0
  return t < NIGHT_START ? NIGHT_START - t : 24000 - t + NIGHT_START
}
function fmtTicks(ticks) {
  const s = Math.round(ticks / 20)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function hasDayCycle(bot) {
  return (bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') === 'overworld'
}

// Context fields: how long until night (or, at night, until day), real time.
function timeLine(bot) {
  if (!hasDayCycle(bot) || bot.time?.timeOfDay == null) return ''
  const t = bot.time.timeOfDay
  return isNight(t) ? ` night_now day_in=${fmtTicks(NIGHT_END - t)}` : ` night_in=${fmtTicks(ticksToNight(t))}`
}

// Context field: HP that is down and won't come back until the bot eats.
function regenLine(bot) {
  return bot.health < 20 && bot.food < REGEN_FOOD ? ` regen=off(food<${REGEN_FOOD})` : ''
}

const asked = { duskDay: null, hurt: false }

// Why the bot should stop and look at its own safety now, or null.
function safetyReason() {
  const bot = state.bot
  if (!bot?.entity || bot.game?.difficulty === 'peaceful') return null
  if (!(bot.health <= HURT_HP)) asked.hurt = false
  else if (!asked.hurt && bot.food < REGEN_FOOD) {
    asked.hurt = true
    return `HP ${Math.round(bot.health)}/20 and not healing: food ${Math.round(bot.food)}/20 is under ${REGEN_FOOD}`
  }
  if (!hasDayCycle(bot) || bot.time?.timeOfDay == null) return null
  const t = bot.time.timeOfDay
  const left = ticksToNight(t)
  if (left <= DUSK_WARN && asked.duskDay !== bot.time.day) {
    asked.duskDay = bot.time.day
    return left === 0 ? `it is night: hostiles spawn in the dark until day in ${fmtTicks(NIGHT_END - t)}`
      : `night in ${fmtTicks(left)}`
  }
  return null
}

// A death drops everything: the night has to be weighed again with nothing.
function onDeath() { asked.duskDay = null; asked.hurt = false }

module.exports = { safetyReason, timeLine, regenLine, onDeath, ticksToNight, fmtTicks, _asked: asked }
