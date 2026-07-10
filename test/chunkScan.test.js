// Unit tests for the palette-skip chunk scanner. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.11')

const state = require('../state')
const { resolveTargets, findByTypeMap, findByType, scanCandidates, getOpaqueSet } = require('../chunkScan')

const NETHER_BRICK = mcData.blocksByName['nether_bricks'].minStateId // 9133
const STONE = mcData.blocksByName['stone'].minStateId
const MIN_Y = -64
const NUM_SECTIONS = 24

// local block index within a 16³ section: (y<<8)|(z<<4)|x
const idx = (x, y, z) => (y << 8) | (z << 4) | x

// section mocks — a real section exposes its container as section.data
function indirect(palette, localMap = {}) {
  return { data: { palette, get: (i) => (i in localMap ? localMap[i] : 0) } }
}
function singleValue(value) {
  return { data: { value, get: () => value } }
}
// a section that must NEVER be scanned — throws if its container.get() is called
function trap(palette, value) {
  const c = { get: () => { throw new Error('section was scanned despite skip') } }
  if (palette) c.palette = palette
  if (value !== undefined) c.value = value
  return { data: c }
}

function column(sections) {
  return { minY: MIN_Y, sections }
}
function makeWorld(columns) {
  return { getColumns: () => columns }
}
function setBot(columns, pos = new Vec3(8, 70, 8)) {
  state.bot = { version: '1.21.11', entity: { position: pos }, world: makeWorld(columns) }
}

// place a block at world (wx,wy,wz) in a section array, returns {section index, sections}
function worldToSection(wy) {
  const rel = wy - MIN_Y
  return { s: rel >> 4, ly: rel & 15 }
}

// --- resolveTargets --------------------------------------------------------
test('resolveTargets: exact name → all its state ids', () => {
  setBot([])
  const m = resolveTargets('nether_bricks')
  assert.equal(m.get(NETHER_BRICK), 'nether_bricks')
  const stairs = mcData.blocksByName['oak_stairs']
  const m2 = resolveTargets('oak_stairs')
  assert.equal(m2.size, stairs.maxStateId - stairs.minStateId + 1)
  assert.equal(m2.get(stairs.minStateId), 'oak_stairs')
  assert.equal(m2.get(stairs.maxStateId), 'oak_stairs')
})

test('resolveTargets: substring matches multiple blocks', () => {
  setBot([])
  const m = resolveTargets('nether_brick') // matches nether_bricks, _stairs, _slab, _wall, _fence...
  const names = new Set([...m.values()])
  assert.ok(names.has('nether_bricks'))
  assert.ok(names.size > 1, 'substring should match several block types')
})

// --- findByTypeMap ---------------------------------------------------------
test('finds a target block at correct world coords', () => {
  const sections = new Array(NUM_SECTIONS).fill(null)
  // nether_brick at world (10,72,12), chunk (0,0)
  const { s, ly } = worldToSection(72)
  sections[s] = indirect([0, NETHER_BRICK], { [idx(10, ly, 12)]: NETHER_BRICK })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }])
  const hits = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96, count: 64 })
  assert.equal(hits.length, 1)
  assert.deepEqual({ x: hits[0].x, y: hits[0].y, z: hits[0].z, name: hits[0].name },
    { x: 10, y: 72, z: 12, name: 'nether_bricks' })
})

test('palette-skip: indirect section without target is never scanned', () => {
  const sections = new Array(NUM_SECTIONS).fill(null)
  const { s } = worldToSection(72)
  sections[s] = trap([0, STONE]) // palette lacks nether_brick → must skip, get() would throw
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }])
  const hits = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96 })
  assert.equal(hits.length, 0)
})

test('single-value section (all stone) is skipped when not the target', () => {
  const sections = new Array(NUM_SECTIONS).fill(null)
  const { s } = worldToSection(72)
  sections[s] = trap(undefined, STONE) // SingleValueContainer of stone → skip, get() throws
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }])
  const hits = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96 })
  assert.equal(hits.length, 0)
})

