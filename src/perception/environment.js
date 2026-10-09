// environment.js — weather and time-of-day changes, as journal records.
//
// The context shows the clock every turn but not the weather, and a clock reading
// can't tell the model that night just fell or that someone set the time: those are
// changes, so they become records (shown once, in NEW=).
const { logEvent } = require('../core/utils')

const JUMP_TICKS = 200          // clock off from elapsed game ticks by more than this = a jump
const SETTLE_MS = 3000          // login sends the current weather; that isn't a change
const THUNDER_ON = 0.5          // thunderState ramps 0→1; hysteresis so a ramp is one record
const THUNDER_OFF = 0.1

let bound = null

const hhmm = (t) => `${Math.floor(((t + 6000) % 24000) / 1000)}:${String(Math.floor((((t + 6000) % 1000) * 60) / 1000)).padStart(2, '0')}`
const phase = (t) => (t >= 0 && t < 13000 ? 'day' : 'night')

function record(text) {
  console.log(`  [EVT] ${text}`)
  logEvent(text)
}

// What the clock did between two 'time' readings: { jump } when it moved by other than
// the elapsed game ticks, { phase } when it ran normally into day or night, else null.
function timeChange(prev, cur) {
  if (!prev) return null
  const ran = cur.age - prev.age
  const moved = cur.time - prev.time
  if (cur.cycle && Math.abs(moved - ran) > JUMP_TICKS) return { jump: moved - ran }
  if (phase(prev.timeOfDay) !== phase(cur.timeOfDay)) return { phase: phase(cur.timeOfDay) }
  return null
}

function bind(bot) {
  if (bound === bot) return
  bound = bot
  const since = Date.now()
  const settled = () => Date.now() - since > SETTLE_MS

  let prev = null
  let cycle = null
  bot.on('time', () => {
    const t = bot.time
    const cur = { time: t.time, timeOfDay: t.timeOfDay, age: t.age, cycle: t.doDaylightCycle }
    const ch = timeChange(prev, cur)
    if (ch?.jump) record(`time: set ${hhmm(prev.timeOfDay)} → ${hhmm(cur.timeOfDay)}, now ${phase(cur.timeOfDay)}`)
    else if (ch?.phase === 'night') record(`time: night fell (${hhmm(cur.timeOfDay)})`)
    else if (ch?.phase === 'day') record(`time: day broke (${hhmm(cur.timeOfDay)})`)
    if (cycle !== null && cycle !== cur.cycle) record(`time: the daylight cycle ${cur.cycle ? 'runs again' : 'stopped'} at ${hhmm(cur.timeOfDay)}`)
    cycle = cur.cycle
    prev = cur
  })
  // Another dimension runs its own clock (the Nether's never moves): start over.
  bot.on('spawn', () => { prev = null; cycle = null })

  let raining = bot.isRaining
  bot.on('rain', () => {
    if (bot.isRaining === raining) return
    raining = bot.isRaining
    if (settled()) record(`weather: ${raining ? 'rain started' : 'rain stopped'}`)
  })

  let thunder = bot.thunderState > THUNDER_ON
  bot.on('weatherUpdate', () => {
    const now = thunder ? bot.thunderState > THUNDER_OFF : bot.thunderState > THUNDER_ON
    if (now === thunder) return
    thunder = now
    if (settled()) record(`weather: ${thunder ? 'thunderstorm started' : 'thunderstorm ended'}`)
  })

  // Whatever the weather was at login, say it once: the context never shows it.
  setTimeout(() => {
    if (bound !== bot) return
    if (thunder) record('weather: a thunderstorm is on (at login)')
    else if (raining) record('weather: it is raining (at login)')
  }, SETTLE_MS)
}

module.exports = { bind, timeChange }
