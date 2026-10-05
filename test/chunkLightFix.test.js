// Network light data must land on the cell it belongs to. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

function column(fixed) {
  for (const k of Object.keys(require.cache)) if (k.includes('prismarine-chunk') || k.includes('chunkLightFix')) delete require.cache[k]
  if (fixed) require('../src/lib/chunkLightFix')
  const Chunk = require('prismarine-chunk')('26.1')
  return new Chunk({ minY: -64, worldHeight: 384 })
}

// One light section (index 5 = block section 4 = y 0..15): light 14 at local x=4, y=0, z=0.
function load(col) {
  const bytes = new Array(2048).fill(0)
  bytes[2] = 14                                   // cell index 4 → byte 2, low nibble
  const mask = [[0, 1 << 5]]                      // i64 as [hi, lo]
  col.loadParsedLight([], [bytes], [[0, 0]], mask, [[0, 0]], [[0, 0]])
}

test('block light lands on the right cell', () => {
  const col = column(true); load(col)
  assert.strictEqual(col.getBlockLight(new Vec3(4, 0, 0)), 14)
  assert.strictEqual(col.getBlockLight(new Vec3(10, 0, 0)), 0)
})

test('unpatched prismarine-chunk mirrors it (x ^ 14) — the bug this fixes', () => {
  const col = column(false); load(col)
  assert.strictEqual(col.getBlockLight(new Vec3(10, 0, 0)), 14)
})
