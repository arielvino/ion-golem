// Getting to a dropped item.
//
// The server hands an item over when the bot's hitbox, grown by 1 block sideways and
// 0.5 up and down, touches the item's. The pathfinder works in whole blocks and stops
// in the middle of one, so a walk that ends in the next block can leave a drop at the
// far side of its own block just out of range. dropGoal aims the walk at the drop's
// own block when the bot can stand there, so the bot walks onto it. Where it can't (a
// one-high nook, the top of a wall), closeIn takes the last step: it presses against
// the wall, as a player would.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { dbBlock } = require('../navigation/atomicSteps')
const { PASSABLE } = require('../config/blocks')
const T = require('../config/timings')

const PLAYER_HALF_WIDTH = 0.3, PLAYER_HEIGHT = 1.8, ITEM_HALF = 0.125, ITEM_HEIGHT = 0.25
const NOT_FLOOR = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])

// Is the item at `i` within the server's pickup reach of a player at `p`, up and down?
// Walking never changes that, only how far apart they are sideways.
function inVerticalReach(p, i) {
  return i.y + ITEM_HEIGHT > p.y - 0.5 && i.y < p.y + PLAYER_HEIGHT + 0.5
}

// Would the server hand over an item at `i` to a player standing at `p`?
function inPickupRange(p, i) {
  const side = PLAYER_HALF_WIDTH + 1 + ITEM_HALF
  return Math.abs(i.x - p.x) < side && Math.abs(i.z - p.z) < side && inVerticalReach(p, i)
}

// y of the block a drop rests on, also when that is a path or slab top below a whole y
// (and while the drop still bounces a little above it).
const floorY = (i) => Math.ceil(i.y - 0.2) - 1

// Where to walk for `item`, as navigateTo's x, y, z and range: the drop's own block
// when the blocks DB says the bot fits there on a solid floor, else within a block of it.
function dropGoal(item) {
  const i = item.position
  const x = Math.floor(i.x), z = Math.floor(i.z), fy = floorY(i)
  const floor = dbBlock(x, fy, z), feet = dbBlock(x, fy + 1, z), head = dbBlock(x, fy + 2, z)
  const standable = floor && !NOT_FLOOR.has(floor) && PASSABLE.has(feet) && PASSABLE.has(head)
  return { x, y: Math.floor(i.y), z, range: standable ? 0 : 1 }
}

// Walk straight at `item` until it's in pickup range, it's gone, or the bot stops
// getting closer (a wall). Only for a drop in the next block, on a floor the bot knows,
// and within the server's vertical reach: walking can't change the height between them.
async function closeIn(item, { maxMs = 1500, aborted = () => false } = {}) {
  const bot = state.bot
  const p = bot.entity.position, i = item.position
  if (!bot.entities[item.id] || inPickupRange(p, i)) return
  if (!inVerticalReach(p, i)) return
  const ix = Math.floor(i.x), iz = Math.floor(i.z)
  if (Math.abs(ix - Math.floor(p.x)) > 1 || Math.abs(iz - Math.floor(p.z)) > 1) return
  const floor = dbBlock(ix, floorY(i), iz)
  if (!floor || NOT_FLOOR.has(floor)) return

  const gap = () => Math.hypot(item.position.x - bot.entity.position.x, item.position.z - bot.entity.position.z)
  let best = gap(), still = 0
  const end = Date.now() + maxMs
  try {
    while (Date.now() < end && bot.entities[item.id] && !aborted()) {
      if (inPickupRange(bot.entity.position, item.position)) break
      await bot.lookAt(new Vec3(item.position.x, bot.entity.position.y + bot.entity.height * 0.9, item.position.z), true)
      bot.setControlState('forward', true)
      await bot.waitForTicks(1)
      const d = gap()
      if (d < best - 0.01) { best = d; still = 0 } else if (++still >= 3) break
    }
  } finally {
    bot.setControlState('forward', false)
  }
}

// Walk onto `item` and wait for the server to hand it over; true once it is gone. A drop
// that is still falling or bouncing can land a block over or a level down, so one still
// there after a walk gets another, aimed where it now lies: up to `trips` walks.
async function pickUp(item, { trips = 2, timeoutMs = T.PICKUP_NAV_TIMEOUT, aborted = () => false } = {}) {
  const bot = state.bot
  const { navigateTo } = require('../navigation/navigation')
  const { AbortError, sleep } = require('../core/tick')
  for (let trip = 0; trip < trips && bot.entities[item.id] && !aborted(); trip++) {
    const g = dropGoal(item)
    try {
      await navigateTo(g.x, g.y, g.z, g.range, timeoutMs)
      await closeIn(item, { aborted })
    } catch (e) {
      if (e instanceof AbortError) throw e
    }
    // The server hands the item over a tick or more after the hitboxes touch.
    for (let t = 0; t < T.PICKUP_SETTLE && bot.entities[item.id] && !aborted(); t += 50) await sleep(50)
  }
  return !bot.entities[item.id]
}

module.exports = { closeIn, dropGoal, inPickupRange, pickUp }
