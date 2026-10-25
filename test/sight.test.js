// Unit tests for light-aware sight (castRays on a hand-built cube). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { castRays, skyDarken } = require('../src/perception/sight')

const R = 6, side = 2 * R + 1
const AIR = 0, STONE = 1, GLOWSTONE = 2
const opaque = new Uint8Array(1 << 16); opaque[STONE] = 1; opaque[GLOWSTONE] = 1
const emits = new Uint8Array(1 << 16); emits[GLOWSTONE] = 1
const idx = (x, y, z) => ((y + R) * side + (z + R)) * side + (x + R)   // relative to the eye cell

// Eye in the middle of cell (0,0,0); a stone wall filling the plane x = +4.
function scene({ lightAll = 0, withLight = true } = {}) {
  const snap = new Uint16Array(side ** 3)
  const light = withLight ? new Uint8Array(side ** 3).fill(lightAll) : null
  for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) snap[idx(4, y, z)] = STONE
  return { snap, light, side, ox: R + 0.5, oy: R + 0.5, oz: R + 0.5 }
}
const sees = (cube, x, y, z) => castRays(cube, opaque, R, emits).seen[idx(x, y, z)] === 1

test('lit wall is seen', () => {
  assert.ok(sees(scene({ lightAll: 15 }), 4, 0, 0))
})

test('wall in the dark is not seen', () => {
  assert.ok(!sees(scene({ lightAll: 0 }), 4, 0, 0))
})

test('lit face seen through dark air between', () => {
  const c = scene()
  c.light[idx(3, 0, 0)] = 8                       // only the cell in front of the face
  assert.ok(sees(c, 4, 0, 0))
  assert.ok(c.light[idx(1, 0, 0)] === 0 && c.light[idx(2, 0, 0)] === 0)
})

test('wall lit only on its far side stays dark', () => {
  const c = scene()
  c.light[idx(5, 0, 0)] = 15
  assert.ok(!sees(c, 4, 0, 0))
})

test('light source shows in the dark', () => {
  const c = scene()
  c.snap[idx(4, 0, 0)] = GLOWSTONE
  assert.ok(sees(c, 4, 0, 0))
})

test('dark plant is hidden, lit plant is seen', () => {
  const GRASS = 3                                  // not opaque: lit by its own cell
  const c = scene()
  c.snap[idx(2, 0, 0)] = GRASS
  assert.ok(!sees(c, 2, 0, 0))
  c.light[idx(2, 0, 0)] = 5
  assert.ok(sees(c, 2, 0, 0))
})

test('no light data: everything a ray reaches is seen', () => {
  assert.ok(sees(scene({ withLight: false }), 4, 0, 0))
})

test('sky darkening follows the day', () => {
  assert.strictEqual(skyDarken(6000), 0)          // noon
  assert.strictEqual(skyDarken(18000), 11)        // midnight: sky 15 → 4 (moonlight)
  assert.strictEqual(skyDarken(6000, 1), 3)       // rain by day
  assert.ok(skyDarken(13000) > 0 && skyDarken(13000) < 11)   // dusk
})

test('dark around: share and sides of the near space that are unlit', () => {
  const c = scene({ lightAll: 15 })
  for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) for (let x = 1; x < 4; x++) c.light[idx(x, y, z)] = 0  // dark gap east, before the wall
  const d = castRays(c, opaque, R, emits).near
  assert.strictEqual(d.here, 15)
  assert.strictEqual(d.dirs.find(([k]) => k === 'E')[1], 1)   // east is dark through and through
  assert.strictEqual(d.dirs.find(([k]) => k === 'W')[1], 0)
  assert.ok(d.share > 0.2 && d.share < 0.6)
})

test('dark around: a dark gap with light beyond still counts dark; standing in the dark is all dark', () => {
  const c = scene({ lightAll: 15 })
  for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) c.light[idx(-2, y, z)] = 0   // one dark slab west
  assert.ok(castRays(c, opaque, R, emits).near.dirs.find(([k]) => k === 'W')[1] > 0.9)
  assert.strictEqual(castRays(scene({ lightAll: 0 }), opaque, R, emits).near.share, 1)
  assert.strictEqual(castRays(scene({ withLight: false }), opaque, R, emits).near, null)
})

