// projectileGuard.js — reflex against any incoming projectile.
//
// A projectile spawns as an entity whose spawn packet carries its velocity and its
// shooter (objectData). The server sends a projectile's position only every few
// ticks, so the guard keeps its own copy, taken on each spawn and velocity packet
// (velocity from mineflayer's entity, which its handlers have already updated), and
// plays the vanilla flight physics forward to see whether, and in how many ticks,
// the projectile meets the bot. Then, on physicsTick:
//   - ghast fireball or wind charge: return it. A melee hit sends it off along the
//     hitter's look, so look at the shooter and swing once it's within reach;
//   - shield in the off-hand: face the projectile and raise the shield early enough
//     for its 5-tick warm-up;
//   - otherwise: sidestep out of its path.
// A blaze's small fireball can't be deflected; it's blocked or dodged. Archers are
// answered earlier still, from the bow draw, by rangedDefense.
const { Vec3 } = require('vec3')
const state = require('../core/state')

// Vanilla flight: hurting projectiles accelerate along their heading,
// v = (v + v̂·0.1)·0.95; arrows and thrown items fall, v = v·0.99 − g.
// Wind charges, shulker bullets and rockets are taken to fly straight on.
const ACCELERATING = new Set(['fireball', 'small_fireball', 'wither_skull', 'dragon_fireball'])
const GRAVITY = { arrow: 0.05, spectral_arrow: 0.05, trident: 0.05, llama_spit: 0.06, splash_potion: 0.05, lingering_potion: 0.05 }
const RETURNABLE = new Set(['fireball', 'wind_charge', 'breeze_wind_charge'])
const HARMLESS = new Set(['fishing_bobber', 'ender_pearl', 'experience_bottle', 'egg', 'snowball'])

const HORIZON = 30        // ticks of flight looked ahead
const MARGIN = 0.3        // blocks of slack around the bot's hitbox
const REACH = 3.0         // melee reach, eye to projectile
const SHIELD_LEAD = 12    // raise the shield this many ticks before impact (warm-up is 5)
const DODGE_LEAD = 20     // start sidestepping this many ticks before impact
const DODGE_MAX = 20      // never strafe longer than this for one projectile
const SHIELD_HOLD_MS = 300
const SUMMARY_AFTER_MS = 3000
const GONE_KEEP_MS = 2000   // a destroyed projectile stays known this long, for its damage_event
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']   // +x east, +z south

// Which way it came from: against its flight, 'the E', or 'above' if it fell steeply.
function cameFrom(vel) {
  const s = vel.norm()
  if (s < 1e-9) return 'nowhere'
  if (vel.y < -0.7 * s) return 'above'
  if (vel.y > 0.7 * s) return 'below'
  const a = Math.atan2(-vel.z, -vel.x)
  return 'the ' + COMPASS[(Math.round(a / (Math.PI / 4)) + 8) % 8]
}

// The projectile behind the bot's latest damage, set by the guard's damage_event
// listener just before mineflayer emits entityHurt for the same packet.
let lastShot = null
function takeShot() { const s = lastShot; lastShot = null; return s }

// Ticks into the segment p→q at which it enters the box, or null. Slab test.
function segmentHitsBox(p, q, min, max) {
  let t0 = 0, t1 = 1
  for (const a of ['x', 'y', 'z']) {
    const d = q[a] - p[a]
    if (Math.abs(d) < 1e-9) { if (p[a] < min[a] || p[a] > max[a]) return null; continue }
    let ta = (min[a] - p[a]) / d, tb = (max[a] - p[a]) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb)
    if (t0 > t1) return null
  }
  return t0
}

function step(name, p, v) {
  const np = p.plus(v)
  if (ACCELERATING.has(name)) {
    const s = v.norm()
    return [np, s > 1e-9 ? v.plus(v.scaled(0.1 / s)).scaled(0.95) : v]
  }
  const g = GRAVITY[name]
  if (g) { const nv = v.scaled(0.99); nv.y -= g; return [np, nv] }
  return [np, v]
}

