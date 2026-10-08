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
// The views of the bot's past (builds, chat, events, journal records) live in
// ctxPast.js and join this table below.
//
// Every provider reads the block DB, never bot.world. The DB is what the bot has
// actually observed, so a cell with no record renders as unknown rather than as
// terrain the bot was never in a position to see. That keeps these views on the
// same LOS-honest footing as the rest of perception, and the unknown markers are
// themselves useful — they are where the bot has not looked yet.
const state = require('../core/state')
const { Vec3 } = require('vec3')
const { queryRegion, queryBlockMemoryFuzzy, searchContainersFor } = require('../world/memory')
const { blockLabel, addByState } = require('../world/blockLabel')
const { getLastSurvey } = require('../perception/visibility')
const { HAZARDS, RESOURCES, WATER_BLOCKS } = require('../config/blocks')
const { PAST_PROVIDERS } = require('./ctxPast')
const { DIRS, measureFall, damageOf } = require('../navigation/fall')

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
//
// A 1-block-thick plane is a razor: a vein one block off-axis is invisible, which is
// exactly the near-miss that stalls a dig ("the coal's one block west"). `thick` widens
// the SEARCH for notable blocks either side of the cut — it does NOT widen the grid.
//
// The grid stays a true single-plane cross-section on purpose. An earlier version
// projected the whole slab onto one grid, ranking each cell by the most decision-relevant
// block at that depth. It read well and cost no extra tokens, but it invented a wall that
// does not exist: a "#" could be one solid block among four air, and "." only held when
// every plane was air. The two questions the view is actually for — can I walk here, is
// this face solid — were the two the projection could not answer, and it needed a
// disclaimer telling the model how not to misread it. A view that needs that is shaped
// wrong. Detection is what thickness genuinely fixes, so thickness now feeds only the
// coordinate list, where an off-plane find can be reported at its true position instead
// of being smeared onto a fictional surface.
function slice(args) {
  const bot = state.bot
  const raw = String(args[0] || 'ew').toLowerCase()
  const axis = /^[ns]/.test(raw) ? 'ns' : 'ew'
  const r = clamp(intArg(args[1], 8), 1, 16)
  // `thick` is the total width of the SEARCH band in planes; even values round up so a
  // request never scans narrower than asked. thick=1 searches the drawn plane only.
  const half = clamp(Math.floor(intArg(args[2], 1) / 2), 0, 8)
  const thick = 2 * half + 1
  const p = bot.entity.position.floored()
  const yTop = p.y + 5, yBot = p.y - clamp(r * 2, 6, 32)

  // Along-axis extent is the slice width; cross-axis extent is the search band.
  const box = axis === 'ew'
    ? queryRegion(p.x - r, yBot, p.z - half, p.x + r, yTop, p.z + half)
    : queryRegion(p.x - half, yBot, p.z - r, p.x + half, yTop, p.z + r)

  const glyph = (n) => {
    if (!n) return '?'          // no row at all — never observed
    if (AIR.has(n)) return '.'  // observed and empty — walkable
    if (HAZARDS.has(n)) return '!'
    if (WATER_BLOCKS.has(n)) return '~'
    if (RESOURCES.has(n)) return '$'
    if (COVER.has(n)) return ','  // ground cover — walk straight through
    return '#'
  }

  const crossOf = (b) => (axis === 'ew' ? b.z : b.x) - (axis === 'ew' ? p.z : p.x)

  const cell = new Map()     // "axisCoord,y" -> glyph, CENTRE PLANE ONLY
  const notable = new Map()  // blockName -> { count, best, dist, offPlane }
  for (const b of box) {
    const off = crossOf(b)
    const g = glyph(b.name)
    // Only the bot's own plane is ever drawn, so the grid remains literally true.
    if (off === 0) cell.set(`${axis === 'ew' ? b.x : b.z},${b.y}`, g)
    if (g === '$' || g === '!') {
      const d = new Vec3(b.x, b.y, b.z).distanceTo(p)
      let rec = notable.get(b.name)
      if (!rec) notable.set(b.name, rec = { count: 0, best: b, dist: d })
      rec.count++
      if (d < rec.dist) { rec.best = b; rec.dist = d }
      addByState(rec, b.state, b, d)
    }
  }

  const base = axis === 'ew' ? p.x : p.z
  const rows = []
  let observed = 0
  for (let y = yTop; y >= yBot; y--) {
    let line = ''
    for (let d = -r; d <= r; d++) {
      if (d === 0 && y === p.y) { line += '@'; continue }
      const g = cell.get(`${base + d},${y}`)
      if (g) observed++
      line += g || '?'
    }
    rows.push(`${String(y).padStart(4)} ${line}`)
  }

  // Horizontal ruler. Without it the only way to turn a column into a coordinate is to
  // count characters and add the origin — a silent-error generator, and the grid's whole
  // job is producing coordinates to act on.
  const alongLabel = axis === 'ew' ? 'x' : 'z'
  let ticks = '', labels = ''
  for (let d = -r; d <= r; d++) {
    const a = base + d
    if (a % 5 === 0 && labels.length <= ticks.length) {
      ticks += "'"
      labels += String(a)
    } else {
      ticks += ' '
      if (labels.length < ticks.length) labels += ' '
    }
  }
  const pad = ' '.repeat(5)

  const dirLabel = axis === 'ew' ? 'west(-) <-> east(+)' : 'north(-) <-> south(+)'
  const crossLabel = axis === 'ew' ? 'z' : 'x'

  const out = [
    `slice ${axis} through you@${p.x},${p.y},${p.z} — ${alongLabel} ${base - r}..${base + r} (${dirLabel}), y ${yTop}..${yBot} (top row is y=${yTop})`,
    `legend: #=solid $=ore/resource ~=water !=hazard ,=plant .=OBSERVED AIR (walkable) @=you ?=never observed`,
    `every cell is a REAL block on the single plane ${crossLabel}=${axis === 'ew' ? p.z : p.x}; nothing is merged or inferred`,
    `coverage: ${observed}/${(2 * r + 1) * (yTop - yBot + 1) - 1} cells observed`,
    pad + labels.trimEnd(),
    pad + ticks.trimEnd(),
    ...rows,
  ]

  if (notable.size) {
    const items = [...notable.entries()]
      .sort((a, b) => a[1].dist - b[1].dist)
      .slice(0, 8)
      .flatMap(([name, v]) => [...v.byState.entries()].map(([st, sub]) => {
        const b = sub.nearest, off = crossOf(b)
        const where = off === 0
          ? 'ON this plane'
          : `${Math.abs(off)} ${axis === 'ew' ? (off > 0 ? 'south' : 'north') : (off > 0 ? 'east' : 'west')} of it`
        return `${blockLabel(name, st)} x${sub.count} nearest@${b.x},${b.y},${b.z} (${Math.round(sub.nearestDist)}m, ${where})`
      }))
    out.push(
      half === 0
        ? `notable on this plane:`
        : `notable within ${half} block(s) either side of the plane (${crossLabel}=${(axis === 'ew' ? p.z : p.x) - half}..${(axis === 'ew' ? p.z : p.x) + half}) — ` +
          `anything listed as off the plane is NOT drawn in the grid above; go by its coordinates:`,
      ...items.map((s) => `  ${s}`)
    )
  } else {
    out.push(half === 0
      ? `notable on this plane: none — widen the search with [CTX:slice:${axis}:${r}:5] to look either side of it`
      : `notable within ${half} block(s) either side of the plane: no ores or hazards recorded`)
  }

  return out.join('\n')
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
      for (const [st, sub] of rec.byState || [[rec.nearest?.state, rec]]) {
        const a = sub.nearest
        const d = Math.round(new Vec3(a.x, a.y, a.z).distanceTo(p))
        lines.push(`  visible    ${blockLabel(name, st)} x${sub.count}${rec.many ? '+' : ''} nearest@${a.x},${a.y},${a.z} (${d}m)`)
      }
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
    lines.push(`  db         ${blockLabel(b.name, b.state)}@${b.x},${b.y},${b.z} (${Math.round(b.dist)}m, ${depth}) [memory, may be gone]`)
  }

  if (lines.length === 0) return `find "${needle}": nothing in inventory, view, containers or memory`
  return `find "${needle}" — every source, most reliable first:\n${lines.join('\n')}`
}

