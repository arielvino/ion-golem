// Context fields for the bot's own safety: how long until night (or day), and
// whether lost HP is coming back. Facts only — weighing them is the model's job
// (SELF-PRESERVATION in the prompt), every turn.
const NIGHT_START = 13000      // hostiles spawn in the open from about here
const NIGHT_END = 23000
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

// After time=: real time until night, or at night until day.
function timeLine(bot) {
  if (!hasDayCycle(bot) || bot.time?.timeOfDay == null) return ''
  const t = bot.time.timeOfDay
  return isNight(t) ? ` night_now day_in=${fmtTicks(NIGHT_END - t)}` : ` night_in=${fmtTicks(ticksToNight(t))}`
}

// After food=: HP that is down and won't come back until the bot eats.
function regenLine(bot) {
  return bot.health < 20 && bot.food < REGEN_FOOD ? ` regen=off(food<${REGEN_FOOD})` : ''
}

module.exports = { timeLine, regenLine }
