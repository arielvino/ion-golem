// Ranged actions — shoot a bow at a mob or a block.
//
// Aim is solved, not guessed: the arrow is simulated tick by tick with the server's
// own physics (move by velocity, then drag ×0.99, then gravity −0.05 on y), and the
// pitch is bisected until the arc passes through the aim point. Moving targets are
// led by their observed velocity times the flight time.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { raceAbort, AbortError, stopAll } = require('../core/tick')
const { sendChat, fuzzyMatch, logEvent } = require('../core/utils')
const { logGameEvent } = require('../world/memory')
const { entityTag, tagOf, findTagged } = require('../perception/entityTag')

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

// Lowest pitch whose arc passes through (h, dy) relative to the launch point.
// The height at distance h rises with pitch up to the max-range angle, so scan
// upward for the first bracket and bisect it. null = out of range.
function solvePitch(h, dy, speed = BOW_SPEED) {
  const err = (p) => { const r = heightAt(h, p, speed); return r ? r.y - dy : -Infinity }
  const STEP = Math.PI / 360
  let lo = -Math.PI / 2 + 0.01, elo = err(lo)
  for (let p = lo + STEP; p < Math.PI / 2 - 0.01; p += STEP) {
    const e = err(p)
    if (elo < 0 && e >= 0) {
      let a = lo, b = p
      for (let i = 0; i < 30; i++) {
        const m = (a + b) / 2
        if (err(m) < 0) a = m; else b = m
      }
      const pitch = (a + b) / 2
      return { pitch, ticks: heightAt(h, pitch, speed).ticks }
    }
    lo = p; elo = e
  }
  return null
}

// Arrows leave from 0.1 below the eye.
function launchPoint(bot) {
  return bot.entity.position.offset(0, (bot.entity.eyeHeight ?? 1.62) - 0.1, 0)
}

// Yaw/pitch (mineflayer convention) to put an arrow through `point`, plus flight ticks.
function aimAt(bot, point) {
  const from = launchPoint(bot)
  const d = point.minus(from)
  const h = Math.sqrt(d.x * d.x + d.z * d.z)
  const sol = solvePitch(h, d.y)
  if (!sol) return null
  return { yaw: Math.atan2(-d.x, -d.z), pitch: sol.pitch, ticks: sol.ticks }
}

function findTarget(bot, targetName) {
  const m = targetName.match(/^(-?\d+),(-?\d+),(-?\d+)$/)
  if (m) return { block: new Vec3(+m[1] + 0.5, +m[2] + 0.5, +m[3] + 0.5) }
  const normalized = targetName.toLowerCase().replace(/s$/, '')
  const entity = tagOf(targetName) ? findTagged(targetName) : bot.nearestEntity(e => {
    if (e === bot.entity) return false
    const eName = (e.name || '').toLowerCase()
    const eUser = (e.username || '').toLowerCase()
    return (eName && fuzzyMatch(eName, normalized)) || (eUser && fuzzyMatch(eUser, normalized))
  })
  return entity ? { entity } : null
}

// Aim point for a target: a block's center, or a mob's chest (fence-height cover
// still leaves the upper body open), led by its velocity over the flight time.
function aimPoint(bot, target, vel) {
  if (target.block) return target.block
  const e = target.entity
  const base = e.position.offset(0, (e.height || 1.8) * 0.7, 0)
  let point = base, sol = null
  for (let i = 0; i < 3; i++) {   // flight time depends on the led point: iterate
    sol = aimAt(bot, point)
    if (!sol) return base
    point = base.plus(new Vec3(vel.x, 0, vel.z).scaled(sol.ticks))
  }
  return point
}

const ammoCount = (bot) => bot.inventory.items().filter(i => ARROWS.includes(i.name)).reduce((n, i) => n + i.count, 0)

// Fire one fully drawn arrow at the target. Resolves with the shot's outcome once
// the arrow has stopped or hit: { hit, miss } where miss is the arrow's closest
// approach to the aim point in blocks.
async function shootOnce(bot, target) {
  const vel = new Vec3(0, 0, 0)
  let lastPos = target.entity?.position.clone()
  let aim = null, ticks = 0, onTick = null
  bot.activateItem()
  // Resolves with null when drawn and aimed, or with why it can't shoot.
  const why = await raceAbort(new Promise((resolve) => {
    onTick = () => {
      if (target.entity) {
        if (!target.entity.isValid) return resolve('target gone')
        // Smoothed per-tick velocity from observed positions.
        const p = target.entity.position
        vel.scale(0.6).add(p.minus(lastPos).scaled(0.4))
        lastPos = p.clone()
      }
      const point = aimPoint(bot, target, vel)
      aim = aimAt(bot, point)
      if (aim) { bot.look(aim.yaw, aim.pitch, true); aim.point = point }
      // Release one tick after the final look so the server has our rotation.
      if (++ticks > FULL_DRAW_TICKS + 1 && aim) resolve(null)
      else if (ticks > FULL_DRAW_TICKS + 40) resolve('out of range')
    }
    bot.on('physicsTick', onTick)
  }), 10000).catch(e => { bot.deactivateItem(); throw e })
    .finally(() => bot.removeListener('physicsTick', onTick))
  bot.deactivateItem()
  if (why) throw new Error(why)
  return watchArrow(bot, target, aim)
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
  if (!target) { sendChat(`No ${targetName} nearby!`); return false }
  const label = target.entity ? entityTag(target.entity) : targetName
  state.currentTask = `shooting ${label}`

  state.shootingBow = true
  let hits = 0, shots = 0, killed = false
  try {
    if (bot.heldItem?.name !== 'bow') await raceAbort(bot.equip(bow, 'hand'), 5000)
    bot.deactivateItem()   // drop a raised shield; the draw needs the hands
    while (shots < count) {
      if (!creative && ammoCount(bot) === 0) { sendChat('Out of arrows.'); break }
      if (target.entity && !target.entity.isValid) break
      const r = await shootOnce(bot, target)
      shots++
      if (r.hit) hits++
      const dist = r.aim.point.distanceTo(launchPoint(bot))
      console.log(`  [BOW] shot ${shots} at ${label} ${dist.toFixed(1)}m pitch=${(r.aim.pitch * 180 / Math.PI).toFixed(1)}° → ${r.hit ? 'HIT' : r.miss === null ? 'miss (arrow out of sight)' : `landed ${r.miss.toFixed(2)}m from aim`}`)
    }
  } catch (err) {
    if (err instanceof AbortError) throw err
    console.log(`  [BOW] ${err.message}`)
  } finally {
    state.shootingBow = false
  }
  if (target.entity && !target.entity.isValid) {
    const pos = target.entity.position
    logGameEvent('kill', target.entity.name || target.entity.username, 1, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), { weapon: 'bow', tag: label, uuid: target.entity.uuid })
    killed = true
  }
  logEvent(`shoot: ${shots} arrows at ${label}, ${hits} hit${killed ? ', killed it' : ''}`)
  if (killed) sendChat('Got it!')
  state.currentTask = null
  return target.entity ? killed : shots > 0
}

module.exports = { doShoot, solvePitch, heightAt }
