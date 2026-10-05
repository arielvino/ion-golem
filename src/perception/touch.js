// touch.js — which blocks does the bot honestly know of, and can it touch one right now?
//
// A player can only use or break a block it can SEE and REACH: the client picks the block
// under the crosshair by a ray from the eye that stops at the first block in the way and
// ends at arm's length. The vanilla server checks only the distance, not the sightline, so
// nothing stops a bot from opening a furnace through the floor. The bot holds itself to the
// client's rule here.
//
// Knowing of a block follows the same honesty as vision (visibility.js): loaded chunk data
// only proposes candidates, a line-of-sight test decides what is seen now, and anything
// else must come from the blocks DB, which only vision writes.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { blockVisible } = require('./visibility')

// Survival block_interaction_range: from the eye to the nearest point of the block.
const REACH = 4.5

// What a click passes through. Narrower than what sight passes through: glass, leaves,
// grass and torches can be seen through but not clicked through — the crosshair stops
// on them. Fluids are not targetable, so a click goes through water and lava.
const CLICK_THROUGH = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column', 'light'])

function eyeOf(bot) {
  return bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
}

// Distance from `eye` to the nearest point of the unit cell at (x,y,z).
function reachDistance(eye, x, y, z) {
  const dx = Math.max(x - eye.x, 0, eye.x - (x + 1))
  const dy = Math.max(y - eye.y, 0, eye.y - (y + 1))
  const dz = Math.max(z - eye.z, 0, eye.z - (z + 1))
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// { ok:true, dist } | { ok:false, reason:'out_of_reach'|'not_visible', dist }
function canTouch(pos) {
  const eye = eyeOf(state.bot)
  const dist = reachDistance(eye, pos.x, pos.y, pos.z)
  if (dist > REACH) return { ok: false, reason: 'out_of_reach', dist }
  if (!blockVisible(eye, pos.x, pos.y, pos.z, CLICK_THROUGH)) return { ok: false, reason: 'not_visible', dist }
  return { ok: true, dist }
}

// Human-readable reason, for failure records and logs.
function touchFailText(name, pos, t) {
  const at = `${name} at ${pos.x},${pos.y},${pos.z}`
  if (t.reason === 'out_of_reach') return `${at} is out of reach (${t.dist.toFixed(1)}m from my eyes, reach ${REACH}m)`
  if (t.reason === 'not_visible') return `${at} is behind blocks — no clear line to it from here`
  return `${at}: ${t.reason}`
}

// Blocks of these types the bot honestly knows of, nearest first: the ones in sight right
// now, then the ones remembered in the DB. Returns [{ pos: Vec3, name, seen: 'now'|'memory' }].
function findKnownBlocks(names, { maxDistance = 32, count = 10 } = {}) {
  const bot = state.bot
  const nameSet = new Set(names)
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  const eye = eyeOf(bot)
  const here = bot.entity.position
  const out = new Map()

  for (const p of bot.findBlocks({ matching: ids, maxDistance, count: 64 })) {
    if (!blockVisible(eye, p.x, p.y, p.z)) continue
    out.set(`${p.x},${p.y},${p.z}`, { pos: p, name: bot.blockAt(p)?.name, seen: 'now' })
  }
  for (const name of nameSet) {
    let rows = []
    try { rows = state.stmts.queryByName.all(name, here.x, here.x, here.y, here.y, here.z, here.z, count) } catch (e) {}
    for (const r of rows) {
      const key = `${r.x},${r.y},${r.z}`
      const pos = new Vec3(r.x, r.y, r.z)
      if (out.has(key) || pos.distanceTo(here) > maxDistance) continue
      out.set(key, { pos, name: r.name, seen: 'memory' })
    }
  }
  return [...out.values()]
    .sort((a, b) => a.pos.distanceTo(here) - b.pos.distanceTo(here))
    .slice(0, count)
}

// Walk until the block can be touched: first to within 3 blocks, then — if it is still
// out of reach or hidden (the bottom of a pit, a chest round a corner) — right up to it.
// Returns the final canTouch result, or null when aborted.
async function approachToTouch(pos, timeoutMs) {
  const { navigateTo } = require('../navigation/navigation')
  const { isAborted } = require('../core/tick')
  let t = canTouch(pos)
  for (const range of [3, 1]) {
    if (t.ok) break
    await navigateTo(pos.x, pos.y, pos.z, range, timeoutMs)
    if (isAborted()) return null
    t = canTouch(pos)
  }
  return t
}

// Walk up to a known block and make sure it can be touched. `accept(block)` says whether
// the block now there is still the thing we came for. Returns { block } or { why }.
async function reachKnownBlock(pos, accept, label, timeoutMs) {
  const t = await approachToTouch(pos, timeoutMs)
  if (!t) return { why: 'aborted' }
  if (!t.ok) return { why: touchFailText(label, pos, t) }
  const b = state.bot.blockAt(pos)
  if (!b || !accept(b)) {
    // In sight and in reach, so this is a real observation: the block is gone.
    require('../world/memory').removeBlock(pos.x, pos.y, pos.z)
    return { why: `${label} at ${pos.x},${pos.y},${pos.z} is gone (now ${b ? b.name : 'unloaded'})`, gone: true }
  }
  return { block: b }
}

module.exports = { REACH, eyeOf, reachDistance, canTouch, touchFailText, findKnownBlocks, approachToTouch, reachKnownBlock }
