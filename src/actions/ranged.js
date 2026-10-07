// Ranged actions — shoot a bow at a mob or a block.
//
// Aim is solved, not guessed: the arrow is simulated tick by tick with the server's
// own physics (move by velocity, then drag ×0.99, then gravity −0.05 on y), and the
// pitch is bisected until the arc passes through the aim point. Moving targets are
// led by their observed velocity times the flight time. The arc, not the sightline,
// must be clear of blocks: a flat shot that clips cover tries the head, the legs,
// then a lob. Only a target in sight is shot at.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { raceAbort, AbortError, stopAll } = require('../core/tick')
const { sendChat, fuzzyMatch, logEvent } = require('../core/utils')
const { logGameEvent } = require('../world/memory')
const { entityTag, tagOf, findTagged } = require('../perception/entityTag')
const { dbBlock } = require('../navigation/atomicSteps')
const { blockVisible } = require('../perception/visibility')

const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow']
const DRAG = 0.99
const GRAVITY = 0.05
const BOW_SPEED = 3.0        // blocks/tick at full draw
const FULL_DRAW_TICKS = 20   // power reaches 1.0 after 20 ticks of drawing
const MAX_FLIGHT_TICKS = 200
const MAX_SHOTS = 10

// Height of the arrow when it has flown `h` blocks horizontally, fired at `pitch`
// (radians, up positive) with `speed`. null if it never gets that far.
function heightAt(h, pitch, speed) {
  let x = 0, y = 0
  let vx = speed * Math.cos(pitch), vy = speed * Math.sin(pitch)
  for (let t = 1; t <= MAX_FLIGHT_TICKS; t++) {
    const nx = x + vx, ny = y + vy
    if (nx >= h) {
      const f = vx > 0 ? (h - x) / vx : 0
      return { y: y + vy * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    vx *= DRAG; vy = vy * DRAG - GRAVITY
    if (y < -200) return null
  }
  return null
}

// Every pitch whose arc passes through (h, dy) relative to the launch point: the
// flat shot first, then the lob, if they exist. Height at distance h rises with
// pitch up to the max-range angle and falls after it, so there are at most two
// crossings; scan for the brackets and bisect each.
function solvePitches(h, dy, speed = BOW_SPEED) {
  const err = (p) => { const r = heightAt(h, p, speed); return r ? r.y - dy : -Infinity }
  const STEP = Math.PI / 360
  const out = []
  let lo = -Math.PI / 2 + 0.01, elo = err(lo)
  for (let p = lo + STEP; p < Math.PI / 2 - 0.01 && out.length < 2; p += STEP) {
    const e = err(p)
    if ((elo < 0) !== (e < 0)) {
      let a = lo, b = p
      const rising = elo < 0
      for (let i = 0; i < 30; i++) {
        const m = (a + b) / 2
        if ((err(m) < 0) === rising) a = m; else b = m
      }
      const pitch = (a + b) / 2
      out.push({ pitch, ticks: heightAt(h, pitch, speed).ticks })
    }
    lo = p; elo = e
  }
  return out
}

// Arrows leave from 0.1 below the eye.
function launchPoint(bot) {
  return bot.entity.position.offset(0, (bot.entity.eyeHeight ?? 1.62) - 0.1, 0)
}

// Collision height of a block for an arrow: 0 = it flies through (air, plants,
// torches, liquids), 1.5 = fence/wall, 1 = anything else. A block in sight is read as
// it is now (and memory updated); one out of sight is what memory says, and unknown
// counts as clear: we only refuse a shot over what we've seen. Cached for a second,
// since the plan is redone every tick of the draw.
const heightCache = new Map()
let heightCacheAt = 0
function blockHeight(bot, x, y, z) {
  const now = Date.now()
  if (now - heightCacheAt > 1000) { heightCache.clear(); heightCacheAt = now }
  const k = `${x},${y},${z}`
  if (heightCache.has(k)) return heightCache.get(k)
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  let name = dbBlock(x, y, z)
  if (blockVisible(eye, x, y, z)) {
    const live = bot.blockAt(new Vec3(x, y, z))?.name
    if (live && live !== name) {
      try { state.stmts.upsertBlock.run(x, y, z, live, now) } catch (e) {}
      name = live
    }
  }
  let hgt = 0
  if (name && bot.registry.blocksByName[name]?.boundingBox === 'block') {
    hgt = /(_fence|_wall)$/.test(name) ? 1.5 : 1
  }
  heightCache.set(k, hgt)
  return hgt
}

// Walk the arc in ≤0.25-block steps from the launch point until it has covered the
// horizontal distance to the aim point; the first sample inside a block's collision
// box is the obstruction. `skip` is the target block itself.
function arcObstruction(bot, from, yaw, pitch, h, skip) {
  const dirX = -Math.sin(yaw), dirZ = -Math.cos(yaw)
  let x = 0, y = 0
  let vx = BOW_SPEED * Math.cos(pitch), vy = BOW_SPEED * Math.sin(pitch)
  for (let t = 0; t < MAX_FLIGHT_TICKS && x < h - 0.3; t++) {
    const n = Math.max(1, Math.ceil(Math.hypot(vx, vy) / 0.25))
    for (let i = 1; i <= n; i++) {
      const sx = x + vx * i / n
      if (sx >= h - 0.3) break   // at the target
      const px = from.x + dirX * sx, py = from.y + y + vy * i / n, pz = from.z + dirZ * sx
      const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz)
      if (skip && bx === skip.x && by === skip.y && bz === skip.z) continue
      if (blockHeight(bot, bx, by, bz) > py - by) return new Vec3(bx, by, bz)
      // A fence/wall reaches half a block into the cell above it.
      if (py - by < 0.5 && blockHeight(bot, bx, by - 1, bz) > 1) return new Vec3(bx, by - 1, bz)
    }
    x += vx; y += vy
    vx *= DRAG; vy = vy * DRAG - GRAVITY
  }
  return null
}

// Every way to put an arrow through `point`, flat shot first:
// [{ yaw, pitch, ticks, blocked }] in mineflayer's yaw/pitch convention.
function arcsTo(bot, point, skip) {
  const from = launchPoint(bot)
  const d = point.minus(from)
  const h = Math.sqrt(d.x * d.x + d.z * d.z)
  const yaw = Math.atan2(-d.x, -d.z)
  return solvePitches(h, d.y).map(s => ({
    yaw, pitch: s.pitch, ticks: s.ticks, point,
    blocked: arcObstruction(bot, from, yaw, s.pitch, h, skip)
  }))
}

function findTarget(bot, targetName) {
  const m = targetName.match(/^(-?\d+),(-?\d+),(-?\d+)$/)
  if (m) {
    const cell = new Vec3(+m[1], +m[2], +m[3])
    return { block: cell.offset(0.5, 0.5, 0.5), cell }
  }
  const normalized = targetName.toLowerCase().replace(/s$/, '')
  // A bare name means the nearest one in sight: a mob behind a wall can't be shot.
  const { hasLineOfSight } = require('../perception/vision')
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const entity = tagOf(targetName) ? findTagged(targetName) : bot.nearestEntity(e => {
    if (e === bot.entity) return false
    const eName = (e.name || '').toLowerCase()
    const eUser = (e.username || '').toLowerCase()
    return ((eName && fuzzyMatch(eName, normalized)) || (eUser && fuzzyMatch(eUser, normalized))) &&
      hasLineOfSight(eye, e.position, e.height || 1.8)
  })
  return entity ? { entity } : null
}

// Where to put the arrow on a mob, best first: chest, then head over low cover, then
// legs under an overhang.
const BODY_AIMS = [['chest', 0.7], ['head', 0.9], ['legs', 0.35]]

// The shot to take now: the first clear arc over the aim points, flat before lob.
// A mob is led by its velocity over that arc's flight time. Returns
// { yaw, pitch, ticks, point, arc } or { blocked } (the first obstruction) or null
// (out of range).
function planShot(bot, target, vel) {
  const firstBlock = { blocked: null }
  if (target.block) {
    const arcs = arcsTo(bot, target.block, target.cell)
    arcs.forEach((a, i) => { a.arc = i ? 'lob' : 'flat' })
    if (!arcs.length) return null
    return arcs.find(a => !a.blocked) || { blocked: arcs[0].blocked }
  }
  const e = target.entity
  let anyArc = false
  // Every flat option before any lob: a lob flies ~5s and scatters by metres.
  for (const arc of [0, 1]) {
    for (const [part, frac] of BODY_AIMS) {
      const base = e.position.offset(0, (e.height || 1.8) * frac, 0)
      let point = base, a = null
      for (let i = 0; i < 3; i++) {   // flight time depends on the led point: iterate
        a = arcsTo(bot, point)[arc]
        if (!a) break
        point = base.plus(new Vec3(vel.x, 0, vel.z).scaled(a.ticks))
      }
      if (!a) continue
      anyArc = true
      if (!a.blocked) { a.arc = arc ? 'lob' : 'flat'; a.part = part; return a }
      if (!firstBlock.blocked) firstBlock.blocked = a.blocked
    }
  }
  return anyArc ? firstBlock : null
}

const ammoCount = (bot) => bot.inventory.items().filter(i => ARROWS.includes(i.name)).reduce((n, i) => n + i.count, 0)

// Fire one fully drawn arrow at the target. Resolves with the shot's outcome once
// the arrow has stopped or hit: { hit, miss } where miss is the arrow's closest
// approach to the aim point in blocks.
// Put the bow down without firing: switching hotbar slots cancels a draw.
function cancelDraw(bot) {
  const slot = bot.quickBarSlot
  bot.setQuickBarSlot((slot + 1) % 9)
  bot.setQuickBarSlot(slot)
}

async function shootOnce(bot, target) {
  const vel = new Vec3(0, 0, 0)
  let lastPos = target.entity?.position.clone()
  let shot = null, ticks = 0, onTick = null
  bot.activateItem()
  // Resolves with null when drawn and aimed down a clear arc, or with why it can't shoot.
  const why = await raceAbort(new Promise((resolve) => {
    onTick = () => {
      if (target.entity) {
        if (!target.entity.isValid) return resolve('target gone')
        // Smoothed per-tick velocity from observed positions.
        const p = target.entity.position
        vel.scale(0.6).add(p.minus(lastPos).scaled(0.4))
        lastPos = p.clone()
      }
      const plan = planShot(bot, target, vel)
      shot = plan && !plan.blocked ? plan : null
      if (shot) bot.look(shot.yaw, shot.pitch, true)
      // Release one tick after the final look so the server has our rotation; past
      // full draw, hold until the arc is clear and the target isn't falling or
      // jumping (the lead only covers horizontal movement).
      const steady = !target.entity || Math.abs(vel.y) < 0.2
      if (++ticks > FULL_DRAW_TICKS + 1 && shot && steady) resolve(null)
      else if (ticks > FULL_DRAW_TICKS + 40) {
        resolve(plan ? `no clear shot (blocked at ${plan.blocked})` : 'out of range')
      }
    }
    bot.on('physicsTick', onTick)
  }), 10000).catch(e => { cancelDraw(bot); throw e })
    .finally(() => bot.removeListener('physicsTick', onTick))
  if (why) { cancelDraw(bot); throw new Error(why) }
  bot.deactivateItem()
  return watchArrow(bot, target, shot)
}

// Where our arrow ended up, and whether the target took damage meanwhile. The server
// sends an arrow's position only about once a second, so it can't be tracked in
// flight: wait past its flight time and read where it came to rest.
function watchArrow(bot, target, aim) {
  return new Promise((resolve) => {
    let arrow = null, ticks = 0, hit = false, goneAt = null
    const settle = Math.ceil(aim.ticks) + 25
    const onSpawn = (e) => {
      if (!arrow && ARROWS.includes(e.name) && e.position.distanceTo(launchPoint(bot)) < 3) arrow = e
    }
    const onHurt = (e) => { if (target.entity && e === target.entity) hit = true }
    const onTick = () => {
      // An arrow that hits a mob is removed, and the hurt can arrive a tick or two
      // later: give it a few ticks before calling the arrow lost.
      if (arrow && !arrow.isValid && goneAt === null) goneAt = ticks
      if (!hit && ++ticks < settle && (goneAt === null || ticks - goneAt < 6)) return
      bot.removeListener('entitySpawn', onSpawn)
      bot.removeListener('entityHurt', onHurt)
      bot.removeListener('physicsTick', onTick)
      resolve({ hit, miss: arrow?.isValid ? arrow.position.distanceTo(aim.point) : null, aim })
    }
    bot.on('entitySpawn', onSpawn)
    bot.on('entityHurt', onHurt)
    bot.on('physicsTick', onTick)
  })
}

// shoot:TARGET[:COUNT] — TARGET is a mob name, a nearby= tag, or X,Y,Z of a block.
// A mob is shot until it dies (at most COUNT arrows); a block gets COUNT arrows.
async function doShoot(arg) {
  stopAll()
  const bot = state.bot
  const parts = arg.split(':')
  const targetName = parts[0]
  const count = Math.max(1, parseInt(parts[1], 10) || (/^-?\d+,/.test(targetName) ? 1 : MAX_SHOTS))
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow) { sendChat('I have no bow.'); logEvent('shoot: no bow'); return false }
  const creative = bot.game.gameMode === 'creative'
  if (!creative && ammoCount(bot) === 0) { sendChat('I have no arrows.'); logEvent('shoot: no arrows'); return false }
  const target = findTarget(bot, targetName)
  if (!target) { sendChat(`No ${targetName} nearby!`); logEvent(`shoot: no ${targetName} nearby`); return false }
  const label = target.entity ? entityTag(target.entity) : targetName
  state.currentTask = `shooting ${label}`

  // Only a death counts as a kill: a mob that despawns or leaves tracking range is
  // gone from bot.entities too.
  let died = false
  const onDead = (e) => { if (e === target.entity) died = true }
  bot.on('entityDead', onDead)
  const { hasLineOfSight } = require('../perception/vision')
  const inSight = () => {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
    return target.entity
      ? hasLineOfSight(eye, target.entity.position, target.entity.height || 1.8)
      : blockVisible(eye, target.cell.x, target.cell.y, target.cell.z)
  }

  state.shootingBow = true
  let hits = 0, shots = 0, stop = null
  try {
    if (bot.heldItem?.name !== 'bow') await raceAbort(bot.equip(bow, 'hand'), 5000)
    bot.deactivateItem()   // drop a raised shield; the draw needs the hands
    while (shots < count) {
      if (!creative && ammoCount(bot) === 0) { stop = 'out of arrows'; break }
      if (target.entity && !target.entity.isValid) break
      if (!inSight()) { stop = shots ? `lost sight of ${label}` : `can't see ${label} from here`; break }
      const plan = planShot(bot, target, new Vec3(0, 0, 0))
      if (!plan) { stop = `${label} is out of bow range`; break }
      if (plan.blocked) {
        stop = `no clear shot at ${label}: the arc hits ${dbBlock(plan.blocked.x, plan.blocked.y, plan.blocked.z)} at ${plan.blocked}`
        break
      }
      const r = await shootOnce(bot, target)
      shots++
      if (r.hit) hits++
      const dist = r.aim.point.distanceTo(launchPoint(bot))
      console.log(`  [BOW] shot ${shots} at ${label} ${dist.toFixed(1)}m ${r.aim.arc}${r.aim.part ? ` at ${r.aim.part}` : ''} pitch=${(r.aim.pitch * 180 / Math.PI).toFixed(1)}° → ${r.hit ? 'HIT' : r.miss === null ? 'miss (arrow out of sight)' : `landed ${r.miss.toFixed(2)}m from aim`}`)
    }
  } catch (err) {
    if (err instanceof AbortError) throw err
    if (err.message !== 'target gone') stop = err.message
  } finally {
    state.shootingBow = false
    bot.removeListener('entityDead', onDead)
  }
  const killed = died
  if (killed) {
    const pos = target.entity.position
    logGameEvent('kill', target.entity.name || target.entity.username, 1, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), { weapon: 'bow', tag: label, uuid: target.entity.uuid })
  } else if (target.entity && !target.entity.isValid) {
    stop = `lost track of ${label}: it is gone but didn't die in view (despawned or out of range)`
  }
  if (stop) console.log(`  [BOW] ${stop}`)
  logEvent(`shoot: ${shots} arrows at ${label}, ${hits} hit${killed ? ', killed it' : ''}${stop ? ` — stopped: ${stop}` : ''}`)
  if (killed) sendChat('Got it!')
  state.currentTask = null
  return target.entity ? killed : shots > 0
}

module.exports = { doShoot, solvePitches, heightAt }
