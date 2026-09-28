// Unit tests for place recognition (fingerprint → cluster → guess). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const mcData = require('minecraft-data')('26.1')

const { FINGERPRINTS } = require('../src/config/fingerprints')
const { compile, cluster, guess } = require('../src/perception/recognize')

const c = compile(mcData)
const at = (name, x, y, z, entity = false) => ({ name, x, y, z, entity })

test('every block cue resolves to at least one real block', () => {
  for (const k of c.kinds) {
    for (const cue of k.blockCues) assert.ok(cue.names.size > 0, `${k.kind}: cue "${cue.key}" matches no block`)
  }
})

test('every entity cue is a real entity', () => {
  for (const fp of FINGERPRINTS) {
    for (const e of Object.keys(fp.entities)) assert.ok(mcData.entitiesByName[e], `${fp.kind}: entity "${e}" unknown`)
  }
})

test('every dimension and biome name is real', () => {
  const dims = new Set(['overworld', 'the_nether', 'the_end'])
  for (const fp of FINGERPRINTS) {
    for (const d of fp.dimensions || []) assert.ok(dims.has(d), `${fp.kind}: dimension "${d}" unknown`)
    for (const b of fp.biomes || []) assert.ok(mcData.biomesByName[b], `${fp.kind}: biome "${b}" unknown`)
  }
})

test('dimension gate: the nether has no villages and searches no village cues', () => {
  const nether = compile(mcData, 'the_nether')
  const kinds = nether.kinds.map(k => k.kind)
  assert.ok(kinds.includes('nether_fortress') && kinds.includes('ruined_portal'))
  assert.ok(!kinds.includes('village'))
  assert.ok(![...nether.idToName.values()].includes('bell'), 'bell must not be searched for in the nether')
  const over = compile(mcData, 'overworld')
  assert.ok(!over.kinds.some(k => k.kind === 'nether_fortress'))
})

test('biome is a prior, not a gate: off-biome village scores lower but survives', () => {
  const members = [at('bell', 0, 64, 0), at('oak_planks', 1, 64, 0), at('villager', 2, 64, 0, true)]
  const onBiome = guess(members, c, 'plains').hyps.find(h => h.kind === 'village')
  const offBiome = guess(members, c, 'forest').hyps.find(h => h.kind === 'village')
  assert.ok(offBiome, 'a strong village in a forest is still a village')
  assert.ok(offBiome.score < onBiome.score)
})

test('an allay says outpost far more strongly than a pillager (patrols roam)', () => {
  const base = [at('oak_planks', 0, 64, 0), at('oak_fence', 3, 64, 0), at('iron_golem', 5, 64, 0, true)]
  const outpost = (extra) => guess([...base, extra], c).hyps.find(h => h.kind === 'pillager_outpost')?.share || 0
  const withAllay = outpost(at('allay', 4, 64, 0, true))
  const withPillager = outpost(at('pillager', 4, 64, 0, true))
  assert.ok(withAllay > withPillager + 0.1, `allay ${withAllay.toFixed(2)} vs pillager ${withPillager.toFixed(2)}`)
})

test('cluster: cues within LINK join, far ones stay apart', () => {
  const groups = cluster([at('oak_planks', 0, 64, 0), at('oak_fence', 6, 64, 0), at('rail', 100, 30, 100)])
  assert.equal(groups.length, 2)
})

test('dark-oak planks + fence + iron golem is ambiguous: village vs outpost', () => {
  const members = [
    at('dark_oak_planks', 0, 64, 0), at('dark_oak_planks', 1, 64, 0),
    at('dark_oak_fence', 3, 64, 0), at('dark_oak_fence', 4, 64, 0), at('iron_golem', 5, 64, 0, true),
  ]
  const { hyps } = guess(members, c)
  const kinds = hyps.map(h => h.kind)
  assert.ok(kinds.includes('village'))
  assert.ok(kinds.includes('pillager_outpost'))
  assert.ok(hyps[0].missing.length > 0, 'top guess names the cues that would confirm it')
})

test('oak planks + fence + iron golem reads as village only (outposts are dark oak)', () => {
  const members = [at('oak_planks', 0, 64, 0), at('oak_fence', 3, 64, 0), at('iron_golem', 5, 64, 0, true)]
  assert.deepEqual(guess(members, c).hyps.map(h => h.kind), ['village'])
})

test('a bell makes the village clear-cut', () => {
  const members = [at('bell', 0, 64, 0), at('oak_planks', 1, 64, 0), at('iron_golem', 2, 64, 0, true)]
  const { hyps } = guess(members, c)
  assert.equal(hyps[0].kind, 'village')
  assert.ok(hyps[0].share > 0.6)
})

test('a single cue type is not a place', () => {
  const members = [at('oak_planks', 0, 64, 0), at('oak_planks', 1, 64, 0), at('oak_planks', 2, 64, 0)]
  assert.equal(guess(members, c).hyps.length, 0)
})

test('nether bricks + blaze → fortress', () => {
  const members = [at('nether_bricks', 0, 70, 0), at('nether_brick_fence', 1, 70, 0), at('blaze', 2, 71, 0, true)]
  assert.equal(guess(members, c).hyps[0].kind, 'nether_fortress')
})
