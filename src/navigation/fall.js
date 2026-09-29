// Fall measurement from the block DB — how far a step off an edge, or through a
// floor, would drop the bot, onto what, and for how much damage. Shared by the
// descend actions (digdown/jumpdown) and the around view in every context.
const { dbBlock } = require('./atomicSteps')
const { PASSABLE, HAZARDS, WATER_BLOCKS } = require('../config/blocks')

const SAFE_FALL = 3        // blocks a fall can span without damage
const MAX_SCAN = 64        // how far down a fall is measured
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

// Fall from standing at feet level `fromY` in column (x,z), cells fromY-1 downward.
// `open` = cells treated as air regardless of the DB (the floor about to be dug).
// Returns { blocks, landing, water, hazard, unknown } — `blocks` is how far the bot
// drops; `unknown` means the scan hit a cell nobody has seen before finding ground.
function measureFall(x, fromY, z, open = 0) {
  let blocks = 0
  for (let y = fromY - 1; y >= fromY - MAX_SCAN; y--) {
    if (fromY - 1 - y < open) { blocks++; continue }
    const name = dbBlock(x, y, z)
    if (name === null) return { blocks, unknown: true, at: y }
    if (WATER_BLOCKS.has(name)) return { blocks, water: true, landing: name, at: y }
    if (HAZARDS.has(name)) return { blocks, hazard: name, landing: name, at: y }
    if (PASSABLE.has(name)) { blocks++; continue }
    return { blocks, landing: name, at: y }
  }
  return { blocks, unknown: true, at: fromY - MAX_SCAN }
}

// The cell under a floor is hidden until the floor breaks. But a player standing on
// a pillar still knows: the columns beside it are open air all the way down. When
// our own column is unseen, read the neighbours' — if they open below the floor
// level, the shallowest of them bounds the drop. It is an upper bound, not a
// measurement: the pillar may well continue under the floor.
function neighbourFall(x, floorY, z) {
  let best = null
  for (const [dx, dz] of Object.values(DIRS)) {
    const beside = dbBlock(x + dx, floorY - 1, z + dz)
    if (beside === null || !PASSABLE.has(beside)) continue
    const f = measureFall(x + dx, floorY, z + dz)
    if (f.unknown || f.hazard) continue
    const est = { ...f, blocks: f.blocks + 1, estimated: true }
    if (!best || est.blocks < best.blocks) best = est
  }
  return best
}

const damageOf = (fall) => (fall.water ? 0 : Math.max(0, fall.blocks - SAFE_FALL))

function describeFall(fall) {
  if (fall.unknown) return `at least ${fall.blocks} blocks, landing unseen (y${fall.at} never looked at)`
  const onto = fall.water ? `into ${fall.landing}` : `onto ${fall.landing} at y${fall.at}`
  return `${fall.estimated ? 'about ' : ''}${fall.blocks} blocks ${onto}, ~${damageOf(fall)} damage${fall.estimated ? ' (judged from the open columns beside it)' : ''}`
}

module.exports = { SAFE_FALL, DIRS, measureFall, neighbourFall, damageOf, describeFall }
