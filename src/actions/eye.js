// Eye of ender — throw one, read where it flies, pick it back up.
//
// Measured on 26.1: the eye spawns at the thrower (as an `eye_of_ender` entity of
// type "other"), flies dead straight 12 blocks toward the nearest stronghold while
// climbing ~8, hovers, and ~80 ticks after spawning is gone: it either drops as an
// item where it hovered or shatters (world_event 2003). The server sends its position
// every 4 ticks. With the stronghold within 12 blocks it flies onto that point
// instead. Each throw's ray goes into strongholdFinder, which crosses the rays.
// The dropped item spawns in the same tick the eye goes (often the same packet
// batch), so items are watched from the throw on, not from when the eye is gone.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { tickWait, raceAbort, AbortError, stopAll, isAborted } = require('../core/tick')
const { navigateTo } = require('../navigation/navigation')
const { glideAxis } = require('../navigation/atomicSteps')
const { logEvent } = require('../core/utils')
const { currentDim } = require('../world/memory')
const finder = require('../world/strongholdFinder')

const REACH = 12          // the eye's flight when the stronghold is further than this
const SPAWN_MS = 2000     // no eye entity by then: it didn't fly
const FLIGHT_MS = 6000    // spawn to gone is ~80 ticks
const DROP_MS = 1500      // after it's gone, an item this soon where it hovered = it dropped
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']   // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

const eyeCount = (bot) => bot.inventory.items().filter(i => i.name === 'ender_eye').reduce((n, i) => n + i.count, 0)

// Resolve with the first entity spawned matching `pred`, or null after `ms`.
function nextSpawn(bot, pred, ms) {
  return new Promise((resolve) => {
    const on = (e) => { if (pred(e)) { done(); resolve(e) } }
    const timer = setTimeout(() => { done(); resolve(null) }, ms)
    const done = () => { clearTimeout(timer); bot.removeListener('entitySpawn', on) }
    bot.on('entitySpawn', on)
  })
}

function gone(bot, entity, ms) {
  return new Promise((resolve) => {
    if (!bot.entities[entity.id]) return resolve(true)
    const on = (e) => { if (e.id === entity.id) { done(); resolve(true) } }
    const timer = setTimeout(() => { done(); resolve(false) }, ms)
    const done = () => { clearTimeout(timer); bot.removeListener('entityGone', on) }
    bot.on('entityGone', on)
  })
}

async function doEye(arg) {
  if (arg === 'clear') {
    finder.clear()
    logEvent('eye: forgot all eye throws')
    return true
  }
  stopAll()
  const bot = state.bot
  const fail = (why) => { console.log(`  [EYE] ${why}`); logEvent(`eye: ${why}`); return false }
  if (currentDim() !== 'overworld') return fail(`eyes of ender only point to strongholds in the overworld, I'm in the ${currentDim()}`)
  if (!eyeCount(bot)) return fail('no eye of ender')

  state.currentTask = 'throwing an eye of ender'
  const before = eyeCount(bot)
  let items, onItem
  try {
    const item = bot.inventory.items().find(i => i.name === 'ender_eye')
    if (bot.heldItem !== item) await raceAbort(bot.equip(item, 'hand'), 5000)
    const me = bot.entity.position
    const spawned = nextSpawn(bot, e => e.name === 'eye_of_ender' && e.position.distanceTo(me) < 3, SPAWN_MS)
    items = []
    onItem = (e) => { if (e.name === 'item') items.push(e) }
    bot.on('entitySpawn', onItem)
    bot.activateItem()
    bot.deactivateItem()
    const eye = await raceAbort(spawned, SPAWN_MS + 1000)
    if (!eye) return fail('the eye did not fly (no stronghold to point to?)')
    const o = eye.position.clone()
    const isGone = await raceAbort(gone(bot, eye, FLIGHT_MS), FLIGHT_MS + 1000)
    const last = eye.position.clone()
    if (!isGone) console.log(`  [EYE] still tracked after ${FLIGHT_MS}ms, reading it at ${last}`)
    const dx = last.x - o.x, dz = last.z - o.z, flown = Math.hypot(dx, dz)
    if (flown < 0.5) return fail(`the eye rose but didn't move sideways (from ${o.floored()})`)
    const ux = dx / flown, uz = dz / flown
    const close = flown < REACH - 0.5
    finder.addThrow(o.x, o.z, ux, uz)
    if (close) finder.setFound(last.x, last.z)

    // Dropped or shattered: an item appears where it hovered, or nothing does.
    const near = (e) => e.name === 'item' && e.position.distanceTo(last) < 2.5
    const drop = items.find(near) || await raceAbort(nextSpawn(bot, near, DROP_MS), DROP_MS + 1000)
    let fate = 'shattered'
    if (drop) {
      fate = 'dropped'
      await tickWait(1500)   // let it fall and settle
      // It can still roll, or merge into another stack nearby: chase where it is now.
      for (let i = 0; i < 3 && bot.entities[drop.id] && eyeCount(bot) < before && !isAborted(); i++) {
        const p = drop.position
        try { await navigateTo(p.x, p.y, p.z, 1, 15000, { noReachCheck: true }) } catch (e) { if (e instanceof AbortError) throw e }
        // "Within 1 block" can leave the item ~1.4m off, just outside pickup reach:
        // the last bit is a glide onto it (at most a block, so the walk got us here).
        if (bot.entities[drop.id] && Math.hypot(drop.position.x - bot.entity.position.x, drop.position.z - bot.entity.position.z) < 2) {
          await glideAxis(bot, 'x', drop.position.x)
          await glideAxis(bot, 'z', drop.position.z)
        }
        await raceAbort(gone(bot, drop, 1000), 2000)
      }
      fate = eyeCount(bot) >= before ? 'dropped, picked it back up' : `dropped at ${drop.position.floored()}, couldn't pick it up`
    }

    const bearing = `${compass(ux, uz)} (every 100 blocks: x${ux >= 0 ? '+' : ''}${Math.round(ux * 100)}, z${uz >= 0 ? '+' : ''}${Math.round(uz * 100)})`
    const where = close
      ? `flew onto ${Math.floor(last.x)},${Math.floor(last.z)}, ${flown.toFixed(1)}m away: the stronghold is under that spot`
      : `flew ${bearing} from ${Math.floor(o.x)},${Math.floor(o.z)}`
    console.log(`  [EYE] from ${o.x.toFixed(2)},${o.z.toFixed(2)} to ${last.x.toFixed(2)},${last.z.toFixed(2)} (${flown.toFixed(2)}m) → ${fate}`)
    logEvent(`eye: ${where}; ${fate}; ${eyeCount(bot)} left`)
    return true
  } catch (err) {
    if (err instanceof AbortError) throw err
    return fail(err.message)
  } finally {
    if (onItem) bot.removeListener('entitySpawn', onItem)
    state.currentTask = null
  }
}

module.exports = { doEye }
