// passages.js — where the open space the bot has seen goes on: the ways on inside a cave.
//
// A session map of every cell the bot has seen (sight.js views: lit cells only, so in the dark
// nothing is added): open, solid, water or lava. Unseen cells are unknown: nothing is guessed.
//
// From the bot's feet a walk over the seen cells (flat steps, steps 1 up with headroom, drops
// onto a seen floor) reaches every spot it could walk to. A reached spot next to unknown cells is
// a frontier: the open space goes on out of sight there. Frontier spots close together are one
// way on, told by its direction, its walking distance, and what coming back from it takes: each
// drop of 2+ blocks on the way needs blocks placed to climb back up (a 1-block step needs none).
// A way whose spots have no seen roof leads out to the surface. Drops too deep to take, water
// the walk runs into and lava in view are reported beside the ways.
//
// Reads only what vision saw (the no-x-ray rule): the map is filled from the ray view, never
// from the world.
const { WATER } = require('./sight')
const { roleOf } = require('../config/natural-blocks')

const OPEN = 1, SOLID = 2, WET = 3, LAVA = 4, BUILT = 5   // BUILT: solid, but no cave roof (leaves, logs, a house)
const NOTE_R = 32          // cells farther than this from the eye are not added to the map
const MAX_STEPS = 64       // the walk stops this many steps out
const SAFE_DROP = 3        // drops up to this are walked; deeper ones are reported
const DROP_SCAN = 24       // how far down a drop is measured
const ROOF_SCAN = 32       // a seen block this far above makes a spot covered
const JOIN = 2             // frontier spots this close (Chebyshev) are one way
const LAVA_NEAR = 16       // lava within this is reported
const COLUMNS_MAX = 400    // map columns (16x16) kept; the oldest go first
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

// stateId -> map code (OPEN, SOLID, WET, LAVA). One per registry.
const _kind = new WeakMap()
function kindTable(registry) {
  let t = _kind.get(registry)
  if (t) return t
  t = new Uint8Array(1 << 16)
  const rock = (n) => ['terrain', 'resource'].includes(roleOf(n, 'overworld', '')) || ['terrain', 'resource'].includes(roleOf(n, 'overworld', 'badlands'))
  for (const b of Object.values(registry.blocksByStateId)) {
    const k = b.name === 'lava' ? LAVA : WATER.has(b.name) ? WET : b.boundingBox !== 'block' ? OPEN : rock(b.name) ? SOLID : BUILT
    for (let s = b.minStateId; s <= b.maxStateId; s++) t[s] = k
  }
  _kind.set(registry, t)
  return t
}

// The seen cells, per 16x16 column: Uint8Array(16 * 16 * height) of codes, 0 = unknown.
class CaveMap {
  constructor(minY, height, dim) { this.minY = minY; this.height = height; this.dim = dim; this.cols = new Map(); this.lava = new Set() }
  col(x, z, make) {
    const k = `${x >> 4},${z >> 4}`
    let c = this.cols.get(k)
    if (!c && make) {
      if (this.cols.size >= COLUMNS_MAX) this.cols.delete(this.cols.keys().next().value)
      this.cols.set(k, c = new Uint8Array(256 * this.height))
    }
    return c
  }
  idx(x, y, z) { return ((y - this.minY) * 16 + (z & 15)) * 16 + (x & 15) }
  get(x, y, z) {
    if (y < this.minY || y >= this.minY + this.height) return SOLID
    const c = this.col(x, z, false)
    return c ? c[this.idx(x, y, z)] : 0
  }
  set(x, y, z, v) {
    if (y < this.minY || y >= this.minY + this.height) return
    this.col(x, z, true)[this.idx(x, y, z)] = v
    const k = `${x},${y},${z}`
    if (v === LAVA) this.lava.add(k)
    else if (this.lava.size) this.lava.delete(k)
  }
}

let map = null
function theMap(minY, height, dim = null) {
  if (!map || map.minY !== minY || map.height !== height || (dim && map.dim && dim !== map.dim)) map = new CaveMap(minY, height, dim)
  if (dim && !map.dim) map.dim = dim
  return map
}
function forget() { map = null }

