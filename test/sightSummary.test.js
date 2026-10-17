// SIGHT summary layers (src/perception/sightSummary.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { summarizeSight, formatSight } = require('../src/perception/sightSummary')

state.bot = { registry: require('prismarine-registry')('26.1') }
const reg = state.bot.registry

// The state id of `name` with the given properties set (others at their defaults).
function stateId(name, props) {
  const b = reg.blocksByName[name]
  for (let id = b.minStateId; id <= b.maxStateId; id++) {
    const p = require('prismarine-block')(reg).fromStateId(id, 0).getProperties()
    if (Object.entries(props).every(([k, v]) => String(p[k]) === String(v))) return id
  }
  throw new Error(`no ${name} state ${JSON.stringify(props)}`)
}

const eye = { x: 0.5, y: 65.6, z: 0.5 }
let x = 0
const blocks = (name, id, n, biome = 'swamp') => Array.from({ length: n }, () => ({ id, name, x: x++, y: 64, z: 5, biome }))

const layer = (view, key) => formatSight(summarizeSight({ dimension: 'overworld', eye, blocks: view }))
  .split('\n').find(l => l.startsWith(key + '='))

// Split by state, oak_leaves took three of the five slots and pushed vine out.
test('DECOR: one entry per block name, whatever states its blocks are in', () => {
  x = 0
  const view = [
    ...blocks('grass_block', stateId('grass_block', { snowy: false }), 30),
    ...blocks('dirt', null, 10),
    ...blocks('oak_leaves', stateId('oak_leaves', { distance: 1, persistent: false, waterlogged: false }), 15),
    ...blocks('oak_leaves', stateId('oak_leaves', { distance: 2, persistent: false, waterlogged: false }), 15),
    ...blocks('oak_leaves', stateId('oak_leaves', { distance: 3, persistent: false, waterlogged: false }), 10),
    ...blocks('vine', stateId('vine', { north: true, east: false, south: false, west: false, up: false }), 12),
    ...blocks('vine', stateId('vine', { north: false, east: true, south: false, west: false, up: false }), 8),
  ]
  assert.strictEqual(layer(view, 'TERRAIN'), 'TERRAIN=[swamp: grass_block 75% (30), dirt 25% (10)]')
  assert.strictEqual(layer(view, 'DECOR'),
    'DECOR=[oak_leaves×40 nearest 40m E@40,64,5, vine×20 nearest 80m E@80,64,5]')
})

// The ground, what grows on it, the ores, and the blocks a structure is made of each get
// their own line; sugar cane is decoration, only ores are resources.
test('layers: terrain, decoration, ores and unnatural blocks are kept apart', () => {
  x = 0
  const view = [
    ...blocks('sand', null, 20, 'desert'),
    ...blocks('sugar_cane', null, 3, 'desert'),
    ...blocks('iron_ore', null, 1, 'desert'),
    ...blocks('deepslate_iron_ore', null, 1, 'desert'),
    ...blocks('cut_sandstone', null, 4, 'desert'),
  ]
  assert.strictEqual(layer(view, 'TERRAIN'), 'TERRAIN=[desert: sand 100% (20)]')
  assert.strictEqual(layer(view, 'DECOR'), 'DECOR=[sugar_cane×3 nearest 21m E@20,64,5]')
  assert.strictEqual(layer(view, 'RESOURCES'), 'RESOURCES=[iron×2 nearest 24m E@23,64,5]')
  assert.strictEqual(layer(view, 'UNNATURAL'), 'UNNATURAL=[cut_sandstone×4 nearest 26m E@25,64,5 (to 28m)]')
})
