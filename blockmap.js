// BlockMap — in-memory block lookup from DB + vision data
// Single source of truth for movement checks. No bot.blockAt (x-ray).
const { PASSABLE, SURFACE, HAZARDS, WATER_BLOCKS } = require('./config/blocks')
const { queryRegion } = require('./memory')

class BlockMap {
  constructor() {
    this.map = new Map() // "x,y,z" → blockName
  }

  // Load blocks from DB for a bounding box region
  loadRegion(x1, y1, z1, x2, y2, z2) {
    const blocks = queryRegion(x1, y1, z1, x2, y2, z2)
    for (const b of blocks) {
      this.map.set(`${b.x},${b.y},${b.z}`, b.name)
    }
    return blocks.length
  }

  // Overlay vision data (fresher than DB)
  mergeVision(visionResult) {
    if (!visionResult?.allBlocks) return
    for (const b of visionResult.allBlocks) {
      this.map.set(`${b.x},${b.y},${b.z}`, b.name)
    }
  }

  // Get block name at position, null if unknown
  get(x, y, z) {
    return this.map.get(`${x},${y},${z}`) || null
  }

  // Block is solid (not passable, not unknown)
  isSolid(x, y, z) {
    const name = this.get(x, y, z)
    if (name === null) return false // unknown = not provably solid
    return !PASSABLE.has(name)
  }

  // Block is passable (bot can move through it)
  isPassable(x, y, z) {
    const name = this.get(x, y, z)
    if (name === null) return false // unknown = not provably passable
    return PASSABLE.has(name)
  }

  // Block is a hazard
  isHazard(x, y, z) {
    const name = this.get(x, y, z)
    if (name === null) return false
    return HAZARDS.has(name)
  }

  // Block is a surface (lily_pad, carpet) — provides floor even though passable
  isSurface(x, y, z) {
    const name = this.get(x, y, z)
    if (name === null) return false
    return SURFACE.has(name)
  }

  // Block is water (forbidden until water module built)
  isWater(x, y, z) {
    const name = this.get(x, y, z)
    return WATER_BLOCKS.has(name)
  }

  // No data for this position
  isUnknown(x, y, z) {
    return this.get(x, y, z) === null
  }

  get size() { return this.map.size }
}

module.exports = { BlockMap }