test('DARK= line: plain words, left out when the surroundings are lit', () => {
  const { formatSight } = require('../src/perception/sightSummary')
  const s = { seen: 30, biomes: [], terrain: [], decoration: [], resources: [], unnatural: [] }
  assert.ok(!formatSight(s, null).includes('DARK'))
  assert.ok(!formatSight(s, { here: 15, share: 0.01, dirs: [['down', 0.1]] }).includes('DARK'))
  assert.strictEqual(formatSight(s, { here: 15, share: 0.3, dirs: [['E', 0.9], ['down', 0.4], ['N', 0.1]] }),
    'DARK=[you stand in light (15/15) | 30% of the space within 8 blocks of you is dark — dark: east; partly dark: below]')
  assert.strictEqual(formatSight(s, { here: 0, share: 1, dirs: [['E', 1], ['W', 1]] }),
    'DARK=[you stand in darkness (0/15) | 100% of the space within 8 blocks of you is dark]')
})

// seenBlocks marks a block "underwater" only when the water right above it was seen too:
// an ore seen from a cave below a lake must not reveal the lake.
test('seenBlocks: underwater only under seen water', () => {
  const { seenBlocks } = require('../src/perception/sight')
  const names = { 1: 'iron_ore', 2: 'water' }
  const bot = { registry: { blocksByStateId: { 1: { name: 'iron_ore' }, 2: { name: 'water' } }, biomes: {} }, world: { getBiome: () => 0 } }
  const s = 3, snap = new Uint16Array(s ** 3), seen = new Uint8Array(s ** 3)
  const at = (x, y, z) => (y * s + z) * s + x
  // Column x=0: ore at y=0 under seen water. Column x=2: ore at y=0 under unseen water.
  snap[at(0, 0, 0)] = 1; snap[at(0, 1, 0)] = 2; seen[at(0, 0, 0)] = 1; seen[at(0, 1, 0)] = 1
  snap[at(2, 0, 0)] = 1; snap[at(2, 1, 0)] = 2; seen[at(2, 0, 0)] = 1
  const ores = seenBlocks(bot, { snap, side: s, x0: 0, y0: 0, z0: 0 }, seen).filter(b => names[b.id] === 'iron_ore')
  assert.deepStrictEqual(ores.map(b => [b.x, !!b.underwater]), [[0, true], [2, false]])
})

test('a cell seen only through water is not clear; the first water cell is', () => {
  const WATER = 3, water = new Uint8Array(1 << 16); water[WATER] = 1
  const c = scene({ lightAll: 15 })
  for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) for (const x of [2, 3]) c.snap[idx(x, y, z)] = WATER
  const { seen, clear } = castRays(c, opaque, R, emits, water)
  assert.ok(seen[idx(4, 0, 0)] && !clear[idx(4, 0, 0)])   // the wall behind the water
  assert.ok(clear[idx(2, 0, 0)] && !clear[idx(3, 0, 0)])
})

test('level ground far out is seen whole, not striped: grazing rays fill in between', () => {
  // Flat stone floor, its top 1.62 below the eye (standing on it), R = 40.
  const R = 40, side = 2 * R + 1, snap = new Uint16Array(side ** 3)
  const at = (x, y, z) => ((y + R) * side + (z + R)) * side + (x + R)
  for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) snap[at(x, -2, z)] = STONE
  const cube = { snap, light: null, side, ox: R + 0.5, oy: R + 0.62, oz: R + 0.5 }
  const share = (fine) => {
    const { seen } = castRays(cube, opaque, R, null, null, fine)
    let n = 0, s = 0
    for (let x = 12; x <= 24; x++) for (let z = -3; z <= 3; z++) { n++; if (seen[at(x, -2, z)]) s++ }
    return s / n
  }
  assert.ok(share(1) < 0.9, `regular rays only: ${share(1)}`)   // the stripes the grazing rays fix
  assert.strictEqual(share(), 1)
})