function setupProjectileGuard() {
  const bot = state.bot
  const { logEvent } = require('../core/utils')
  const { entityTag } = require('../perception/entityTag')
  const { nearestArcher } = require('./rangedDefense')
  const { _pKnownSolid } = require('../navigation/blockquery')
  const hasShield = () => bot.inventory.slots[45]?.name === 'shield'

  let tick = 0
  const tracked = new Map()   // id → { name, owner, pos, vel, at, seen, origin, answered, swings, dodged }
  let raised = false, lastShieldThreat = 0
  let dodge = null            // { id, dir: Vec3, until }
  const gone = new Map()      // id → tracked entry, kept GONE_KEEP_MS after entity_destroy
  // Per shooter, one journal record per encounter rather than one per projectile.
  const tally = new Map()     // owner tag → { kind, shield, dodge, returned, hit, last }
  const count = (t, key) => {
    const r = tally.get(t.ownerTag) || { kind: t.name, shield: 0, dodge: 0, returned: 0, hit: 0, last: 0 }
    r[key]++; r.last = Date.now(); r.from = cameFrom(t.vel); tally.set(t.ownerTag, r)
  }

  // mineflayer's own spawn_entity/entity_velocity handlers run first; copy, since it mutates.
  const velOf = (id) => bot.entities[id]?.velocity?.clone()
  bot._client.on('spawn_entity', (p) => {
    const name = bot.registry.entities[p.type]?.name
    if (bot.registry.entitiesByName[name]?.type !== 'projectile' || HARMLESS.has(name)) return
    if (p.objectData && p.objectData === bot.entity?.id) return   // our own
    const pos = new Vec3(p.x, p.y, p.z)
    const owner = bot.entities[p.objectData]
    tracked.set(p.entityId, {
      name, owner: p.objectData, ownerTag: owner ? entityTag(owner) : 'unseen shooter',
      pos, vel: velOf(p.entityId) || new Vec3(0, 0, 0), at: tick, seen: pos.clone(), origin: pos.clone(),
      answered: null, swings: 0
    })
  })
  bot._client.on('entity_velocity', (p) => {
    const t = tracked.get(p.entityId)
    if (!t) return
    const v = velOf(p.entityId)
    if (!v) return
    if (t.swings && t.vel.dot(v) < 0 && !t.returned) {
      t.returned = true
      count(t, 'returned')
      console.log(`  [PROJ] returned ${t.name} to ${t.ownerTag}`)
    }
    // Comes with a position update for the same server tick, which physicsTick
    // picks up as the new anchor.
    t.vel = v
  })
  bot._client.on('entity_destroy', (p) => {
    for (const id of p.entityIds) {
      const t = tracked.get(id)
      if (!t) continue
      tracked.delete(id)
      t.goneAt = Date.now()
      gone.set(id, t)
      if (dodge?.id === id) endDodge()
    }
  })
  // Damage to the bot names the projectile that did it (sourceDirectId) and its
  // shooter (sourceCauseId), each as id + 1. Ahead of mineflayer's own listener,
  // which turns the packet into entityHurt.
  bot._client.prependListener('damage_event', (p) => {
    if (p.entityId !== bot.entity?.id) return
    const id = p.sourceDirectId - 1
    const t = tracked.get(id) || gone.get(id)
    if (!t) { lastShot = null; return }
    count(t, 'hit')
    const shooter = bot.entities[p.sourceCauseId - 1] || bot.entities[t.owner]
    const from = cameFrom(t.vel)
    const dist = shooter?.isValid ? `, ${Math.round(shooter.position.distanceTo(bot.entity.position))}m` : ''
    lastShot = { name: t.name, from, shooter: shooter?.isValid ? shooter : null,
      text: `${t.name} from ${from} (${t.ownerTag}${dist})` }
  })
  bot.on('death', () => { tracked.clear(); gone.clear(); raised = false; dodge = null })

  // Where it is now and the tick it meets the bot's hitbox (from now), or null.
  function predict(t) {
    const pos = bot.entity.position
    const r = (bot.registry.entitiesByName[t.name]?.width || 0.5) / 2 + MARGIN
    const min = new Vec3(pos.x - 0.3 - r, pos.y - r, pos.z - 0.3 - r)
    const max = new Vec3(pos.x + 0.3 + r, pos.y + (bot.entity.height || 1.8) + r, pos.z + 0.3 + r)
    const elapsed = tick - t.at
    let p = t.pos, v = t.vel, now = t.pos
    for (let k = 0; k < elapsed + HORIZON; k++) {
      const [np, nv] = step(t.name, p, v)
      if (k >= elapsed) {
        const f = segmentHitsBox(p, np, min, max)
        if (f !== null) return { now, eta: k - elapsed + f, dir: v.norm() > 1e-9 ? v.normalize() : null }
      } else now = np
      p = np; v = nv
    }
    return null
  }

  function endDodge() {
    for (const c of ['forward', 'back', 'left', 'right']) bot.setControlState(c, false)
    dodge = null
  }

  // Strafe toward a world direction, whatever way the bot is facing.
  function steer(dir) {
    const yaw = bot.entity.yaw
    const f = dir.x * -Math.sin(yaw) + dir.z * -Math.cos(yaw)
    const r = dir.x * Math.cos(yaw) + dir.z * -Math.sin(yaw)
    bot.setControlState('forward', f > 0.35); bot.setControlState('back', f < -0.35)
    bot.setControlState('right', r > 0.35); bot.setControlState('left', r < -0.35)
  }

  // Sideways off the projectile's line: away from it if already off-centre,
  // and not into a known wall.
  function dodgeDir(threat) {
    const h = new Vec3(threat.dir.x, 0, threat.dir.z)
    if (h.norm() < 1e-6) h.x = 1   // falling straight down: any side will do
    const side = new Vec3(-h.z, 0, h.x).normalize()
    const rel = bot.entity.position.minus(threat.now)
    const first = side.dot(rel) >= 0 ? side : side.scaled(-1)
    const p = bot.entity.position
    const open = (d) => !_pKnownSolid(Math.floor(p.x + d.x), Math.floor(p.y), Math.floor(p.z + d.z)) &&
      !_pKnownSolid(Math.floor(p.x + d.x), Math.floor(p.y + 1), Math.floor(p.z + d.z))
    return open(first) ? first : first.scaled(-1)
  }

  bot.on('physicsTick', () => {
    tick++
    if (!bot.entity || bot.health <= 0) return
    const now = Date.now()
    for (const [id, t] of gone) if (now - t.goneAt > GONE_KEEP_MS) gone.delete(id)
    for (const [owner, r] of tally) {
      if (now - r.last < SUMMARY_AFTER_MS) continue
      tally.delete(owner)
      const did = [r.returned && `returned ${r.returned}`, r.shield && `blocked ${r.shield}`,
        r.dodge && `sidestepped ${r.dodge}`, r.hit && `took ${r.hit} hit${r.hit > 1 ? 's' : ''}`].filter(Boolean).join(', ')
      logEvent(`reflex: ${did} vs ${owner}'s ${r.kind} from ${r.from}`)
      console.log(`  [PROJ] ${did} vs ${owner}'s ${r.kind} from ${r.from}`)
    }

    // Re-anchor on fresh server positions; pick the projectile that lands first.
    let threat = null
    for (const [id, t] of tracked) {
      const e = bot.entities[id]
      if (e && !e.position.equals(t.seen)) { t.seen = e.position.clone(); t.pos = t.seen.clone(); t.at = tick }
      if (t.returned || t.vel.norm() < 0.05) continue
      const hit = predict(t)
      if (hit && (!threat || hit.eta < threat.eta)) threat = { ...hit, t, id, entity: e }
    }

    if (dodge && (!threat || threat.id !== dodge.id || tick > dodge.until)) endDodge()
    if (!threat) {
      if (raised && now - lastShieldThreat > SHIELD_HOLD_MS) {
        if (!bot.pvp?.target && !state.creeperReflex && !nearestArcher(bot, 24, true)) bot.deactivateItem()
        raised = false
      }
      return
    }
    const { t } = threat

    if (RETURNABLE.has(t.name) && threat.entity) {
      if (raised) { bot.deactivateItem(); raised = false }
      const shooter = bot.entities[t.owner]
      const aim = shooter?.isValid ? shooter.position.offset(0, (shooter.height || 1.8) * 0.6, 0) : t.origin
      bot.lookAt(aim, true).catch(() => {})
      if (!t.answered) { t.answered = 'return'; console.log(`  [PROJ] ${t.name} from ${t.ownerTag}, ${threat.eta.toFixed(1)}t out → return`) }
      const [next] = step(t.name, threat.now, t.vel)
      const eye = bot.entity.position.offset(0, 1.62, 0)
      if (next.distanceTo(eye) <= REACH || threat.now.distanceTo(eye) <= REACH) {
        bot.attack(threat.entity)
        t.swings++
      }
      return
    }

    if (hasShield()) {
      if (threat.eta > SHIELD_LEAD) return
      lastShieldThreat = now
      bot.lookAt(threat.now, true).catch(() => {})
      if (!raised) {
        bot.activateItem(true)
        raised = true
      }
      if (!t.answered) {
        t.answered = 'shield'
        count(t, 'shield')
        console.log(`  [PROJ] ${t.name} from ${t.ownerTag}, ${threat.eta.toFixed(1)}t out → shield`)
      }
      return
    }

    if (threat.eta > DODGE_LEAD || !threat.dir) return
    if (!dodge) {
      dodge = { id: threat.id, dir: dodgeDir(threat), until: tick + DODGE_MAX }
      if (!t.answered) {
        t.answered = 'dodge'
        count(t, 'dodge')
        console.log(`  [PROJ] ${t.name} from ${t.ownerTag}, ${threat.eta.toFixed(1)}t out → sidestep`)
      }
    }
    steer(dodge.dir)
  })
}

module.exports = { setupProjectileGuard, takeShot }
