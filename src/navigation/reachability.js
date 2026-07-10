// ─── Reachability & last-meter digging ────────────────────────────
// Ray-based checks for the navigateTo arrival phase: is the target point
// physically reachable, and if not, which block is in the way to dig out.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { rayReachable, isDiagBlocked, PASSABLE, voxelCells } = require('../perception/vision')

// Find first non-passable block on ray from → to. Returns Vec3 or null.
// Shares the voxel stepping with vision._rayClear via voxelCells.
function findBlockingBlock(from, to) {
  const bot = state.bot
  for (const [bx, by, bz, lastBx, lastBy, lastBz] of voxelCells(from, to)) {
    // Diagonal corner check — return one of the solid corner blocks if passage is blocked
    if (isDiagBlocked(bot, lastBx, lastBy, lastBz, bx, by, bz, PASSABLE)) {
      // Return the first solid corner block we find (for digging)
      const cdx = bx !== lastBx, cdy = by !== lastBy, cdz = bz !== lastBz
      const corners = []
      if (cdx) corners.push(new Vec3(bx, lastBy, lastBz))
      if (cdy) corners.push(new Vec3(lastBx, by, lastBz))
      if (cdz) corners.push(new Vec3(lastBx, lastBy, bz))
      for (const cp of corners) {
        try {
          const cb = bot.blockAt(cp)
          if (cb && !PASSABLE.has(cb.name)) return cp
        } catch (e) { console.warn('  [NAV] LoS corner check err:', e.message) }
      }
    }
    try {
      const b = bot.blockAt(new Vec3(bx, by, bz))
      if (!b) return null
      if (!PASSABLE.has(b.name)) return new Vec3(bx, by, bz)
    } catch (e) { return null }
  }
  return null
}

// Get the effective reach target — opts.reachTarget (dynamic) or fallback to fixed target
function _getReachVec(opts, fallback) {
  if (opts.reachTarget) {
    const tp = typeof opts.reachTarget === 'function' ? opts.reachTarget() : opts.reachTarget
    if (tp) return tp instanceof Vec3 ? tp : new Vec3(tp.x, tp.y, tp.z)
  }
  return fallback
}

// Reachability check — returns true if target point is physically reachable
function _reachCheck(bot, tpVec) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const cx = Math.floor(tpVec.x) + 0.5
  const cy = tpVec.y
  const cz = Math.floor(tpVec.z) + 0.5
  const checkPoints = [
    new Vec3(cx, cy + 0.1, cz),
    new Vec3(cx, cy + 0.9, cz),
    new Vec3(cx, cy + 1.62, cz),
  ]
  return checkPoints.some(cp => rayReachable(eye, cp))
}

// Dig toward target — finds and digs first blocking block on ray.
// digBlock is required lazily: it lives in navigation.js, which requires this
// module, so a top-level require would form a cycle. By call time navigation.js
// is fully loaded, so the lazy require resolves to the real export.
async function _digToward(bot, tpVec) {
  const { digBlock } = require('./navigation')
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const cx = Math.floor(tpVec.x) + 0.5
  const cy = tpVec.y
  const cz = Math.floor(tpVec.z) + 0.5
  const blocking = findBlockingBlock(eye, new Vec3(cx, cy + 0.9, cz))
      || findBlockingBlock(eye, new Vec3(cx, cy + 0.1, cz))
      || findBlockingBlock(eye, new Vec3(cx, cy + 1.62, cz))
  if (blocking) {
    console.log(`  nav: blocked, digging at ${blocking}`)
    return await digBlock(blocking)
  }
  return false
}

module.exports = { findBlockingBlock, _getReachVec, _reachCheck, _digToward }
