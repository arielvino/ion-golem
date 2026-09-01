// ctxProviders.js — on-demand high-resolution context views.
//
// The per-turn context is a fixed low-resolution summary: enough to act on, cheap
// enough to ship every turn. A few views are far too large or too noisy for that
// budget yet are occasionally decisive — the shape of the terrain, every remembered
// sighting of one material, a vertical cross-section of what lies under the bot.
// This is the channel for those: the model writes [CTX:name:args] on one turn and
// the rendered view arrives in the NEXT turn's context, once.
//
// Adding a view is one entry in PROVIDERS — the tag parser, the validator and the
// context builder are all driven off this table and need no edits.
//
// Every provider reads the block DB, never bot.world. The DB is what the bot has
// actually observed, so a cell with no record renders as unknown rather than as
// terrain the bot was never in a position to see. That keeps these views on the
// same LOS-honest footing as the rest of perception, and the unknown markers are
// themselves useful — they are where the bot has not looked yet.
const state = require('../core/state')
const { Vec3 } = require('vec3')
const { queryRegion, queryBlockMemoryFuzzy, searchContainersFor } = require('../world/memory')
const { getLastSurvey } = require('../perception/visibility')
const { HAZARDS, RESOURCES, WATER_BLOCKS } = require('../config/blocks')

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const intArg = (v, def) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

// Ground cover that sits ON the surface — excluded so a heightmap reports the block
// you would stand on, not the flower growing out of it. Logs and leaves are NOT here:
// a forest canopy is real terrain shape and worth seeing.
const COVER = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'torchflower', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'sweet_berry_bush', 'sugar_cane', 'vine', 'seagrass',
  'tall_seagrass', 'kelp', 'kelp_plant', 'wheat', 'carrots', 'potatoes', 'beetroots',
])

const isPlant = (n) => /_log$|_leaves$|_wood$|mushroom_block|_stem$|cactus|bamboo/.test(n)

// The survey records air as well as solids — it is ~60% of the table — so these views
// must exclude it explicitly. Treating "has a row" as "is solid" renders every observed
// air cell as rock and every heightmap column as the top of the sky.
// Air that WAS observed is not the same as a cell with no row at all, and the slice
// distinguishes the two: known-empty is navigable, unknown is where to go look.
const AIR = new Set(['air', 'cave_air', 'void_air'])

// ── heightmap ────────────────────────────────────────────────────────────
// Topmost recorded solid per column, as a grid. Rows run north->south, columns
// west->east, matching how the coordinates read (+z is south, +x is east).
function heightmap(args) {
  const bot = state.bot
  const r = clamp(intArg(args[0], 8), 1, 16)
  const p = bot.entity.position.floored()
  const yLo = p.y - 32, yHi = p.y + 32

  const top = new Map()   // "x,z" -> { y, name }
  for (const b of queryRegion(p.x - r, yLo, p.z - r, p.x + r, yHi, p.z + r)) {
    if (AIR.has(b.name) || COVER.has(b.name)) continue
    const k = `${b.x},${b.z}`
    const cur = top.get(k)
    if (!cur || b.y > cur.y) top.set(k, { y: b.y, name: b.name })
  }

  const rows = []
  for (let dz = -r; dz <= r; dz++) {
    const cells = []
    for (let dx = -r; dx <= r; dx++) {
      const hit = top.get(`${p.x + dx},${p.z + dz}`)
      if (!hit) { cells.push('    ?'); continue }
      let mark = ''
      if (WATER_BLOCKS.has(hit.name)) mark = '~'
      else if (HAZARDS.has(hit.name)) mark = '!'
      else if (isPlant(hit.name)) mark = 't'
      cells.push(`${hit.y}${mark}`.padStart(5))
    }
    rows.push(cells.join(''))
  }

  const known = top.size, total = (2 * r + 1) ** 2
  return [
    `heightmap r=${r} you@${p.x},${p.y},${p.z} (center cell is you; rows N->S, cols W->E)`,
    `legend: number=y of highest KNOWN solid, t=tree/plant, ~=water, !=hazard, ?=never observed`,
    `coverage: ${known}/${total} columns observed`,
    ...rows,
  ].join('\n')
}

