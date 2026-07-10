// Block category sets used by vision and other modules

const TRANSPARENT = new Set([
  'air', 'cave_air', 'void_air', 'glass', 'glass_pane', 'water', 'tall_grass',
  'short_grass', 'fern', 'large_fern', 'torch', 'wall_torch', 'soul_torch',
  'redstone_torch', 'lantern', 'soul_lantern', 'chain', 'ladder', 'vine',
  'flower_pot', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'sugar_cane', 'dead_bush', 'seagrass',
  'tall_seagrass', 'kelp', 'kelp_plant', 'bamboo', 'bamboo_sapling',
  'sign', 'wall_sign', 'hanging_sign', 'banner', 'wall_banner',
  'iron_bars', 'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'mangrove_leaves',
  'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves',
  'moss_carpet', 'carpet', 'leaf_litter',
  // 'snow' (layer): a ~2px ground-hugging block that does NOT occlude sight, like
  // carpet/moss_carpet. Without this, the LOS raycaster (_rayClear/hasLineOfSight,
  // vision.js) treats it as a full opaque cube — falsely marking players/blocks behind
  // snowy ground as NOT_VISIBLE and starving terrain discovery (rays die on snow →
  // cells behind stay unknown → pathfinding fails). Still recorded to the blocks DB via
  // scanCandidates (which uses game opacity, not this set). Deep drifts (layers 6-8) do
  // occlude, but we only have the name, and natural snow is ~always 1 layer.
  'snow',
  'bush', 'flowering_bush', 'pink_petals',
  'open_eyeblossom', 'closed_eyeblossom', 'pitcher_plant', 'torchflower',
  'lily_pad', 'redstone_wire', 'light',
  // attached pods, crops, saplings, fungi and other non-solid vegetation
  // (no collision + see-through). Keep in sync with PASSABLE below.
  'cocoa', 'firefly_bush',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart',
  'pumpkin_stem', 'melon_stem', 'attached_pumpkin_stem', 'attached_melon_stem',
  'torchflower_crop', 'pitcher_crop',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
  'mangrove_propagule', 'azalea', 'flowering_azalea',
  'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus',
  'cave_vines', 'cave_vines_plant', 'glow_lichen', 'hanging_roots',
  'spore_blossom', 'small_dripleaf',
  'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'crimson_roots', 'warped_roots', 'nether_sprouts',
  'sea_pickle', 'frogspawn', 'end_rod',
])

const NOTABLE_TRANSPARENT = new Set([
  'water', 'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'mangrove_leaves',
  'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves',
  'vine', 'sugar_cane', 'bamboo', 'bamboo_sapling', 'dead_bush',
  'moss_carpet', 'kelp', 'kelp_plant',
  'tall_grass', 'short_grass', 'fern', 'large_fern',
  'snow',  // see-through ground cover; keep it surfaced as a seen block (see TRANSPARENT)
])

const PASSABLE = new Set([
  'air', 'cave_air', 'void_air',
  'tall_grass', 'short_grass', 'fern', 'large_fern', 'dead_bush',
  'bush', 'flowering_bush',
  'torch', 'wall_torch', 'soul_torch', 'redstone_torch',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'pink_petals',
  'open_eyeblossom', 'closed_eyeblossom', 'pitcher_plant', 'torchflower',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'moss_carpet', 'carpet', 'leaf_litter', 'lily_pad',
  // 'snow' = the layered snow block (NOT 'snow_block', which is a full solid cube).
  // minecraft-data marks it boundingBox=empty; per-layer collision heights are
  // [],.125,.25,.375,.5,.625,.75,.875 so layers 1-5 (≤0.5) auto-step (stepHeight 0.6,
  // no jump) — navigationally passable. The DB stores only the name (no layer count),
  // and natural surface snow is ~always 1 layer, so treat it as passable footing here
  // (also a guaranteed-supported SURFACE below). Deep drifts (layers 6-8) degrade to a
  // replan, not a jump.
  'snow',
  'sign', 'wall_sign', 'hanging_sign',
  'banner', 'wall_banner',
  'sugar_cane', 'redstone_wire', 'light',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
  // attached pods, crops, saplings, fungi and other non-collision vegetation.
  // vine has no collision in MC (was wrongly treated as solid footing).
  // Keep in sync with TRANSPARENT above.
  'cocoa', 'firefly_bush', 'vine',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart',
  'pumpkin_stem', 'melon_stem', 'attached_pumpkin_stem', 'attached_melon_stem',
  'torchflower_crop', 'pitcher_crop',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
  'mangrove_propagule', 'azalea', 'flowering_azalea',
  'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus',
  'cave_vines', 'cave_vines_plant', 'glow_lichen', 'hanging_roots',
  'spore_blossom', 'small_dripleaf',
  'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'crimson_roots', 'warped_roots', 'nether_sprouts',
  'sea_pickle', 'frogspawn', 'end_rod',
])

