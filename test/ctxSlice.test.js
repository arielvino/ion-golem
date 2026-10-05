// Unit tests for the CTX slice provider, focused on thick= slab projection. Run: node --test
//
// These run against a synthetic on-disk block DB rather than a live world, because the
// behaviour under test is a ranking rule over cells whose ground truth has to be known
// exactly. The live DB of a fresh surface world contains no ore and no hazards at all,
// so the $ / ! / notable / tie-break paths are precisely the ones it cannot exercise.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')

const state = require('../src/core/state')

// Scene, centred on a bot at (0,65,0) with axis=ew — so the cross-axis is z and a
// z-offset is depth into the slab. Stone fills z=-4..4 so every cell has some record.
//   coal_ore    (3,63,2)   z+2: invisible to thick=1, found by thick>=5
//   lava        (-2,62,-1) z-1: found by thick>=3
//   diamond_ore (5,61,0) + lava (5,61,2): one column-depth, two planes. Hazard must win
//               the glyph, and the ore must still survive in the notable list.
//   iron_ore    (-5,64,1) + (-5,64,2): one column-depth, both ore. Nearer plane wins.
// Every fixture sits inside the thick=5 slab (z=-2..2); anything outside it is correctly
// invisible, which is the constraint that caught the first draft of this file.
const FIXTURES = [
  [3, 63, 2, 'coal_ore'],
  [-2, 62, -1, 'lava'],
  [5, 61, 0, 'diamond_ore'],
  [5, 61, 2, 'lava'],
  [-5, 64, 1, 'iron_ore'],
  [-5, 64, 2, 'iron_ore'],
]

let dir, PROVIDERS

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxslice-'))
  state.BOT_DATA_DIR = dir

  const Database = require('better-sqlite3')
  const db = new Database(path.join(dir, 'blocks.db'))
  db.exec(`CREATE TABLE blocks (x INTEGER, y INTEGER, z INTEGER, name TEXT NOT NULL,
           seen_at INTEGER NOT NULL, PRIMARY KEY (x,y,z));`)
  const ins = db.prepare('INSERT OR REPLACE INTO blocks VALUES (?,?,?,?,0)')
  db.transaction(() => {
    for (let x = -8; x <= 8; x++)
      for (let y = 60; y <= 70; y++)
        for (let z = -4; z <= 4; z++)
          ins.run(x, y, z, y > 65 ? 'air' : 'stone')
    for (const f of FIXTURES) ins.run(...f)
  })()
  db.close()

  require('../src/world/memory').initDB()
  state.bot = { entity: { position: new Vec3(0, 65, 0) }, inventory: { items: () => [] } }
  PROVIDERS = require('../src/ai/ctxProviders').PROVIDERS
})

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} })

const render = (thick) => PROVIDERS.slice.render(['ew', '8', String(thick)])
const gridRows = (s) => s.split('\n').filter((l) => /^\s*-?\d+ /.test(l))
// Grid columns run x=-8..8 after the y label, so x maps to index x+8.
const glyphAt = (s, y, x) => {
  const row = gridRows(s).find((l) => l.trim().startsWith(`${y} `))
  return row.replace(/^\s*-?\d+ /, '')[x + 8]
}

test('the GRID never leaves the bot plane, whatever the thickness', () => {
  // This is the property the whole design rests on: a drawn cell is a real block at that
  // exact coordinate, so "." can be trusted for walkability and "#" for a solid face.
  // The earlier projecting version failed this, which is why it needed a disclaimer.
  const grid = (s) => gridRows(s).join('\n')
  for (const t of [3, 5, 9]) {
    assert.strictEqual(grid(render(t)), grid(render(1)),
      `thick=${t} altered the grid; it must only widen the search`)
  }
  // The off-plane coal must NOT be drawn, at any thickness.
  assert.strictEqual(glyphAt(render(9), 63, 3), '#',
    'coal at z=2 is off-plane and must stay out of the grid')
})

test('thickness widens the SEARCH, and finds what the plane cannot', () => {
  const thin = render(1)
  assert.ok(!thin.includes('coal_ore'), 'coal is off-plane, so a thin search must miss it')
  assert.ok(!thin.includes('lava'), 'that lava is off-plane too')

  assert.ok(render(5).includes('coal_ore'), 'thick=5 must search out to z+2')
  assert.ok(render(3).includes('lava'), 'thick=3 must search out to z-1')
})

