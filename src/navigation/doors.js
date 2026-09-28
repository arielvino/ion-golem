// doors.js — walking through wooden doors and fence gates the way a player does: open the
// one in the way (or shut an open one that swung across the path), step through, and
// leave it as you found it.
//
// The planner and the step checks treat an openable door as walkable (flat steps only);
// the live door state is read here, right before the step, from the cell next to the bot —
// and it is only clicked when canTouch says it is in reach and in sight.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { isOpenable } = require('../config/blocks')

const isOpen = (b) => { const o = b.getProperties().open; return o === true || o === 'true' }

// Does this door / gate block movement along `axis` ('x' | 'z') right now?
// A door is a thin slab: closed, its plane faces `facing`; open, it swings 90° to the hinge
// side. So it blocks exactly one axis, and opening swaps which. A closed gate blocks the
// cell; an open gate has no collision at all.
function blocksAxis(b, axis) {
  if (b.name.endsWith('_fence_gate')) return !isOpen(b)
  const facing = b.getProperties().facing
  const facingAxis = (facing === 'north' || facing === 'south') ? 'z' : 'x'
  const normal = isOpen(b) ? (facingAxis === 'x' ? 'z' : 'x') : facingAxis
  return normal === axis
}

// The block that holds the door's state and gets clicked: the lower half of a door.
function doorAt(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y, z))
  if (!b || !isOpenable(b.name)) return null
  if (b.name.endsWith('_door') && b.getProperties().half === 'upper') {
    const lower = bot.blockAt(new Vec3(x, y - 1, z))
    return lower && lower.name === b.name ? lower : null
  }
  return b
}

// The face of `pos` that points toward the bot (what the crosshair would hit first).
function faceToward(bot, pos) {
  const p = bot.entity.position
  const dx = p.x - (pos.x + 0.5), dz = p.z - (pos.z + 0.5)
  if (Math.abs(dx) < 0.3 && Math.abs(dz) < 0.3) return new Vec3(0, 1, 0)
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}

// Click the door and wait (≤1s) for the server to confirm the new state.
async function toggle(bot, door) {
  const { canTouch } = require('../perception/touch')
  if (!canTouch(door.position).ok) return false
  const was = isOpen(door)
  await bot.activateBlock(door, faceToward(bot, door.position))
  for (let i = 0; i < 20; i++) {
    await bot.waitForTicks(1)
    const now = bot.blockAt(door.position)
    if (now && now.name === door.name && isOpen(now) !== was) return true
  }
  return false
}

const where = (b) => `${b.name} at ${b.position.x},${b.position.y},${b.position.z}`

// Before a flat step from (cx,cy,cz) along (dx,dz): open any door or gate in this cell or
// the next that blocks the move. Returns { ok } or { ok:false, why }.
async function clearDoorway(bot, cx, cy, cz, dx, dz) {
  const axis = dx !== 0 ? 'x' : 'z'
  for (const [x, z] of [[cx, cz], [cx + dx, cz + dz]]) {
    const door = doorAt(bot, x, cy, z) || doorAt(bot, x, cy + 1, z)
    if (!door || !blocksAxis(door, axis)) continue
    const wasOpen = isOpen(door)
    if (!(await toggle(bot, door))) return { ok: false, why: `${where(door)} didn't ${wasOpen ? 'close' : 'open'}` }
    console.log(`  [door] ${wasOpen ? 'closed' : 'opened'} ${where(door)} to get through`)
    state.doorToRestore = { x: door.position.x, y: door.position.y, z: door.position.z, name: door.name, open: wasOpen }
  }
  return { ok: true }
}

// At the start of a step (and when a walk ends): once the bot has left the cell of the door
// it toggled, and isn't stepping back into it, put the door back the way it was.
async function restoreBehind(bot, nx, nz) {
  const d = state.doorToRestore
  if (!d) return
  const p = bot.entity.position
  const inside = Math.floor(p.x) === d.x && Math.floor(p.z) === d.z
  if (inside || (nx === d.x && nz === d.z)) return
  state.doorToRestore = null
  const door = bot.blockAt(new Vec3(d.x, d.y, d.z))
  if (!door || door.name !== d.name || isOpen(door) === d.open) return
  if (await toggle(bot, door)) console.log(`  [door] ${d.open ? 'opened' : 'closed'} ${where(door)} behind me, as I found it`)
}

module.exports = { blocksAxis, clearDoorway, restoreBehind }
