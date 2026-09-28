// fingerprints.js — the cues that give a place away.
//
// A human recognizes a village from a glimpse of a few things that belong together —
// planks, a fence, an iron golem — without seeing the whole of it. Each entry here is
// one kind of place and the cues that betray it, weighted by how much a single sighting
// says: a bell is nearly proof of a village, planks alone are just "somebody built
// something". A cue shared by several kinds (iron_golem: village AND outpost) is fine —
// the scorer ranks the kinds against each other, it does not require a unique match.
//
// blocks: block name → weight. A leading '*' matches by suffix ('*_planks' = any planks).
// entities: entity name → weight. Only LOS-visible entities count.
// minScore: below this total a cluster is not reported as this kind at all.
// dimensions: where the kind can exist at all ('overworld', 'the_nether', 'the_end').
//   A hard gate — elsewhere the kind is dropped and its cues are not even searched for.
// biomes (optional): where it generates. A soft prior, not a gate: a mismatch only
//   discounts the score, because the biome is sampled at the cluster's center and
//   structures straddle biome borders (a plains village spills into the next forest).
// variants (optional): styles of one kind built from different materials, each with its
//   own blocks and optional biomes/dimensions (a variant outside the current dimension
//   is dropped like a kind is). The kind's own blocks/entities are the shared core, scored
//   once; each variant adds its materials and the best one wins, so the styles never
//   split the kind's vote against its rivals. A variant kind needs at least one core
//   cue: materials only pick the style, they cannot make the place on their own (an
//   iceberg's packed + blue ice is not a snowy village).
//
// Never use a block that also generates naturally IN THAT DIMENSION (logs, stone, grass;
// netherrack is fine as an overworld variant cue, meaningless in the nether): a forest would
// then read as a weak witch hut, and every one of its thousands of logs costs an LOS test.
// Colored terracotta counts as natural — badlands are made of it; glazed terracotta is not.