// ── around ───────────────────────────────────────────────────────────────
// The bot's immediate surroundings: a 5x5 block, 2 above the feet to 3 below, drawn
// as six small layers, plus what each side does to someone stepping that way. This
// is the view for "why can't I move": a pillar, a ledge, a pit or a walled-in spot
// reads off it at a glance, where a long slice buries it in terrain. Sent in every
// context (context.js), not on request: a stuck bot never thought to ask for it.
function around() {
  const bot = state.bot
  const p = bot.entity.position.floored()
  const R = 2, UP = 2, DOWN = 3
  const cells = new Map()    // "x,y,z" -> row ({ name, state })
  for (const b of queryRegion(p.x - R, p.y - DOWN, p.z - R, p.x + R, p.y + UP, p.z + R)) cells.set(`${b.x},${b.y},${b.z}`, b)
  const at = (x, y, z) => cells.get(`${x},${y},${z}`)?.name ?? null
  const label = (x, y, z) => { const b = cells.get(`${x},${y},${z}`); return b ? blockLabel(b.name, b.state) : null }
  const glyph = (n) => {
    if (!n) return '?'
    if (AIR.has(n)) return '.'
    if (HAZARDS.has(n)) return '!'
    if (WATER_BLOCKS.has(n)) return '~'
    if (COVER.has(n)) return ','
    return '#'
  }

  const layers = []
  for (let dy = UP; dy >= -DOWN; dy--) {
    const rows = []
    for (let dz = -R; dz <= R; dz++) {
      let line = ''
      for (let dx = -R; dx <= R; dx++) {
        const me = dx === 0 && dz === 0 && (dy === 0 || dy === 1)
        line += me ? '@' : glyph(at(p.x + dx, p.y + dy, p.z + dz))
      }
      rows.push(line)
    }
    layers.push({ label: `y${p.y + dy}${dy === 0 ? '(feet)' : ''}`, rows })
  }
  const w = 11
  const grid = [layers.map(l => l.label.padEnd(w)).join('')]
  for (let r = 0; r < 2 * R + 1; r++) grid.push(layers.map(l => l.rows[r].padEnd(w)).join(''))

  // What stepping each way does, from the DB (the same fall measure digdown uses).
  const pass = (n) => n !== null && (AIR.has(n) || COVER.has(n))
  const sides = []
  let drops = 0
  for (const [name, [dx, dz]] of Object.entries(DIRS)) {
    const x = p.x + dx, z = p.z + dz
    const foot = at(x, p.y, z), head = at(x, p.y + 1, z)
    let s
    if (foot === null || head === null) s = 'unseen'
    else if (!pass(foot)) s = pass(head) && pass(at(x, p.y + 2, z)) ? `step up onto ${label(x, p.y, z)}` : `wall (${label(x, p.y, z)})`
    else if (!pass(head)) s = `blocked at head height (${label(x, p.y + 1, z)})`
    else {
      const f = measureFall(x, p.y, z)
      if (f.hazard) s = `drop ${f.blocks} into ${f.hazard}`
      else if (f.unknown) s = f.blocks === 0 ? 'open, ground unseen' : `drop ≥${f.blocks}, landing unseen`
      else if (f.blocks === 0) s = 'walkable'
      else if (f.water) s = `drop ${f.blocks} into water`
      else if (f.blocks <= 3) s = `step down ${f.blocks}`
      else s = `drop ${f.blocks} → onto ${f.landing}, stand at y${f.stand} (~${damageOf(f)} dmg)`
      if (f.blocks > 3) drops++
    }
    sides.push(`${name}: ${s}`)
  }
  const floor = at(p.x, p.y - 1, p.z)
  const under = measureFall(p.x, p.y, p.z, 1)
  const below = floor === null ? 'floor unseen'
    : `floor ${label(p.x, p.y - 1, p.z)}; breaking it: ${under.unknown ? `drop ≥${under.blocks}, then unseen` : `drop ${under.blocks} → onto ${under.landing ?? '?'}, stand at y${under.stand}`}`

  const out = [`around ${p.x},${p.y},${p.z} — layers top→bottom, each 5x5: rows north→south, columns west→east, @ = you`, ...grid]
  out.push(sides.join(' | '))
  out.push(`under you: ${below}`)
  if (drops === 4) out.push('every side drops more than 3 blocks — you are on a pillar or a peak')
  else if (drops > 0) out.push(`${drops} of 4 sides drop more than 3 blocks`)
  return out.join('\n')
}

const PROVIDERS = {
  heightmap: {
    usage: 'heightmap[:radius]        terrain height grid, radius 1-16 (default 8)',
    render: heightmap,
  },
  slice: {
    usage: 'slice[:ns|ew][:radius][:thick]  vertical cross-section of the plane you stand on (default ew, r=8); thick widens the ORE/HAZARD SEARCH either side of it, not the grid',
    render: slice,
  },
  find: {
    usage: 'find:<name>[:limit]       one material across inventory/view/containers/memory',
    render: find,
  },
  ...PAST_PROVIDERS,
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

module.exports = { PROVIDERS, providerNames, usageLines, isProvider, renderPending, around }
