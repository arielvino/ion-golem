// ─── Navigation goals (predicate-terminated) ──────────────────────
// A goal abstracts "where/when am I done". reachGoal = get within range of a
// point (positional). headingGoal = head a committed direction until a runtime
// condition (directional) — the late-binding that lets the AI say "dig west until
// a wall" without pre-resolving a coordinate. Both expose isDone(ctx)/progress(ctx)
// so the one driver (runStrategy in navigation.js) handles them uniformly.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const state = require('../core/state')
const { PASSABLE } = require('../perception/vision')

function _dirName(d) { const [x, z] = d; return x === 1 ? 'east' : x === -1 ? 'west' : z === 1 ? 'south' : z === -1 ? 'north' : '?' }

// Arrival is the pathfinder's own test, so walker and goal never disagree: GoalNear on
// whole blocks, at the feet block or the one above (the pathfinder checks both — a bot
// bobbing in water sits half a block off). Exact distance to the target's corner
// called a bot in the middle of the lake 2.6 > 2.5 away from where the pathfinder had
// already stopped, and every swim to a water spot reported failure.
function nearBlock(x, y, z, tx, ty, tz, range) {
  const g = new goals.GoalNear(tx, ty, tz, range)
  return g.isEnd({ x, y, z }) || g.isEnd({ x, y: y + 1, z })
}

function arrived(pos, tx, ty, tz, range) {
  return nearBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), tx, ty, tz, range)
}

function reachGoal(tx, ty, tz, range = 2) {
  const target = new Vec3(tx, ty, tz)
  return {
    kind: 'reach', target, range,
    isDone: () => arrived(state.bot.entity.position, tx, ty, tz, range),
    progress: () => -state.bot.entity.position.distanceTo(target),  // closer = higher
    desc: `reach ${tx},${ty},${tz}`,
  }
}

function headingGoal(dir, opts = {}) {
  const pattern = opts.pattern || 'flat'   // 'up' | 'down' | 'flat'
  const shape = opts.shape || 'straight'   // 'straight' | 'spiral' (spiral = future)
  const untilDesc = opts.untilDesc || 'stop'
  return {
    kind: 'heading', dir, pattern, shape,
    isDone: (ctx) => opts.until ? opts.until(ctx) : false,
    progress: (ctx) => ctx.advanced || 0,   // steps actually cut = higher
    desc: `head ${_dirName(dir)}${pattern !== 'flat' ? '/' + pattern : ''} until ${untilDesc}`,
  }
}

// Late-binding stop conditions for heading goals. Each returns a predicate(ctx).
const until = {
  depthAtMost: (y) => (ctx) => Math.round(state.bot.entity.position.y) <= y,
  heightAtLeast: (y) => (ctx) => Math.round(state.bot.entity.position.y) >= y,
  steps: (n) => (ctx) => (ctx.advanced || 0) >= n,
  // A real solid wall in the heading direction (body or head height). Uses the
  // live world (not the optimistic DB) so "until a wall" stops at an actual wall.
  blockedAhead: () => (ctx) => {
    const bot = state.bot, dir = ctx.goal.dir, p = bot.entity.position
    const cx = Math.floor(p.x), cy = Math.round(p.y), cz = Math.floor(p.z)
    const foot = bot.blockAt(new Vec3(cx + dir[0], cy, cz + dir[1]))
    const head = bot.blockAt(new Vec3(cx + dir[0], cy + 1, cz + dir[1]))
    return (foot && !PASSABLE.has(foot.name)) || (head && !PASSABLE.has(head.name))
  },
}

module.exports = { nearBlock, arrived, reachGoal, headingGoal, until, _dirName }
