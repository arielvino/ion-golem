// Action constants — placement offsets, block faces, fuel data

const { Vec3 } = require('vec3')

const offsets = [
  [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
  [1,0,1],[-1,0,-1],[1,0,-1],[-1,0,1],
  [0,1,0],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
  [0,-1,0],[1,-1,0],[-1,-1,0],[0,-1,1],[0,-1,-1],
  [2,0,0],[-2,0,0],[0,0,2],[0,0,-2],
]

const faces = [
  { off: new Vec3(0,-1,0), face: new Vec3(0,1,0) },
  { off: new Vec3(1,0,0), face: new Vec3(-1,0,0) },
  { off: new Vec3(-1,0,0), face: new Vec3(1,0,0) },
  { off: new Vec3(0,0,1), face: new Vec3(0,0,-1) },
  { off: new Vec3(0,0,-1), face: new Vec3(0,0,1) },
]

const fuelRates = {
  'coal': 8, 'charcoal': 8, 'coal_block': 80, 'lava_bucket': 100, 'blaze_rod': 12,
  'dried_kelp_block': 20, 'bamboo': 0.25, 'stick': 0.5
}

const fuelNames = [
  'coal', 'charcoal', 'coal_block',
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
  'cherry_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'bamboo_planks',
  'oak_log', 'birch_log', 'spruce_log', 'stick',
]

module.exports = { offsets, faces, fuelRates, fuelNames }
