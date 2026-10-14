// gazeGuard.js — reflex: never look an enderman in the eyes.
//
// An enderman within 64 blocks turns on a player whose look passes within
// acos(1 - 0.025/dist) of the line from the player's eyes to its own (vanilla's
// Enderman.isBeingStaredBy). Far off that cone is only a degree or two wide, but an
// enderman's head on level ground sits a degree or two off the horizon, so walking
// with the head level (the pathfinder's look(yaw, 0)) stares down every enderman
// ahead.
//
// The guard works on what the server sees, the rotation in each outgoing packet,
// not on bot.look: mineflayer turns the sent head at most ~8.6° a tick, so in a
// turn the server's head sweeps through every yaw between the old look and the
// new one, and a look that is safe where it ends can still stare on the way. Each
// packet keeps its yaw, which steers the walk, and gets the pitch nearest its own
// that is clear of every calm enderman's cone. An enderman already angry is left
// out: there's nothing to provoke, and melee has to aim at it. A head held still
// sends nothing, so each tick also checks the last rotation sent against endermen
// that walked into it, and turns the head if one did.
const state = require('../core/state')

const RANGE = 64
const EYE = 1.62               // the bot's eye height
const ENDER_EYE = 2.55         // an enderman's
const MARGIN = 2 * Math.PI / 180
const STEP = Math.PI / 180
const LOG_MS = 5000
const toRad = Math.PI / 180

function setupGazeGuard() {
  const bot = state.bot
  if (bot._gazeGuard) return
  bot._gazeGuard = true
  const creepy = bot.registry.entitiesByName.enderman?.metadataKeys?.indexOf('creepy')
  const logged = new Map()     // enderman id → ms last logged
  let sent = null              // last rotation sent, mineflayer radians

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
            console.log(`  [GAZE] enderman#${hit.e.id} at ${hit.d.toFixed(0)}m → pitch ${(pitch / toRad).toFixed(0)}° to ${(p / toRad).toFixed(0)}°`)
          }
          return p
        }
      }
    }
    return pitch
  }

  // Packets carry vanilla degrees: yaw 0 = south, pitch positive = down.
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if ((name === 'look' || name === 'position_look') && params) {
      const yaw = Math.PI - params.yaw * toRad
      const pitch = safePitch(yaw, -params.pitch * toRad)
      sent = { yaw, pitch }
      // A copy: mineflayer keeps `params` as its record of what it last sent.
      if (pitch !== -params.pitch * toRad) return write(name, { ...params, pitch: Math.fround(-pitch / toRad) })
    }
    return write(name, params)
  }

  bot.on('physicsTick', () => {
    if (!sent) return
    const p = safePitch(sent.yaw, sent.pitch)
    if (p !== sent.pitch) bot.look(bot.entity.yaw, p, true).catch(() => {})
  })
}

module.exports = { setupGazeGuard }
