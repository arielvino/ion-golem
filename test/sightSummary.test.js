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

// Split by state, oak_leaves took three of the five slots and pushed vine out.
test('TERRAIN: one entry per block name, whatever states its blocks are in', () => {
  const view = [
    ...blocks('grass_block', stateId('grass_block', { snowy: false }), 30),
    ...blocks('dirt', null, 10),
    ...blocks('oak_leaves', stateId('oak_leaves', { distance: 1, persistent: false, waterlogged: false }), 15),
    ...blocks('oak_leaves', stateId('oak_leaves', { distance: 2, persistent: false, waterlogged: false }), 15),
    ...blocks('oak_leaves', stateId('oak_leaves', { distance: 3, persistent: false, waterlogged: false }), 10),
    ...blocks('vine', stateId('vine', { north: true, east: false, south: false, west: false, up: false }), 12),
    ...blocks('vine', stateId('vine', { north: false, east: true, south: false, west: false, up: false }), 8),
  ]
  const line = formatSight(summarizeSight({ dimension: 'overworld', eye, blocks: view }))
    .split('\n').find(l => l.startsWith('TERRAIN='))
  assert.strictEqual(line, 'TERRAIN=[swamp: oak_leaves 40%, grass_block 30%, vine 20%, dirt 10%]')
})