const FINGERPRINTS = [
  {
    // Materials come from minecraft.wiki's per-style block lists. The shared cues say
    // "village"; the variant materials only say which style — see `variants` above.
    kind: 'village',
    dimensions: ['overworld'],
    blocks: {
      bell: 6, '*_bed': 2, hay_block: 2, composter: 2, farmland: 1.5,
      lectern: 2, smoker: 2, blast_furnace: 2, barrel: 1, fletching_table: 2,
      cartography_table: 2, brewing_stand: 1.5, grindstone: 2, loom: 2, stonecutter: 1.5,
      smithing_table: 2, glass_pane: 1, cobblestone: 0.5,
    },
    entities: { villager: 6, iron_golem: 2 },
    variants: {
      plains: {
        biomes: ['plains', 'meadow'],
        blocks: {
          dirt_path: 2, oak_planks: 1.5, stripped_oak_log: 1.5, oak_stairs: 1, oak_fence: 1,
          oak_door: 1, white_wool: 1, yellow_wool: 1,
        },
      },
      desert: {
        biomes: ['desert'],
        blocks: {
          smooth_sandstone: 2, cut_sandstone: 2, smooth_sandstone_stairs: 1, jungle_fence: 1.5,
          jungle_door: 1.5, lime_glazed_terracotta: 2, light_blue_glazed_terracotta: 2,
          white_glazed_terracotta: 2,
        },
      },
      savanna: {
        biomes: ['savanna'],
        blocks: {
          dirt_path: 2, acacia_planks: 1.5, stripped_acacia_log: 1.5, acacia_stairs: 1,
          acacia_fence: 1, acacia_door: 1, orange_glazed_terracotta: 2, yellow_glazed_terracotta: 2,
        },
      },
      taiga: {
        biomes: ['taiga'],
        blocks: {
          dirt_path: 2, spruce_planks: 1.5, spruce_stairs: 1, spruce_fence: 1, spruce_door: 1,
          spruce_trapdoor: 1, campfire: 1.5, mossy_cobblestone: 1,
        },
      },
      snowy: {
        biomes: ['snowy_plains'],
        blocks: {
          dirt_path: 2, spruce_planks: 1, stripped_spruce_log: 1.5, spruce_fence: 1, spruce_door: 1,
          snow_block: 1, packed_ice: 1, blue_ice: 1.5, diorite_wall: 1.5, lantern: 1,
        },
      },
    },
    minScore: 4,
  },
  {
    kind: 'pillager_outpost',
    dimensions: ['overworld'],
    biomes: ['plains', 'desert', 'savanna', 'taiga', 'snowy_plains', 'meadow', 'frozen_peaks', 'jagged_peaks', 'stony_peaks', 'snowy_slopes', 'cherry_grove', 'grove'],
    blocks: {
      dark_oak_log: 2, dark_oak_planks: 2, dark_oak_fence: 2, birch_planks: 1,
      cobblestone: 1, white_wall_banner: 3, target: 2, '*_fence': 0.5,
    },
    // allays are caged only at outposts; pillagers also roam the world in patrols
    entities: { allay: 7, pillager: 3, iron_golem: 2 },
    minScore: 4,
  },
  {
    kind: 'nether_fortress',
    dimensions: ['the_nether'],
    blocks: {
      nether_bricks: 3, nether_brick_fence: 3, nether_brick_stairs: 2, nether_wart: 3,
      spawner: 2,
    },
    entities: { blaze: 5, wither_skeleton: 5 },
    minScore: 4,
  },
  {
    kind: 'bastion',
    dimensions: ['the_nether'],
    biomes: ['nether_wastes', 'soul_sand_valley', 'crimson_forest', 'warped_forest'],
    blocks: {
      gilded_blackstone: 5, polished_blackstone_bricks: 2, cracked_polished_blackstone_bricks: 2,
      gold_block: 2, chiseled_polished_blackstone: 2,
    },
    entities: { piglin_brute: 6, piglin: 1.5, hoglin: 1 },
    minScore: 4,
  },
  {
    kind: 'mineshaft',
    dimensions: ['overworld'],
    blocks: { rail: 3, cobweb: 2, oak_fence: 1, oak_planks: 1, dark_oak_fence: 0.5 },
    entities: { cave_spider: 4, chest_minecart: 3 },
    minScore: 4,
  },
  {
    kind: 'dungeon',
    dimensions: ['overworld'],
    blocks: { spawner: 4, mossy_cobblestone: 2, cobblestone: 0.5 },
    entities: {},
    minScore: 4,
  },
  {
    kind: 'desert_pyramid',
    dimensions: ['overworld'],
    biomes: ['desert'],
    blocks: {
      chiseled_sandstone: 3, blue_terracotta: 3, cut_sandstone: 1,
      sandstone_stairs: 1, tnt: 2,
    },
    entities: {},
    minScore: 4,
  },
  {
    kind: 'ocean_monument',
    dimensions: ['overworld'],
    biomes: ['deep_ocean', 'deep_cold_ocean', 'deep_lukewarm_ocean', 'deep_frozen_ocean'],
    blocks: { prismarine_bricks: 3, dark_prismarine: 3, sea_lantern: 3, prismarine: 1.5 },
    entities: { guardian: 4, elder_guardian: 6 },
    minScore: 4,
  },
  {
    kind: 'ruined_portal',
    dimensions: ['overworld', 'the_nether'],
    blocks: { crying_obsidian: 4, obsidian: 2, gold_block: 2 },
    // netherrack and magma are nearly proof in the overworld and the ground in the nether
    variants: {
      overworld: { dimensions: ['overworld'], blocks: { netherrack: 3, magma_block: 1 } },
      nether: { dimensions: ['the_nether'], blocks: {} },
    },
    entities: {},
    minScore: 4,
  },
  {
    kind: 'stronghold',
    dimensions: ['overworld'],
    blocks: {
      end_portal_frame: 6, mossy_stone_bricks: 1.5, cracked_stone_bricks: 1.5, stone_bricks: 1,
      iron_bars: 1, iron_door: 2,
    },
    entities: { silverfish: 3 },
    minScore: 4,
  },
  {
    kind: 'ancient_city',
    dimensions: ['overworld'],
    biomes: ['deep_dark'],
    blocks: {
      reinforced_deepslate: 6, sculk_shrieker: 4, sculk_sensor: 2, soul_lantern: 2,
      deepslate_tiles: 1, deepslate_bricks: 1,
    },
    entities: { warden: 6 },
    minScore: 4,
  },
  {
    kind: 'witch_hut',
    dimensions: ['overworld'],
    biomes: ['swamp'],
    blocks: { cauldron: 2, potted_red_mushroom: 3, spruce_planks: 1, spruce_stairs: 1 },
    entities: { witch: 5 },
    minScore: 4,
  },
]

module.exports = { FINGERPRINTS }
