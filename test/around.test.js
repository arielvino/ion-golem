// The around view (src/ai/ctxProviders.js, sent in every context) against a throwaway DB: the bot on top of
// a dirt pillar 110..117 over a stone floor at y100, open air all around.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const state = require('../src/core/state')
const memory = require('../src/world/memory')
const { around } = require('../src/ai/ctxProviders')

state.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'around-'))
memory.initDB()
const put = (x, y, z, name) => state.stmts.upsertBlock.run(x, y, z, name, 0, null)
for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
  put(x, 100, z, 'stone')
  for (let y = 101; y <= 121; y++) put(x, y, z, x === 0 && z === 0 && y >= 110 && y <= 117 ? 'dirt' : 'air')
}
state.bot = { entity: { position: new Vec3(0.5, 118, 0.5) } }

test('on a pillar every side reads as a drop and the view says so', () => {
  const out = around()
  assert.match(out, /^around 0,118,0/)
  assert.match(out, /north: drop 17 → onto stone, stand at y101 \(~14 dmg\)/)
  assert.match(out, /every side drops more than 3 blocks — you are on a pillar or a peak/)
  assert.match(out, /under you: floor dirt; breaking it: drop 1 → onto dirt, stand at y117/)
  // feet layer: @ in the middle, open air around
  assert.match(out, /\n(?:.{11}){2}\.\.@\.\./)
})

test('a walled-in spot reads as walls, with no drop verdict', () => {
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { put(x, 118, z, 'stone'); put(x, 119, z, 'stone') }
  const out = around()
  assert.match(out, /north: wall \(stone\) \| south: wall \(stone\) \| east: wall \(stone\) \| west: wall \(stone\)/)
  assert.doesNotMatch(out, /drops more than 3/)
})
