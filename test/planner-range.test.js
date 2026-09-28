// The walk planner must plan to "within range" of a solid target (a log to chop), not onto
// its column — which is only standable from the treetop. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { optimisticAstar } = require('../src/navigation/pathplanner')

// Open grass field, one tree at (0,1..6,0) with a leaf canopy; the bot stands 13 south.
function field() {
  const world = new Map()
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 30; z++) {
    world.set(`${x},0,${z}`, 'grass_block')
    for (let y = 1; y <= 12; y++) world.set(`${x},${y},${z}`, 'air')
  }
  for (let y = 1; y <= 6; y++) world.set(`0,${y},0`, 'oak_log')
  for (let y = 7; y <= 8; y++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) world.set(`${dx},${y},${dz}`, 'oak_leaves')
  state.stmts = { getBlockAt: { get: (x, y, z) => { const n = world.get(`${x},${y},${z}`); return n ? { name: n } : undefined } } }
}

test('without a range, a trunk is unreachable (its column is solid)', () => {
  field()
  assert.equal(optimisticAstar(2, 1, 13, 0, 1, 0, 'safe', new Set()), null)
})

test('with the walk range, the plan walks straight up to the trunk', () => {
  field()
  const p = optimisticAstar(2, 1, 13, 0, 1, 0, 'safe', new Set(), 6000, 3)
  assert.ok(p, 'a path exists')
  assert.ok(p.length <= 14, `short path (${p.length} nodes)`)
  assert.ok(Math.max(...p.map(n => n.z)) <= 13, 'never walks away from the tree')
  const end = p[p.length - 1]
  assert.ok(Math.hypot(end.x + 0.5, end.y - 1, end.z + 0.5) <= 3.5, 'ends within range of the trunk')
})