test('off-plane finds are reported at true coords AND flagged as not in the grid', () => {
  // The grid cannot show these, so the annex is the only route from "coal exists" to a
  // goto. Saying which side of the cut it sits on is what makes it actionable.
  const t5 = render(5)
  assert.match(t5, /coal_ore x1 nearest@3,63,2 \(\d+m, 2 south of it\)/)
  // Both lavas are inside the z=-2..2 band, so the count is 2 and the nearer is cited.
  assert.match(t5, /lava x2 nearest@-2,62,-1 \(\d+m, 1 north of it\)/)
  assert.match(t5, /NOT drawn in the grid above/)
})

test('on-plane finds are distinguished from off-plane ones', () => {
  assert.match(render(5), /diamond_ore x1 nearest@5,61,0 \(\d+m, ON this plane\)/)
})

test('the nearest instance is the one reported', () => {
  // iron_ore sits at z=1 and z=2; both are off-plane, the nearer must be cited.
  assert.match(render(5), /iron_ore x2 nearest@-5,64,1/)
})

test('output size is driven by radius, not by thickness', () => {
  // Thickness costs N times the DB query but only a few characters of annex, so a wide
  // search never erodes the context budget the CTX channel exists to protect.
  const cost = [1, 3, 5, 9].map((t) => render(t).length)
  assert.ok(Math.max(...cost) - Math.min(...cost) < 400, `sizes drifted: ${cost.join(' -> ')}`)
  const rows = new Set(cost.map((_, i) => gridRows(render([1, 3, 5, 9][i])).length))
  assert.strictEqual(rows.size, 1, 'every thickness must render the same grid shape')
})

test('thick=1 searches the drawn plane only', () => {
  assert.deepStrictEqual(render(1), PROVIDERS.slice.render(['ew', '8']),
    'omitting the arg must equal passing 1')
  assert.match(render(1), /notable on this plane:/)
  assert.deepStrictEqual(render(0), render(1), 'thick=0 collapses to the single plane')
})

test('search width rounds up and clamps, never down', () => {
  // Rounding up means a request never silently searches narrower than asked for.
  assert.match(render(4), /within 2 block\(s\)/)
  assert.match(render(2), /within 1 block\(s\)/)
  assert.match(render(99), /within 8 block\(s\)/)
})

test('the header states the full extent, including the derived y-range', () => {
  // Grid height is derived from the radius, which is not guessable from the tag.
  const h = render(1).split('\n')[0]
  assert.match(h, /x -8\.\.8/)
  assert.match(h, /y 70\.\.49 \(top row is y=70\)/)
  assert.match(render(1), /every cell is a REAL block on the single plane z=0/)
})

test('the ruler aligns with the columns it labels', () => {
  const out = render(1).split('\n')
  const tick = out.find((l) => /^\s+'/.test(l))
  const labels = out[out.indexOf(tick) - 1]
  const row = gridRows(render(1)).find((l) => l.trim().startsWith('64 '))
  for (let i = 0; i < tick.length; i++) {
    if (tick[i] !== "'") continue
    // A tick at column i must sit above the grid cell for that same x.
    const x = i - 5 - 8  // strip the 5-char y label, then centre on the bot at x=0
    // Loose === on purpose: -5 % 5 is -0 in JS, and strictEqual(-0, 0) fails.
    assert.ok(x % 5 === 0, `tick at col ${i} maps to x=${x}, not a multiple of 5`)
    assert.ok(row[i] !== undefined, `tick at col ${i} overhangs the grid`)
    assert.ok(labels.slice(i).startsWith(String(x)),
      `label at col ${i} should read ${x}, got "${labels.slice(i, i + 4)}"`)
  }
})

test('the ns axis searches across x and names sides east/west', () => {
  const ns = PROVIDERS.slice.render(['ns', '8', '5'])
  assert.match(ns, /single plane x=0/)
  assert.match(ns, /z -8\.\.8/)
  assert.match(ns, /north\(-\) <-> south\(\+\)/)
  // Rotating the cut rotates which fixtures are in range: the x=-2..2 band reaches the
  // lava at x=-2 but not the coal at x=3, the ores at x=5, or the iron at x=-5.
  assert.match(ns, /lava x1 nearest@-2,62,-1 \(\d+m, 2 west of it\)/)
  assert.ok(!ns.includes('coal_ore'), 'coal at x=3 is outside the x=-2..2 search band')
  assert.ok(!ns.includes('iron_ore'), 'iron at x=-5 is outside it too')
})
