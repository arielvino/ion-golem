// gazeGuard.js — reflex: never look an enderman in the eyes.
//
// An enderman within 64 blocks turns on a player whose look passes within
// acos(1 - 0.025/dist) of the line from the player's eyes to its own (vanilla's
// EnderMan.isBeingStaredBy). Far off that cone is only a degree or two wide, but an
// enderman's head on level ground sits a degree or two off the horizon, so walking
// with the head level (the pathfinder's look(yaw, 0)) stares down every enderman
// ahead. Every look goes through bot.look (lookAt and the pathfinder call it), so
// the guard wraps it: the yaw is kept, it steers the walk, and the pitch is bent the
// least it takes to clear every calm enderman's cone. An enderman already angry is
// left out: there's nothing to provoke, and melee has to aim at it.
// Between looks an enderman can walk into the gaze, so each tick re-checks it.
const state = require('../core/state')

const RANGE = 64
const EYE = 1.62               // the bot's eye height
const ENDER_EYE = 2.55         // an enderman's
const MARGIN = 2 * Math.PI / 180
const STEP = Math.PI / 180
const LOG_MS = 5000

function setupGazeGuard() {
  const bot = state.bot
  if (bot._gazeGuard) return
  bot._gazeGuard = true
  const creepy = bot.registry.entitiesByName.enderman?.metadataKeys?.indexOf('creepy')
  const look = bot.look.bind(bot)
  const logged = new Map()     // enderman id → ms last logged

  // The calm endermen in range: unit vector from the bot's eyes to each one's, and
  // the half-angle of its stare cone with the margin.
  function cones() {
    const eye = bot.entity.position.offset(0, EYE, 0)
    const out = []
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'enderman' || (creepy >= 0 && e.metadata?.[creepy])) continue
      const to = e.position.offset(0, ENDER_EYE, 0).minus(eye)
      const d = to.norm()
      if (d > RANGE || d < 1e-3) continue
      out.push({ e, d, u: to.scaled(1 / d), half: Math.acos(1 - 0.025 / d) + MARGIN })
    }
    return out
  }
  const inCone = (yaw, pitch, c) => {
    const x = -Math.sin(yaw) * Math.cos(pitch), y = Math.sin(pitch), z = -Math.cos(yaw) * Math.cos(pitch)
    return x * c.u.x + y * c.u.y + z * c.u.z > Math.cos(c.half)
  }
  // The pitch nearest the asked one that's in no cone; looking down wins a tie.
  function safePitch(yaw, pitch) {
    const cs = cones()
    const hit = cs.find(c => inCone(yaw, pitch, c))
    if (!hit) return pitch
    for (let k = 1; k <= 180; k++) {
      for (const p of [pitch - k * STEP, pitch + k * STEP]) {
        if (p < -Math.PI / 2 || p > Math.PI / 2) continue
        if (!cs.some(c => inCone(yaw, p, c))) {
          const now = Date.now()
          if (now - (logged.get(hit.e.id) || 0) > LOG_MS) {
            logged.set(hit.e.id, now)
            console.log(`  [GAZE] enderman#${hit.e.id} at ${hit.d.toFixed(0)}m → pitch ${(pitch * 180 / Math.PI).toFixed(0)}° to ${(p * 180 / Math.PI).toFixed(0)}°`)
          }
          return p
        }
      }
    }
    return pitch
  }

  bot.look = (yaw, pitch, force) => look(yaw, safePitch(yaw, pitch), force)
  bot.on('physicsTick', () => {
    const { yaw, pitch } = bot.entity
    const p = safePitch(yaw, pitch)
    if (p !== pitch) look(yaw, p, true).catch(() => {})
  })
}

module.exports = { setupGazeGuard }
