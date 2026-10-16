// The last step to a dropped item.
//
// The pathfinder counts a walk to a drop as done once the bot stands within range
// of it, cell by cell, and stops in the middle of its cell. The server hands the
// item over only when the bot's hitbox, grown by 1 block sideways and 0.5 up and
// down, touches the item's. A drop in a one-high nook beside the bot can sit just
// outside that: the bot can't stand in the nook, and the middle of its own cell is
// ~1.5 blocks from the back of it. A player would step up against the wall; this
// does the same.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { dbBlock } = require('../navigation/atomicSteps')

const PLAYER_HALF_WIDTH = 0.3, PLAYER_HEIGHT = 1.8, ITEM_HALF = 0.125, ITEM_HEIGHT = 0.25
const NOT_FLOOR = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])

// Would the server hand over an item at `i` to a player standing at `p`?
function inPickupRange(p, i) {
  const side = PLAYER_HALF_WIDTH + 1 + ITEM_HALF
  return Math.abs(i.x - p.x) < side && Math.abs(i.z - p.z) < side &&
    i.y + ITEM_HEIGHT > p.y - 0.5 && i.y < p.y + PLAYER_HEIGHT + 0.5
}

// Walk straight at `item` until it's in pickup range, it's gone, or the bot stops
// getting closer (a wall). Only for a drop on the same floor in the next cell, on a
// floor the bot knows: anything further is a job for the pathfinder.
async function closeIn(item, { maxMs = 1500, aborted = () => false } = {}) {
  const bot = state.bot
  const p = bot.entity.position, i = item.position
  if (!bot.entities[item.id] || inPickupRange(p, i)) return
  if (Math.abs(i.y - p.y) > 0.6) return
  const ix = Math.floor(i.x), iz = Math.floor(i.z)
  if (Math.abs(ix - Math.floor(p.x)) > 1 || Math.abs(iz - Math.floor(p.z)) > 1) return
  const floor = dbBlock(ix, Math.floor(i.y + 0.01) - 1, iz)
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

module.exports = { closeIn, inPickupRange }
