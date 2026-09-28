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
