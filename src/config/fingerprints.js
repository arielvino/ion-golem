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
//
// Never use a block that also generates naturally (logs, stone, grass): a forest would
// then read as a weak witch hut, and every one of its thousands of logs costs an LOS test.

const FINGERPRINTS = [
  {
    kind: 'village',
    blocks: {
      bell: 6, '*_bed': 2, dirt_path: 2, hay_block: 2, composter: 2, farmland: 1.5,
      lectern: 2, smoker: 2, blast_furnace: 2, barrel: 1, fletching_table: 2,
      cartography_table: 2, brewing_stand: 1.5, grindstone: 2, loom: 2, stonecutter: 1.5,
      smithing_table: 2, '*_planks': 1, '*_fence': 1, glass_pane: 1, cobblestone: 0.5,
      '*_door': 1,
    },
    entities: { villager: 6, iron_golem: 2 },
    minScore: 4,
  },
  {
    kind: 'pillager_outpost',
    blocks: {
      dark_oak_log: 2, dark_oak_planks: 2, dark_oak_fence: 2, birch_planks: 1,
      cobblestone: 1, white_wall_banner: 3, target: 2, '*_fence': 0.5,
    },
    entities: { pillager: 6, iron_golem: 2, allay: 3 },
    minScore: 4,
  },
  {
    kind: 'nether_fortress',
    blocks: {
      nether_bricks: 3, nether_brick_fence: 3, nether_brick_stairs: 2, nether_wart: 3,
      spawner: 2,
    },
    entities: { blaze: 5, wither_skeleton: 5 },
    minScore: 4,
  },
  {
    kind: 'bastion',
    blocks: {
      gilded_blackstone: 5, polished_blackstone_bricks: 2, cracked_polished_blackstone_bricks: 2,
      gold_block: 2, chiseled_polished_blackstone: 2,
    },
    entities: { piglin_brute: 6, piglin: 1.5, hoglin: 1 },
    minScore: 4,
  },
  {
    kind: 'mineshaft',
    blocks: { rail: 3, cobweb: 2, oak_fence: 1, oak_planks: 1, dark_oak_fence: 0.5 },
    entities: { cave_spider: 4, chest_minecart: 3 },
    minScore: 4,
  },
  {
    kind: 'dungeon',
    blocks: { spawner: 4, mossy_cobblestone: 2, cobblestone: 0.5 },
    entities: {},
    minScore: 4,
  },
  {
    kind: 'desert_pyramid',
    blocks: {
      chiseled_sandstone: 3, orange_terracotta: 3, blue_terracotta: 3, cut_sandstone: 1,
      sandstone_stairs: 1, tnt: 2,
    },
    entities: {},
    minScore: 4,
  },
  {
    kind: 'ocean_monument',
    blocks: { prismarine_bricks: 3, dark_prismarine: 3, sea_lantern: 3, prismarine: 1.5 },
    entities: { guardian: 4, elder_guardian: 6 },
    minScore: 4,
  },
  {
    kind: 'ruined_portal',
    blocks: { crying_obsidian: 4, obsidian: 2, magma_block: 1, gold_block: 2 },
    entities: {},
    minScore: 4,
  },
  {
    kind: 'stronghold',
    blocks: {
      end_portal_frame: 6, mossy_stone_bricks: 1.5, cracked_stone_bricks: 1.5, stone_bricks: 1,
      iron_bars: 1, iron_door: 2,
    },
    entities: { silverfish: 3 },
    minScore: 4,
  },
  {
    kind: 'ancient_city',
    blocks: {
      reinforced_deepslate: 6, sculk_shrieker: 4, sculk_sensor: 2, soul_lantern: 2,
      deepslate_tiles: 1, deepslate_bricks: 1,
    },
    entities: { warden: 6 },
    minScore: 4,
  },
  {
    kind: 'witch_hut',
    blocks: { cauldron: 2, potted_red_mushroom: 3, spruce_planks: 1, spruce_stairs: 1 },
    entities: { witch: 5 },
    minScore: 4,
  },
]

module.exports = { FINGERPRINTS }
