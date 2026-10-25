// Landforms from the seen ground (perception/landforms.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { landforms, groundMap, geomorphons, FORMS } = require('../src/perception/landforms')

const R = 40
// Ground blocks (top of each column) of height(x, z); null = unseen column.
function ground(height) {
  const out = []
  for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) {
    const y = height(x, z)
    if (y !== null) out.push({ name: 'grass_block', x, y: Math.round(y), z, biome: 'plains' })
  }
  return out
}
const eye = { x: 0.5, y: 70, z: 0.5 }
const formAt = (blocks, x, z) => {
  const g = groundMap(blocks), f = geomorphons(g)
  if (x < g.x0 || z < g.z0 || x >= g.x0 + g.w || z >= g.z0 + g.h) return 'unknown'
  return FORMS[f[(z - g.z0) * g.w + (x - g.x0)]]
}

test('flat ground is one flat, nothing else', () => {
  const lf = landforms(ground(() => 64), eye)
  assert.strictEqual(formAt(ground(() => 64), 0, 0), 'flat')
  assert.deepStrictEqual([lf.hills.length, lf.valleys.length, lf.cliffs.length], [0, 0, 0])
  assert.strictEqual(lf.flats.length, 1)
})

test('a cone hill: its top is a peak, its flank a slope or spur (contours bend round it), listed with its rise', () => {
  const cone = (x, z) => 64 + Math.max(0, 16 - Math.hypot(x - 20, z))
  const b = ground(cone)
  assert.strictEqual(formAt(b, 20, 0), 'peak')
  assert.ok(['slope', 'spur'].includes(formAt(b, 12, 0)), formAt(b, 12, 0))
  assert.strictEqual(formAt(b, -30, -30), 'flat')
  assert.strictEqual(formAt(b, 20, -40), 'unknown')   // the edge of the view: too few directions seen
  const lf = landforms(b, eye)
  assert.ok(lf.hills.length >= 1)
  const h = lf.hills[0]
  assert.deepStrictEqual([h.at.x, h.at.z], [20, 0])
  assert.ok(h.rise >= 14, `rise ${h.rise}`)
  assert.strictEqual(h.open, false)
})

test('a long V valley running north-south is a valley that runs N-S', () => {
  const b = ground((x, z) => 64 + Math.min(12, Math.abs(x - 10) * 0.8))
  assert.strictEqual(formAt(b, 10, 0), 'valley')
  const lf = landforms(b, eye)
  assert.strictEqual(lf.valleys.length, 1)
  assert.strictEqual(lf.valleys[0].runs, 'N-S')
  assert.ok(lf.valleys[0].depth >= 10)
})

test('a 10-high step facing east is a cliff, 10 high, facing E', () => {
  const lf = landforms(ground((x) => x < 15 ? 74 : 64), eye)
  assert.strictEqual(lf.cliffs.length, 1)
  const c = lf.cliffs[0]
  assert.deepStrictEqual([c.height, c.faces, c.at.x], [10, 'E', 14])
  assert.ok(c.length >= 2 * R)
})

test('a 2-block bank is no cliff', () => {
  assert.strictEqual(landforms(ground((x) => x < 15 ? 66 : 64), eye).cliffs.length, 0)
})

test('a cliff whose foot is hidden under its brow is still found; a slope bending away is not', () => {
  // 10-high step at x=15, the 2 columns below it unseen: 10 down over 3 columns, so one step is 3+.
  const lf = landforms(ground((x) => x === 15 || x === 16 ? null : x < 15 ? 74 : 64), eye)
  assert.strictEqual(lf.cliffs.length, 1)
  assert.strictEqual(lf.cliffs[0].faces, 'E')
  assert.ok(lf.cliffs[0].height >= 10, `height ${lf.cliffs[0].height}`)
  // 2 per column down, 2 columns unseen: 6 over 3 columns could be any 2-2-2.
  const slope = (x) => x < 15 ? 74 : 74 - 2 * (x - 14)
  assert.strictEqual(landforms(ground((x) => x === 15 || x === 16 ? null : Math.max(50, slope(x))), eye).cliffs.length, 0)
})

test('a hill whose far side is unseen is open; unseen columns get no form', () => {
  const b = ground((x, z) => x > 22 ? null : 64 + Math.max(0, 16 - Math.hypot(x - 20, z)))
  assert.strictEqual(formAt(b, -25, 0), 'flat')
  assert.strictEqual(formAt(b, 30, 0), 'unknown')
  const lf = landforms(b, eye)
  assert.ok(lf.hills.length >= 1)
  assert.strictEqual(lf.hills[0].open, true)
})

test('ground seen only through water or ice (sunk) is left out: no cliff at a frozen shore', () => {
  // ice at 62 over a sea; the bot saw the ice near it, and further out only water cells deep under it
  const b = ground((x) => x < 10 ? 62 : null)
  for (let x = 10; x <= R; x++) for (let z = -R; z <= R; z++) b.push({ name: 'water', x, y: 56, z, biome: 'frozen_ocean', sunk: true })
  const lf = landforms(b, eye)
  assert.strictEqual(lf.cliffs.length, 0)
  assert.strictEqual(formAt(b, 20, 0), 'unknown')
})

test('trees are not ground', () => {
  const b = ground(() => 64)
  for (let y = 65; y < 72; y++) b.push({ name: 'oak_log', x: 5, y, z: 5, biome: 'plains' })
  assert.strictEqual(landforms(b, eye).hills.length, 0)
})

test('LAND= names each feature with how far, which way and where', () => {
  const b = ground((x) => x < 15 ? 74 : 64)
  const line = require('../src/perception/landforms').formatLand(landforms(b, eye), eye)
  assert.match(line, /^LAND=\[cliff 10 high facing E, \d+ long: 14m E@14,74,0;/)
  assert.match(line, /flat ground y\d+, \d+ blocks/)
})

test('kelp and seagrass at the surface are water surface, like water', () => {
  const g = groundMap([{ name: 'water', x: 0, y: 63, z: 0 }, { name: 'kelp_plant', x: 1, y: 63, z: 0 }, { name: 'tall_seagrass', x: 2, y: 63, z: 0 }])
  assert.deepStrictEqual(Array.from(g.top), [63, 63, 63])
})