test('single-value section IS scanned when it matches the target', () => {
  const sections = new Array(NUM_SECTIONS).fill(null)
  const { s } = worldToSection(72)
  sections[s] = singleValue(NETHER_BRICK) // whole section is nether_brick
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }])
  const hits = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96, count: 5000 })
  assert.ok(hits.length > 0, 'should find blocks in a matching single-value section')
  for (const h of hits) assert.equal(h.name, 'nether_bricks')
})

test('maxDistance filters out-of-range hits', () => {
  const near = new Array(NUM_SECTIONS).fill(null)
  const far = new Array(NUM_SECTIONS).fill(null)
  const { s, ly } = worldToSection(70)
  near[s] = indirect([0, NETHER_BRICK], { [idx(8, ly, 8)]: NETHER_BRICK })   // ~at eye, dist ~0
  far[s] = indirect([0, NETHER_BRICK], { [idx(6, ly, 8)]: NETHER_BRICK })    // chunk (7,0) → x≈118
  setBot([
    { chunkX: '0', chunkZ: '0', column: column(near) },
    { chunkX: '7', chunkZ: '0', column: column(far) },
  ])
  const hits = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96, count: 64 })
  assert.equal(hits.length, 1, 'only the near block within 96 should be returned')
  assert.ok(hits[0].x < 20)
})

test('results are nearest-first and capped at count', () => {
  const sections = new Array(NUM_SECTIONS).fill(null)
  const { s, ly } = worldToSection(70)
  // three nether_bricks at increasing x distance from eye(8,70,8)
  sections[s] = indirect([0, NETHER_BRICK], {
    [idx(9, ly, 8)]: NETHER_BRICK,
    [idx(12, ly, 8)]: NETHER_BRICK,
    [idx(15, ly, 8)]: NETHER_BRICK,
  })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }])
  const all = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96, count: 64 })
  assert.deepEqual(all.map(h => h.x), [9, 12, 15])
  const capped = findByTypeMap(resolveTargets('nether_bricks'), { maxDistance: 96, count: 2 })
  assert.equal(capped.length, 2)
  assert.deepEqual(capped.map(h => h.x), [9, 12])
})

test('findByType wrapper resolves + scans', () => {
  const sections = new Array(NUM_SECTIONS).fill(null)
  const { s, ly } = worldToSection(72)
  sections[s] = indirect([0, NETHER_BRICK], { [idx(10, ly, 12)]: NETHER_BRICK })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }])
  const hits = findByType('nether_bricks', { maxDistance: 96 })
  assert.equal(hits.length, 1)
})

// --- getOpaqueSet ----------------------------------------------------------
test('getOpaqueSet: solid cubes opaque, see-through blocks not', () => {
  const set = getOpaqueSet(mcData)
  assert.ok(set.has(mcData.blocksByName['stone'].minStateId), 'stone is opaque')
  assert.ok(set.has(mcData.blocksByName['nether_bricks'].minStateId), 'nether_bricks opaque')
  assert.ok(!set.has(mcData.blocksByName['glass'].minStateId), 'glass not opaque (transparent)')
  assert.ok(!set.has(mcData.blocksByName['water'].minStateId), 'water not opaque (boundingBox empty)')
  for (let id = mcData.blocksByName['oak_leaves'].minStateId; id <= mcData.blocksByName['oak_leaves'].maxStateId; id++) {
    assert.ok(!set.has(id), 'leaves not opaque (transparent)')
  }
})

// --- scanCandidates: exposure cull -----------------------------------------
test('exposure: block whose only eye-facing neighbor is opaque is excluded', () => {
  // eye at (8.5,70.5,13.5) → block (8,70,8) faces it on +z, neighbor cell (8,70,9)
  const eye = new Vec3(8.5, 70.5, 13.5)
  const { s, ly } = worldToSection(70)
  const idMap = require('../chunkScan').resolveTargets('nether_bricks')

  // exposed: neighbor (8,70,9) is air → returned
  let sections = new Array(NUM_SECTIONS).fill(null)
  sections[s] = indirect([0, NETHER_BRICK, STONE], { [idx(8, ly, 8)]: NETHER_BRICK })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }], eye)
  let hits = scanCandidates({ origin: eye, cosHalf: -1, maxDistance: 64, idToName: idMap })
  assert.equal(hits.length, 1, 'exposed block returned')
  assert.deepEqual({ x: hits[0].x, y: hits[0].y, z: hits[0].z }, { x: 8, y: 70, z: 8 })

  // buried on the eye-facing side: neighbor (8,70,9) is stone → dropped
  sections = new Array(NUM_SECTIONS).fill(null)
  sections[s] = indirect([0, NETHER_BRICK, STONE], { [idx(8, ly, 8)]: NETHER_BRICK, [idx(8, ly, 9)]: STONE })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }], eye)
  hits = scanCandidates({ origin: eye, cosHalf: -1, maxDistance: 64, idToName: idMap })
  assert.equal(hits.length, 0, 'buried block dropped before LOS')
})