// Blocks that provide a walking surface even though they're passable.
// Bot's feet are IN these blocks (foot level), not on top.
// Floor below may not be solid (e.g. water under lily_pad).
const SURFACE = new Set([
  'lily_pad', 'carpet', 'moss_carpet',
  // 'snow' (layer): valid footing whose support is GUARANTEED. A snow layer can only
  // exist on top of a supporting block, so "snow in the DB" implies "solid support in
  // the world" — even when that under-block is null/occluded in our DB. So dropping onto
  // snow over unknown ground (dbCanDown's SURFACE exemption, atomicSteps.js:224) is always
  // safe — you land ON the snow, never through it. This is a stronger guarantee than
  // carpet/lily_pad (which can float over water/air). Without this, the bot refuses to
  // descend snowy terrain whenever the under-snow block is unseen (i.e. almost always).
  'snow',
])

const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'cobweb'])

// Liquid water in either still or flowing form. Used wherever a block name is
// tested for "is this water" (drowning checks, shore-finding, pathing).
const WATER_BLOCKS = new Set(['water', 'flowing_water'])

// Actively-burning blocks that deal fire damage while you stand in them.
// Narrower than HAZARDS (which also covers lava/cactus/etc.).
const FIRE_BLOCKS = new Set(['fire', 'soul_fire'])

// Empty, walk-through "air" across every dimension (overworld/cave/end).
// Use this instead of bare `=== 'air'` so cave_air/void_air aren't mistaken
// for solid blocks underground or in the End.
const STRUCTURAL_AIR = new Set(['air', 'cave_air', 'void_air'])

const RESOURCES = new Set([
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore', 'diamond_ore', 'deepslate_diamond_ore',
  'copper_ore', 'deepslate_copper_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'ancient_debris', 'nether_gold_ore', 'nether_quartz_ore',
])

// Blocks the bot can use for building stairs, pillars, bridges.
// Function tested against item.name. Includes common solid blocks.
const _PLACEABLE_NAMES = new Set([
  'cobblestone', 'mossy_cobblestone', 'cobbled_deepslate',
  'stone', 'smooth_stone', 'stone_bricks', 'mossy_stone_bricks',
  'dirt', 'coarse_dirt', 'rooted_dirt', 'mud', 'clay',
  'deepslate', 'polished_deepslate', 'deepslate_bricks', 'deepslate_tiles',
  'netherrack', 'basalt', 'polished_basalt', 'smooth_basalt', 'blackstone', 'polished_blackstone',
  'andesite', 'polished_andesite', 'granite', 'polished_granite', 'diorite', 'polished_diorite',
  'sandstone', 'smooth_sandstone', 'red_sandstone', 'smooth_red_sandstone',
  'sand', 'red_sand', 'gravel',
  'tuff', 'polished_tuff', 'calcite',
  'end_stone', 'end_stone_bricks', 'prismarine', 'prismarine_bricks', 'dark_prismarine',
  'bricks', 'nether_bricks', 'red_nether_bricks',
])
// Also match any terracotta variant (16 colors + plain + glazed)
function isPlaceable(name) {
  return _PLACEABLE_NAMES.has(name) || name.includes('terracotta')
}

module.exports = { TRANSPARENT, NOTABLE_TRANSPARENT, PASSABLE, SURFACE, HAZARDS, RESOURCES, WATER_BLOCKS, FIRE_BLOCKS, STRUCTURAL_AIR, isPlaceable }
