// retreat.js — reflex against being swarmed.
//
// Three zombies and two spiders kill a bot with a stone sword that stands its ground:
// it can hit one at a time while every other one hits it. So when several melee
// hostiles close in, run for open floor, away from all of them at once. Whatever
// catches up (spiders outrun a sprinting player) gets turned on and struck, then the
// run continues. Once at most one is left close, stop: the fight reflexes take them
// one at a time. While this runs, the fight and eat reflexes stand down.
//
// Floor and walls come from the block DB (dbBlock), never bot.blockAt (x-ray).
const state = require('../core/state')
const { PASSABLE, HAZARDS } = require('../config/blocks')

const SWARM_RANGE = 8        // hostiles this close count toward a swarm
const SWARM_COUNT = 3        // this many → retreat; one fewer once HP is low
const LOW_HP = 10
const END_COUNT = 1          // retreat ends when at most this many are within SWARM_RANGE
const MIN_RETREAT_MS = 1500
const MAX_RETREAT_MS = 20000 // then fight anyway
const CORNERED_PAUSE_MS = 3000
const LOOKAHEAD = 6          // blocks scanned along each candidate direction
const SWING_RANGE = 3
const SWING_MS = 650         // sword attack cooldown
const DIRS = 16

function meleeHostiles(bot, range) {
  const { ARCHERS } = require('./rangedDefense')
  const { hasLineOfSight } = require('../perception/vision')
  const { isNeutral } = require('../perception/entityClass')
  const pos = bot.entity.position
  const eye = pos.offset(0, 1.62, 0)
  return Object.values(bot.entities).filter(e =>
    e.type === 'hostile' && !ARCHERS.has(e.name) && !isNeutral(e) && e !== bot.entity &&
    e.position.distanceTo(pos) < range &&
    hasLineOfSight(eye, e.position, e.height || 1.8)
  )
}

// How many blocks the bot can run straight along (dx,dz) on known, safe floor:
// level, or one block down.
function clearance(pos, dx, dz) {
  const { dbBlock } = require('../navigation/atomicSteps')
  const pass = (x, y, z) => { const n = dbBlock(x, y, z); return n !== null && PASSABLE.has(n) }
  const floor = (x, y, z) => { const n = dbBlock(x, y, z); return n !== null && !PASSABLE.has(n) && !HAZARDS.has(n) }
  let y = Math.floor(pos.y)
  for (let k = 1; k <= LOOKAHEAD; k++) {
    const x = Math.floor(pos.x + dx * k), z = Math.floor(pos.z + dz * k)
    if (!pass(x, y, z) || !pass(x, y + 1, z)) return k - 1
    if (floor(x, y - 1, z)) continue
    if (pass(x, y - 1, z) && floor(x, y - 2, z)) { y--; continue }
    return k - 1
  }
  return LOOKAHEAD
}

// Best direction to run from these hostiles: away from all of them (nearer ones
// weigh more), toward open floor. null when every way is blocked within 2 blocks.
function escapeDir(bot, hostiles) {
  const pos = bot.entity.position
  let ax = 0, az = 0
  for (const h of hostiles) {
    const dx = pos.x - h.position.x, dz = pos.z - h.position.z
    const d2 = Math.max(dx * dx + dz * dz, 1)
    ax += dx / d2; az += dz / d2
  }
  const al = Math.hypot(ax, az) || 1
  ax /= al; az /= al
  let best = null, bestScore = -Infinity
  for (let i = 0; i < DIRS; i++) {
    const a = (i / DIRS) * Math.PI * 2
    const dx = Math.cos(a), dz = Math.sin(a)
    const clear = clearance(pos, dx, dz)
    if (clear < 2) continue
    const score = (dx * ax + dz * az) + 1.5 * clear / LOOKAHEAD
    if (score > bestScore) { bestScore = score; best = { dx, dz, clear } }
  }
  return best
}

const tally = (hs) => {
  const c = {}
  for (const h of hs) c[h.name] = (c[h.name] || 0) + 1
  return Object.entries(c).map(([n, k]) => k > 1 ? `${n}×${k}` : n).join(', ')
}

function setupRetreat(interruptFn) {
  const bot = state.bot
  const { logEvent, sendChat } = require('../core/utils')
  let ticks = 0, run = null, corneredUntil = 0

  const release = () => {
    try { bot.setControlState('forward', false); bot.setControlState('sprint', false) } catch (e) {}
  }
  const end = (why) => {
    const moved = bot.entity.position.distanceTo(run.from)
    const secs = ((Date.now() - run.at) / 1000).toFixed(1)
    logEvent(`reflex: retreat over (${why}) after ${Math.round(moved)}m in ${secs}s, struck ${run.swings}x`)
    console.log(`  [RETREAT] over: ${why}, ${Math.round(moved)}m, ${secs}s, ${run.swings} swings`)
    release()
    state.retreating = false
    run = null
  }

  bot.on('death', () => { if (run) { run = null; state.retreating = false } })

  bot.on('physicsTick', () => {
    if (!bot.entity || bot.health <= 0) return
    const now = Date.now()
    ticks++

    if (!run) {
      if (ticks % 5 || now < corneredUntil || state.currentTask === 'fleeing') return
      const hs = meleeHostiles(bot, SWARM_RANGE)
      const need = bot.health <= LOW_HP ? SWARM_COUNT - 1 : SWARM_COUNT
      if (hs.length < need) return
      const dir = escapeDir(bot, hs)
      if (!dir) { corneredUntil = now + CORNERED_PAUSE_MS; return }
      interruptFn()                // drops a running attack; clears controls
      try { bot.pvp.stop() } catch (e) {}
      state.retreating = true
      run = { at: now, from: bot.entity.position.clone(), dir, swings: 0, lastSwing: 0 }
      logEvent(`reflex: swarmed by ${hs.length} (${tally(hs)}) at ${Math.round(bot.health)} HP → retreat`)
      console.log(`  [RETREAT] ${hs.length} hostiles (${tally(hs)}), HP=${Math.round(bot.health)}`)
      sendChat(`Too many of them (${tally(hs)}), falling back!`)
    }

    if (state.currentTask === 'fleeing') return end('flee action took over')
    const hs = meleeHostiles(bot, SWARM_RANGE)
    const age = now - run.at
    if (age > MIN_RETREAT_MS && hs.length <= END_COUNT) return end(hs.length ? 'one left' : 'clear')
    if (age > MAX_RETREAT_MS) return end('ran too long')
    if (ticks % 4 === 0) {
      const dir = escapeDir(bot, hs)
      if (!dir) { corneredUntil = now + CORNERED_PAUSE_MS; return end('cornered') }
      run.dir = dir
    }

    if (state.creeperReflex) return         // creeper reflex is steering
    // Something caught up: turn and strike it (knockback buys distance), then run on.
    const pos = bot.entity.position
    const close = hs.filter(e => e.position.distanceTo(pos) < SWING_RANGE)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0]
    if (close && now - run.lastSwing >= SWING_MS) {
      bot.lookAt(close.position.offset(0, (close.height || 1.8) * 0.8, 0), true).catch(() => {})
      bot.attack(close)
      run.lastSwing = now
      run.swings++
      return
    }
    if (now - run.lastSwing < 100) return   // let the swing land facing the target
    bot.look(Math.atan2(-run.dir.dx, -run.dir.dz), 0, true).catch(() => {})
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
  })
}

module.exports = { setupRetreat, escapeDir, meleeHostiles }
