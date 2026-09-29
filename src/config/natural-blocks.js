// natural-blocks.js — which blocks are environment NOISE, and where.
//
// A block listed here is noise only inside its scope (a dimension, or a set of biomes). Anywhere
// else, and every block not listed at all, is a TELL: a structure, a portal, or a player's work
// (bricks, planks, any slab/stair/wall, glass, torches, rails, cobweb, ...). Tell is the default
// so that blocks added by future Minecraft versions count as tells until someone lists them.
//
// The scope is checked against the biome of the block itself, not of where the bot stands.
// A noise block is either TERRAIN (the area's material: summarized as name + %) or a RESOURCE:
// natural and normal but rare and worth going for, reported with count and nearest spot.
// Biome-scoped rules are strict: a badlands tree or terracotta band that crosses into the
// neighbouring river's biome cells reads as a tell (edge tolerance: TODO.md).

const OW = { dims: ['overworld'] }
const NETHER = { dims: ['the_nether'] }
const END = { dims: ['the_end'] }
const OW_NETHER = { dims: ['overworld', 'the_nether'] }
const ANYWHERE = { dims: ['overworld', 'the_nether', 'the_end'] }
const BADLANDS = { biomes: ['badlands', 'wooded_badlands', 'eroded_badlands'] }

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const CORALS = ['tube', 'brain', 'bubble', 'fire', 'horn']
const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']

const RULES = [
  [['air', 'cave_air', 'void_air'], ANYWHERE],

  // ---- overworld ground and rock
  [['stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'bedrock',
    'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'grass_block', 'mycelium', 'mud', 'clay',
    'sand', 'sandstone', 'snow', 'snow_block', 'powder_snow', 'ice', 'packed_ice', 'blue_ice',
    'water', 'bubble_column',
    'dripstone_block', 'pointed_dripstone', 'moss_block', 'moss_carpet', 'pale_moss_block', 'pale_moss_carpet',
    'infested_stone', 'infested_deepslate',          // windswept hills / mountains
    'obsidian',                                      // lava meeting water underground (ruined portals: see the_end note)
    'amethyst_block', 'budding_amethyst', 'amethyst_cluster', 'large_amethyst_bud',
    'medium_amethyst_bud', 'small_amethyst_bud', 'smooth_basalt',   // geodes
    'sculk', 'sculk_vein', 'sculk_sensor', 'sculk_catalyst', 'sculk_shrieker',
    'raw_iron_block', 'raw_copper_block',            // ore veins
    ...ORES.flatMap(o => [`${o}_ore`, `deepslate_${o}_ore`])], OW],
  [['red_sand', 'red_sandstone', 'terracotta', 'white_terracotta', 'orange_terracotta',
    'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta'], BADLANDS],
  [['mossy_cobblestone'], { biomes: ['old_growth_pine_taiga', 'old_growth_spruce_taiga'] }],   // boulders

  // ---- overworld plants
  [[...WOODS.flatMap(w => [`${w}_log`, `${w}_leaves`]), 'azalea_leaves', 'flowering_azalea_leaves',
    'mangrove_roots', 'muddy_mangrove_roots', 'mangrove_propagule', 'creaking_heart', 'pale_hanging_moss',
    'bee_nest', 'vine', 'glow_lichen', 'cocoa',
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'bush', 'dead_bush', 'short_dry_grass', 'tall_dry_grass',
    'firefly_bush', 'leaf_litter', 'pink_petals', 'wildflowers',
    'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip',
    'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony',
    'open_eyeblossom', 'closed_eyeblossom',
    'sugar_cane', 'cactus', 'cactus_flower', 'bamboo', 'bamboo_sapling', 'pumpkin', 'melon', 'sweet_berry_bush',
    'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem',
    'azalea', 'flowering_azalea', 'cave_vines', 'cave_vines_plant', 'spore_blossom', 'hanging_roots',
    'big_dripleaf', 'big_dripleaf_stem', 'small_dripleaf',
    'lily_pad', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'sea_pickle',
    ...CORALS.flatMap(c => [`${c}_coral_block`, `${c}_coral`, `${c}_coral_fan`, `${c}_coral_wall_fan`])], OW],
  [['brown_mushroom', 'red_mushroom', 'lava', 'magma_block', 'gravel'], OW_NETHER],

  // ---- nether
  [['netherrack', 'soul_sand', 'soul_soil', 'basalt', 'blackstone', 'glowstone', 'bedrock',
    'fire', 'soul_fire', 'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
    'bone_block', 'dried_ghast',                     // soul sand valley fossils and ghastlings
    'crimson_nylium', 'crimson_stem', 'nether_wart_block', 'crimson_roots', 'crimson_fungus', 'weeping_vines', 'weeping_vines_plant',
    'warped_nylium', 'warped_stem', 'warped_wart_block', 'warped_roots', 'warped_fungus', 'twisting_vines', 'twisting_vines_plant',
    'nether_sprouts', 'shroomlight'], NETHER],

  // ---- the end. Obsidian, iron bars and bedrock there are the spikes and the exit portal: tells.
  [['end_stone', 'chorus_plant', 'chorus_flower'], END],
]

// Resource block -> the name the model sees; ore variants merge ('deepslate_iron_ore' -> iron).
// Only counts where the block is noise: an ore block in the wrong dimension is unexplained.
const RESOURCE = new Map([
  ...ORES.flatMap(o => [[`${o}_ore`, o], [`deepslate_${o}_ore`, o]]),
  ['raw_iron_block', 'iron'], ['raw_copper_block', 'copper'],
  ['nether_gold_ore', 'gold'], ['nether_quartz_ore', 'quartz'], ['ancient_debris', 'ancient_debris'],
  ['budding_amethyst', 'amethyst'], ['amethyst_cluster', 'amethyst'], ['obsidian', 'obsidian'],
  ['glowstone', 'glowstone'],
  // food and crafting plants
  ['sugar_cane', 'sugar_cane'], ['pumpkin', 'pumpkin'], ['melon', 'melon'], ['cocoa', 'cocoa'],
  ['sweet_berry_bush', 'sweet_berries'], ['cave_vines', 'glow_berries'], ['cave_vines_plant', 'glow_berries'],
  ['bee_nest', 'bee_nest'], ['kelp', 'kelp'], ['kelp_plant', 'kelp'], ['bamboo', 'bamboo'],
  ['brown_mushroom', 'mushroom'], ['red_mushroom', 'mushroom'],
  ['brown_mushroom_block', 'mushroom'], ['red_mushroom_block', 'mushroom'],
])

const NOISE = new Map()   // name -> [scope]
for (const [names, scope] of RULES) for (const n of names) NOISE.set(n, [...(NOISE.get(n) || []), scope])

// True if this block is ordinary environment here; false means it tells of a structure or player.
function isNoise(name, dimension, biome) {
  const dim = String(dimension).replace('minecraft:', '')
  return (NOISE.get(name) || []).some(s => s.dims ? s.dims.includes(dim) : s.biomes.includes(biome))
}

// 'terrain' | 'resource' | null (not natural here: a structure, a portal or a player).
function roleOf(name, dimension, biome) {
  if (!isNoise(name, dimension, biome)) return null
  return RESOURCE.has(name) ? 'resource' : 'terrain'
}

module.exports = { isNoise, roleOf, NOISE, RESOURCE }