// ── slice ────────────────────────────────────────────────────────────────
// Vertical cross-section through the bot along one axis. This is the view the bot
// lacks when it stands on top of an ore vein it can see in the DB but cannot reach:
// see= reports the block exists, nothing reports that it is six blocks down.
function slice(args) {
  const bot = state.bot
  const raw = String(args[0] || 'ew').toLowerCase()
  const axis = /^[ns]/.test(raw) ? 'ns' : 'ew'
  const r = clamp(intArg(args[1], 8), 1, 16)
  const p = bot.entity.position.floored()
  const yTop = p.y + 5, yBot = p.y - clamp(r * 2, 6, 32)

  const box = axis === 'ew'
    ? queryRegion(p.x - r, yBot, p.z, p.x + r, yTop, p.z)
    : queryRegion(p.x, yBot, p.z - r, p.x, yTop, p.z + r)

  const cell = new Map()  // "axisCoord,y" -> name
  for (const b of box) cell.set(`${axis === 'ew' ? b.x : b.z},${b.y}`, b.name)

  const glyph = (n) => {
    if (!n) return '?'          // no row at all — never observed
    if (AIR.has(n)) return '.'  // observed and empty — walkable
    if (HAZARDS.has(n)) return '!'
    if (WATER_BLOCKS.has(n)) return '~'
    if (RESOURCES.has(n)) return '$'
    if (COVER.has(n)) return ','  // ground cover — walk straight through
    return '#'
  }

  const base = axis === 'ew' ? p.x : p.z
  const rows = []
  for (let y = yTop; y >= yBot; y--) {
    let line = ''
    for (let d = -r; d <= r; d++) {
      if (d === 0 && y === p.y) { line += '@'; continue }
      line += glyph(cell.get(`${base + d},${y}`))
    }
    rows.push(`${String(y).padStart(4)} ${line}`)
  }

  const dirLabel = axis === 'ew' ? 'west <-> east' : 'north <-> south'
  return [
    `slice ${axis} r=${r} through you@${p.x},${p.y},${p.z} (${dirLabel}, y descending)`,
    `legend: #=solid $=ore/resource ~=water !=hazard ,=plant .=OBSERVED AIR (walkable) @=you ?=never observed`,
    ...rows,
  ].join('\n')
}

// ── find ─────────────────────────────────────────────────────────────────
// One material, every source, each tagged with where it came from and how stale it
// is. Provenance is not decoration: a DB memory and a live sighting justify very
// different actions, and flattening them is how the bot ends up insisting a block
// is there when it is not.
function find(args) {
  const bot = state.bot
  const needle = String(args[0] || '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (!needle) return 'find: needs a name, e.g. [CTX:find:iron]'
  const limit = clamp(intArg(args[1], 8), 1, 20)
  const p = bot.entity.position.floored()
  const lines = []

  for (const it of bot.inventory.items()) {
    if (it.name.includes(needle)) lines.push(`  inv        ${it.name} x${it.count}`)
  }

  const survey = getLastSurvey()
  if (survey?.blocks) {
    for (const [name, rec] of Object.entries(survey.blocks)) {
      if (!name.includes(needle)) continue
      const a = rec.nearest
      const d = Math.round(new Vec3(a.x, a.y, a.z).distanceTo(p))
      lines.push(`  visible    ${name} x${rec.count} nearest@${a.x},${a.y},${a.z} (${d}m)`)
    }
  }

  try {
    for (const c of searchContainersFor(needle, p).slice(0, limit)) {
      lines.push(`  container  ${c.itemName} x${c.count} in ${c.type}@${c.x},${c.y},${c.z} (${Math.round(c.dist)}m) [cached contents]`)
    }
  } catch (e) { /* container index unavailable */ }

  for (const b of queryBlockMemoryFuzzy(needle, p, limit)) {
    const dy = b.y - p.y
    const depth = dy === 0 ? 'level' : (dy < 0 ? `${-dy} BELOW you` : `${dy} above you`)
    lines.push(`  db         ${b.name}@${b.x},${b.y},${b.z} (${Math.round(b.dist)}m, ${depth}) [memory, may be gone]`)
  }

  if (lines.length === 0) return `find "${needle}": nothing in inventory, view, containers or memory`
  return `find "${needle}" — every source, most reliable first:\n${lines.join('\n')}`
}

const PROVIDERS = {
  heightmap: {
    usage: 'heightmap[:radius]        terrain height grid, radius 1-16 (default 8)',
    render: heightmap,
  },
  slice: {
    usage: 'slice[:ns|ew][:radius]    vertical cross-section through you (default ew, r=8)',
    render: slice,
  },
  find: {
    usage: 'find:<name>[:limit]       one material across inventory/view/containers/memory',
    render: find,
  },
}

function providerNames() { return Object.keys(PROVIDERS) }
function usageLines() { return Object.values(PROVIDERS).map(p => p.usage) }
function isProvider(name) { return Object.prototype.hasOwnProperty.call(PROVIDERS, name) }

// Render every pending request and clear the queue. Requests are one-shot by design:
// a standing high-resolution view would defeat the point of having a channel for the
// things too expensive to ship every turn.
function renderPending() {
  const reqs = state.ctxRequests
  if (!reqs || reqs.length === 0) return ''
  state.ctxRequests = []

  const out = []
  for (const req of reqs.slice(0, 3)) {
    if (!isProvider(req.name)) {
      out.push(`CTX_ERR: unknown view "${req.name}" — available: ${providerNames().join(', ')}`)
      continue
    }
    const t0 = Date.now()
    try {
      out.push(PROVIDERS[req.name].render(req.args))
      console.log(`  [CTX] ${req.name}(${req.args.join(':')}) rendered in ${Date.now() - t0}ms`)
    } catch (e) {
      out.push(`CTX_ERR: ${req.name} failed: ${e.message}`)
      console.warn(`  [CTX] ${req.name} err:`, e.message)
    }
  }
  return out.join('\n\n')
}

module.exports = { PROVIDERS, providerNames, usageLines, isProvider, renderPending }