// Add one view to the map. cube: sight.snapshot's; seen: castRays'.
function noteView(registry, { snap, side, x0, y0, z0, ox, oy, oz }, seen, minY, height, dim) {
  const m = theMap(minY, height, dim), kind = kindTable(registry)
  const r2 = NOTE_R * NOTE_R
  for (let y = 0, i = 0; y < side; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++, i++) {
    if (!seen[i]) continue
    const dx = x + 0.5 - ox, dy = y + 0.5 - oy, dz = z + 0.5 - oz
    if (dx * dx + dy * dy + dz * dz > r2) continue
    m.set(x0 + x, y0 + y, z0 + z, kind[snap[i]])
  }
  return m
}

// A cell the bot learns by its own body: it stands there, so feet and head are open and the
// floor holds it.
function noteBody(feet, minY, height) {
  const m = theMap(minY, height)
  if (m.get(feet.x, feet.y, feet.z) !== WET) m.set(feet.x, feet.y, feet.z, OPEN)
  if (m.get(feet.x, feet.y + 1, feet.z) !== WET) m.set(feet.x, feet.y + 1, feet.z, OPEN)
  if (!m.get(feet.x, feet.y - 1, feet.z)) m.set(feet.x, feet.y - 1, feet.z, SOLID)
}

// The ways on from feet {x,y,z}. → { ways: [{ dir, dist, at, into, cells, back, surface, unknownDrop }] (at: the
// nearest seen spot of it; into: the unseen cell next to that spot),
// drops: [{ dir, dist, at, depth, landing }] (deeper than SAFE_DROP; landing false = unseen),
// water: { dir, dist, at } | null, lava: { dir, dist, at } | null, reached, natural (reached spots
// the bot didn't dig itself) }. Nearest first.
function waysFrom(feet, m = map) {
  const out = { ways: [], drops: [], water: null, lava: null, reached: 0, natural: 0 }
  if (!m) return out
  // For walking, solid is solid: leaves and logs hold the bot as rock does. Only the roof test
  // (a way covered by rock or not) tells them apart.
  const get = (x, y, z) => { const v = m.get(x, y, z); return v === BUILT ? SOLID : v }
  const key = (x, y, z) => `${x},${y},${z}`
  const seenAt = new Map()          // key -> { dist, back }
  const front = []                  // frontier spots: { x, y, z, dist, back, unknownDrop }
  const dropsAt = new Map()
  let water = null
  const touchWater = (x, y, z, dist) => { if (!water || dist < water.dist) water = { at: { x, y, z }, dist } }

  const q = [{ x: feet.x, y: feet.y, z: feet.z, dist: 0, back: 0 }]
  seenAt.set(key(feet.x, feet.y, feet.z), q[0])
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    let frontier = false, unknownDrop = false, into = null
    const push = (x, y, z, back) => {
      const k = key(x, y, z)
      if (seenAt.has(k)) return
      const n = { x, y, z, dist: c.dist + 1, back }
      seenAt.set(k, n)
      if (n.dist <= MAX_STEPS) q.push(n)
    }
    for (const [dx, dz] of DIRS) {
      const nx = c.x + dx, nz = c.z + dz
      const feetN = get(nx, c.y, nz), headN = get(nx, c.y + 1, nz)
      if (feetN === WET || headN === WET) { touchWater(nx, c.y, nz, c.dist + 1); continue }
      if (!feetN || !headN) { frontier = true; into = into || { x: nx, y: c.y, z: nz }; continue }
      if (feetN === OPEN && headN === OPEN) {
        // Flat, or a drop: find the floor under the neighbour.
        let y = c.y - 1, depth = 0
        for (; depth < DROP_SCAN; depth++, y--) if (get(nx, y, nz) !== OPEN) break
        const under = get(nx, y, nz)
        if (!under) { frontier = true; unknownDrop = true; into = into || { x: nx, y: c.y, z: nz }; continue }
        if (under === WET) { touchWater(nx, y, nz, c.dist + 1); continue }
        if (under === LAVA) continue
        if (under !== SOLID) continue          // deeper than the scan
        if (depth > SAFE_DROP) {
          const k = key(nx, y + 1, nz)
          if (!dropsAt.has(k)) dropsAt.set(k, { at: { x: nx, y: y + 1, z: nz }, depth, dist: c.dist + 1, landing: true })
          continue
        }
        push(nx, y + 1, nz, c.back + Math.max(0, depth - 1))
      } else if (feetN === SOLID && headN === OPEN) {
        // One up: room above the neighbour, and above the bot's head to jump.
        const over = get(nx, c.y + 2, nz), jump = get(c.x, c.y + 2, c.z)
        if (!over || !jump) { frontier = true; into = into || { x: nx, y: c.y + 1, z: nz }; continue }
        if (over === OPEN && jump === OPEN) push(nx, c.y + 1, nz, c.back)
      }
    }
    if (frontier) front.push({ x: c.x, y: c.y, z: c.z, dist: c.dist, back: c.back, unknownDrop, into })
  }
  out.reached = seenAt.size
  // Reached spots the bot didn't dig out itself: few of them = it stands in its own tunnel.
  const { isDug } = require('./caves')
  for (const n of seenAt.values()) if (!isDug(n.x, n.y, n.z) && !isDug(n.x, n.y + 1, n.z)) out.natural++

  // Frontier spots, joined into ways.
  const parent = front.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < front.length; i++) for (let j = i + 1; j < front.length; j++) {
    const a = front[i], b = front[j]
    if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= JOIN) parent[find(i)] = find(j)
  }
  const groups = new Map()
  front.forEach((f, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(f) })
  const covered = (x, y, z) => { for (let k = 2; k <= ROOF_SCAN; k++) if (m.get(x, y + k, z) === SOLID) return true; return false }
  for (const g of groups.values()) {
    const near = g.reduce((a, b) => (b.dist < a.dist ? b : a))
    let sx = 0, sz = 0, sy = 0
    for (const f of g) { sx += f.x; sy += f.y; sz += f.z }
    const cx = sx / g.length + 0.5 - (feet.x + 0.5), cz = sz / g.length + 0.5 - (feet.z + 0.5), cy = sy / g.length - feet.y
    out.ways.push({
      dir: Math.hypot(cx, cz) >= 1.5 ? dirOf(cx, cy, cz)
        : near.into ? dirOf(near.into.x - feet.x, near.into.y - feet.y, near.into.z - feet.z)
        : dirOf(near.x - feet.x, near.y - feet.y, near.z - feet.z), dist: near.dist, at: { x: near.x, y: near.y, z: near.z }, into: near.into, cells: g.length,
      // A cave's mouth seen from outside: the last seen spot is still under the sky, the unseen
      // cell past it is under the rock. Either covered makes it a way into the cave.
      back: Math.min(...g.map(f => f.back)), unknownDrop: g.some(f => f.unknownDrop),
      surface: !g.some(f => covered(f.x, f.y, f.z) || (f.into && covered(f.into.x, f.into.y, f.into.z))),
    })
  }
  out.ways.sort((a, b) => a.dist - b.dist)
  for (const d of dropsAt.values()) out.drops.push({ ...d, dir: dirOf(d.at.x - feet.x, d.at.y - feet.y, d.at.z - feet.z) })
  out.drops.sort((a, b) => a.dist - b.dist)
  if (water) out.water = { ...water, dir: dirOf(water.at.x - feet.x, water.at.y - feet.y, water.at.z - feet.z) }
  // Lava: the nearest seen, by straight distance.
  let best = null
  for (const k of m.lava) {
    const [x, y, z] = k.split(',').map(Number)
    const d = Math.hypot(x - feet.x, y - feet.y, z - feet.z)
    if (d <= LAVA_NEAR && (!best || d < best.dist)) best = { at: { x, y, z }, dist: Math.round(d) }
  }
  if (best) out.lava = { ...best, dir: dirOf(best.at.x - feet.x, best.at.y - feet.y, best.at.z - feet.z) }
  return out
}

// Compass point, with "up"/"down" when it is mostly vertical, or a slope suffix when it climbs
// or sinks a lot on the way.
function dirOf(dx, dy, dz) {
  const h = Math.hypot(dx, dz)
  if (Math.abs(dy) > 2 * h) return dy > 0 ? 'up' : 'down'
  const c = h < 0.5 ? '' : compass(dx, dz)
  if (dy >= 3 && dy > h / 2) return `${c} up`.trim()
  if (dy <= -3 && -dy > h / 2) return `${c} down`.trim()
  return c || 'here'
}

module.exports = { noteView, noteBody, waysFrom, forget, theMap, kindTable, OPEN, SOLID, WET, LAVA, BUILT, SAFE_DROP }
