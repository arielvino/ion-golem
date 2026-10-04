// physicsEpsilonFix.js — collide like vanilla: a box touching a block face is touching it.
//
// prismarine-physics 1.11.1 (AABB.computeOffsetX/Y/Z) stops a move only at blocks lying
// entirely beyond the player's box: other.maxX <= this.minX. The server parks a player
// flush against a wall by subtracting the half-width from the face, and in doubles
// -2.0 - 0.3 + 0.3 is -1.9999999999999998: a hair inside the block. That block is then
// skipped, the client walks into it, the server ("moved wrongly!") snaps it back, every
// tick — the bot stands frozen at the wall while the pathfinder re-plans the same move.
// Vanilla's collision (VoxelShape.collide) allows 1.0E-7; this does the same.
//
// Must be required before mineflayer (its physics plugin uses this AABB class).
const AABB = require('prismarine-physics/lib/aabb')

const EPS = 1e-7

AABB.prototype.computeOffsetX = function (other, offsetX) {
  if (other.maxY > this.minY + EPS && other.minY < this.maxY - EPS && other.maxZ > this.minZ + EPS && other.minZ < this.maxZ - EPS) {
    if (offsetX > 0.0 && other.maxX <= this.minX + EPS) offsetX = Math.max(0, Math.min(this.minX - other.maxX, offsetX))
    else if (offsetX < 0.0 && other.minX >= this.maxX - EPS) offsetX = Math.min(0, Math.max(this.maxX - other.minX, offsetX))
  }
  return offsetX
}

AABB.prototype.computeOffsetY = function (other, offsetY) {
  if (other.maxX > this.minX + EPS && other.minX < this.maxX - EPS && other.maxZ > this.minZ + EPS && other.minZ < this.maxZ - EPS) {
    if (offsetY > 0.0 && other.maxY <= this.minY + EPS) offsetY = Math.max(0, Math.min(this.minY - other.maxY, offsetY))
    else if (offsetY < 0.0 && other.minY >= this.maxY - EPS) offsetY = Math.min(0, Math.max(this.maxY - other.minY, offsetY))
  }
  return offsetY
}

AABB.prototype.computeOffsetZ = function (other, offsetZ) {
  if (other.maxX > this.minX + EPS && other.minX < this.maxX - EPS && other.maxY > this.minY + EPS && other.minY < this.maxY - EPS) {
    if (offsetZ > 0.0 && other.maxZ <= this.minZ + EPS) offsetZ = Math.max(0, Math.min(this.minZ - other.maxZ, offsetZ))
    else if (offsetZ < 0.0 && other.minZ >= this.maxZ - EPS) offsetZ = Math.min(0, Math.max(this.maxZ - other.minZ, offsetZ))
  }
  return offsetZ
}