// --- scanCandidates: cone cull ---------------------------------------------
test('cone: block behind the eye excluded under FOV, included when omni', () => {
  const eye = new Vec3(8.5, 70.5, 8.5)
  const look = { x: 0, y: 0, z: -1 } // facing north (-z)
  const { s, ly } = worldToSection(70)
  const idMap = require('../chunkScan').resolveTargets('nether_bricks')
  const sections = new Array(NUM_SECTIONS).fill(null)
  sections[s] = indirect([0, NETHER_BRICK], {
    [idx(8, ly, 2)]: NETHER_BRICK,   // in front (north), air neighbors → exposed
    [idx(8, ly, 15)]: NETHER_BRICK,  // behind (south)
  })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }], eye)

  const fov = scanCandidates({ origin: eye, look, cosHalf: Math.cos(Math.PI / 3), maxDistance: 64, idToName: idMap })
  assert.deepEqual(fov.map(h => h.z), [2], 'only the block in front survives the 120° cone')

  const omni = scanCandidates({ origin: eye, look, cosHalf: -1, maxDistance: 64, idToName: idMap })
  assert.deepEqual(omni.map(h => h.z).sort((a, b) => a - b), [2, 15], 'omni keeps both')
})

// --- scanCandidates: groupNearest aggregation ------------------------------
test('groupNearest: per-type total + nearest-K; rare type not crowded out by dense', () => {
  const eye = new Vec3(8.5, 70.5, 15.5)
  const { s, ly } = worldToSection(70)
  const map = {}
  // a wall of stone (dense) filling a row, all exposed toward the eye (+z neighbor air)
  for (let x = 0; x < 16; x++) map[idx(x, ly, 2)] = STONE
  // one rare nether_bricks far-ish, also exposed
  map[idx(8, ly, 0)] = NETHER_BRICK
  const sections = new Array(NUM_SECTIONS).fill(null)
  sections[s] = indirect([0, STONE, NETHER_BRICK], map)
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }], eye)

  const groups = scanCandidates({ origin: eye, look: { x: 0, y: 0, z: -1 }, cosHalf: -1, maxDistance: 64, groupNearest: 4 })
  assert.ok(groups instanceof Map)
  assert.equal(groups.get('stone').total, 16, 'counts all 16 stone')
  assert.ok(groups.get('stone').nearest.length <= 4, 'keeps at most K=4 nearest')
  // nearest list is ascending by distance
  const d = groups.get('stone').nearest.map(n => n.dist)
  assert.deepEqual(d, [...d].sort((a, b) => a - b))
  assert.ok(groups.get('nether_bricks'), 'rare type survives despite 16 stone')
  assert.equal(groups.get('nether_bricks').total, 1)
})

// --- scanCandidates: survey path (no type filter) + self-chunk safety ------
test('survey path returns exposed non-air by name; self chunk never sphere-culled', () => {
  const eye = new Vec3(8.5, 70.5, 13.5)
  const { s, ly } = worldToSection(70)
  const sections = new Array(NUM_SECTIONS).fill(null)
  // lone stone in air at (8,70,8): exposed, should come back named 'stone' even though
  // the eye sits inside this very section's bounding sphere (must not be culled).
  sections[s] = indirect([0, STONE], { [idx(8, ly, 8)]: STONE })
  setBot([{ chunkX: '0', chunkZ: '0', column: column(sections) }], eye)
  const hits = scanCandidates({ origin: eye, look: { x: 0, y: 0, z: -1 }, cosHalf: Math.cos(Math.PI / 3), maxDistance: 64 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'stone')
})
