// A player flush against a wall (box edge a float hair inside it) must still be stopped
// by it. Run: node --test
const test = require('node:test')
const assert = require('node:assert')

function aabb(fixed) {
  for (const k of Object.keys(require.cache)) if (k.includes('prismarine-physics') || k.includes('physicsEpsilonFix')) delete require.cache[k]
  if (fixed) require('../src/lib/physicsEpsilonFix')
  return require('prismarine-physics/lib/aabb')
}

// The real case: bot at x=-2.3 (half-width 0.3), grass block at x -2..-1, y 107..108.
function moveEast(AABB) {
  const block = new AABB(-2, 107, -91, -1, 108, -90)
  const player = new AABB(-2.3 - 0.3, 107.42, -90.8, -2.3 + 0.3, 109.22, -90.2)
  return block.computeOffsetX(player, 0.098)
}

test('flush against a wall: the move into it is stopped', () => {
  assert.strictEqual(moveEast(aabb(true)), 0)
})

test('unpatched prismarine-physics walks into the wall — the bug this fixes', () => {
  assert.strictEqual(moveEast(aabb(false)), 0.098)
})

test('standing on a floor a hair low still slides sideways freely', () => {
  const AABB = aabb(true)
  const floor = new AABB(0, 63, 0, 1, 64, 1)
  const player = new AABB(0.2, 63.99999999, 0.2, 0.8, 65.8, 0.8)   // a float hair into the floor
  assert.strictEqual(floor.computeOffsetX(player, 0.1), 0.1)
})

test('a wall a gap away still limits the move to the gap', () => {
  const AABB = aabb(true)
  const block = new AABB(1, 64, 0, 2, 65, 1)
  const player = new AABB(0.2, 64, 0.2, 0.8, 65.8, 0.8)
  assert.ok(Math.abs(block.computeOffsetX(player, 0.5) - 0.2) < 1e-9)
})
