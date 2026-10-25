// landforms.js — the shape of the ground in view: hills, ridges, valleys, cliffs, flats.
//
// From one view (sight.lookAround's blocks) it takes the ground height of every column the bot
// saw: the top seen terrain block (or water surface; trees are not ground). Unseen columns stay
// unknown: nothing is guessed behind a hill.
//
// Each known column gets a geomorphon (Jasiewicz & Stepinski 2013, as GRASS r.geomorphon): along
// 8 directions out to L blocks, is the horizon higher (+), lower (-) or level (0) beyond FLAT
// degrees? The count of + and - names the form: peak, ridge, shoulder, spur, slope, hollow,
// footslope, valley, pit or flat. A column with fewer than MIN_DIRS directions seen is unknown.
//
// Features are the forms joined (8-connected): hills and ridges (peak/ridge cells), valleys and
// basins (valley/pit), flats; and cliffs: runs of steep steps (CLIFF_STEP+ down to the next
// column), with their full height and the way they face. A feature whose edge runs into unseen
// ground is marked open: it may go on out of sight.
const { roleOf } = require('../config/natural-blocks')

const L = 20              // geomorphon lookup distance, blocks
const FLAT = 5            // degrees: a horizon within this of level is level
const MIN_DIRS = 6        // directions with seen ground needed to name a column's form
const CLIFF_STEP = 3      // a drop this big to the next column is a steep step
const CLIFF_MIN = 4       // a cliff is this high at least
const MIN_CELLS = { hill: 12, valley: 12, flat: 150 }
const OPEN_MIN = 3        // this many border cells unseen: the feature is open

const FORMS = ['unknown', 'flat', 'peak', 'ridge', 'shoulder', 'spur', 'slope', 'hollow', 'footslope', 'valley', 'pit']
const [UN, FL, PK, RI, SH, SP, SL, HL, FS, VL, PT] = FORMS.map((_, i) => i)
// [minus][plus] -> form (r.geomorphon's table); minus: directions lower, plus: higher.
const TABLE = [
  [FL, FL, FL, FS, FS, VL, VL, VL, PT],
  [FL, FL, FS, FS, FS, VL, VL, VL, UN],
  [FL, SH, SL, SL, HL, HL, VL, UN, UN],
  [SH, SH, SL, SL, SL, HL, UN, UN, UN],
  [SH, SH, SP, SL, SL, UN, UN, UN, UN],
  [RI, RI, SP, SP, UN, UN, UN, UN, UN],
  [RI, RI, RI, UN, UN, UN, UN, UN, UN],
  [RI, RI, UN, UN, UN, UN, UN, UN, UN],
  [PK, UN, UN, UN, UN, UN, UN, UN, UN],
]
const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

// Ground height per column from seen blocks. → { x0, z0, w, h, top: Float32Array (NaN = unseen) }
function groundMap(blocks) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  const ground = []
  for (const b of blocks) {
    if (b.name !== 'water' && roleOf(b.name, 'overworld', b.biome) !== 'terrain') continue
    ground.push(b)
    if (b.x < x0) x0 = b.x; if (b.x > x1) x1 = b.x; if (b.z < z0) z0 = b.z; if (b.z > z1) z1 = b.z
  }
  if (!ground.length) return null
  const w = x1 - x0 + 1, h = z1 - z0 + 1, top = new Float32Array(w * h).fill(NaN)
  for (const b of ground) {
    const i = (b.z - z0) * w + (b.x - x0)
    if (!(top[i] >= b.y)) top[i] = b.y
  }
  return { x0, z0, w, h, top }
}

// Geomorphon of every column. → Uint8Array of FORMS indices
function geomorphons({ w, h, top }) {
  const out = new Uint8Array(w * h), tFlat = FLAT * Math.PI / 180
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x, h0 = top[i]
    if (Number.isNaN(h0)) continue
    let plus = 0, minus = 0, known = 0
    for (const [dx, dz] of DIRS8) {
      const step = Math.hypot(dx, dz)
      let up = -Infinity, down = Infinity, any = false
      for (let k = 1; k * step <= L; k++) {
        const xx = x + dx * k, zz = z + dz * k
        if (xx < 0 || zz < 0 || xx >= w || zz >= h) break
        const hh = top[zz * w + xx]
        if (Number.isNaN(hh)) continue
        const s = (hh - h0) / (k * step)
        if (s > up) up = s
        if (s < down) down = s
        any = true
      }
      if (!any) continue
      known++
      // r.geomorphon: nadir - zenith = (90 + min angle) - (90 - max angle) = max + min
      const d = Math.atan(up) + Math.atan(down)
      if (d > tFlat) plus++
      else if (d < -tFlat) minus++
    }
    out[i] = known < MIN_DIRS ? UN : TABLE[minus][plus]
  }
  return out
}

// Cliffs: columns with a steep step down to a 4-neighbour, joined 8-connected. Height: the drop
// followed down the face while the steps stay steep-ish (2+), from the top of the run.
function findCliffs(g, eye) {
  const { x0, z0, w, h, top } = g
  const edge = new Map()   // i -> { drop, dx, dz }
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x, h0 = top[i]
    if (Number.isNaN(h0)) continue
    let best = null
    for (const [dx, dz] of DIRS4) {
      const xx = x + dx, zz = z + dz
      if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue
      const n = top[zz * w + xx]
      if (Number.isNaN(n) || h0 - n < CLIFF_STEP) continue
      let foot = n
      for (let k = 2; k <= 16; k++) {
        const x2 = x + dx * k, z2 = z + dz * k
        if (x2 < 0 || z2 < 0 || x2 >= w || z2 >= h) break
        const m = top[z2 * w + x2]
        if (Number.isNaN(m) || foot - m < 2) break
        foot = m
      }
      const drop = h0 - foot
      if (!best || drop > best.drop) best = { drop, dx, dz }
    }
    if (best) edge.set(i, best)
  }
  const out = [], done = new Set()
  for (const i0 of edge.keys()) {
    if (done.has(i0)) continue
    const stack = [i0], cells = []
    done.add(i0)
    while (stack.length) {
      const i = stack.pop(); cells.push(i)
      const x = i % w, z = Math.floor(i / w)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, zz = z + dz, j = zz * w + xx
        if ((dx || dz) && xx >= 0 && zz >= 0 && xx < w && zz < h && edge.has(j) && !done.has(j)) { done.add(j); stack.push(j) }
      }
    }
    let height = 0, fx = 0, fz = 0, near = null, nd = Infinity
    for (const i of cells) {
      const e = edge.get(i), x = x0 + i % w, z = z0 + Math.floor(i / w)
      height = Math.max(height, e.drop); fx += e.dx * e.drop; fz += e.dz * e.drop
      const d = Math.hypot(x + 0.5 - eye.x, z + 0.5 - eye.z)
      if (d < nd) { nd = d; near = { x, y: top[i], z } }
    }
    if (height >= CLIFF_MIN) out.push({ kind: 'cliff', height, faces: compass(fx, fz), length: cells.length, at: near, dist: Math.round(nd) })
  }
  return out
}

// Regions of the given forms, joined 8-connected: size, extreme point, rise/depth against the
// ground around (within L), run direction if long, open if its border runs into unseen ground.
function regions(g, forms, kind, want, eye) {
  const { x0, z0, w, h, top } = g
  const done = new Uint8Array(w * h), out = []
  for (let i0 = 0; i0 < w * h; i0++) {
    if (done[i0] || !want.has(forms[i0])) continue
    const stack = [i0], cells = []
    done[i0] = 1
    let unseen = 0
    while (stack.length) {
      const i = stack.pop(); cells.push(i)
      const x = i % w, z = Math.floor(i / w)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const xx = x + dx, zz = z + dz
        if (xx < 0 || zz < 0 || xx >= w || zz >= h) { unseen++; continue }
        const j = zz * w + xx
        if (want.has(forms[j])) { if (!done[j]) { done[j] = 1; stack.push(j) } continue }
        if (forms[j] === UN) unseen++                 // unseen, or too little seen around it
      }
    }
    if (cells.length < MIN_CELLS[kind]) continue
    // Extreme point: highest for a hill, lowest for a valley; nearest cell for a flat.
    let ext = cells[0], near = cells[0], nd = Infinity, mx = 0, mz = 0
    for (const i of cells) {
      if (kind === 'hill' ? top[i] > top[ext] : top[i] < top[ext]) ext = i
      const x = i % w, z = Math.floor(i / w)
      mx += x; mz += z
      const d = Math.hypot(x0 + x + 0.5 - eye.x, z0 + z + 0.5 - eye.z)
      if (d < nd) { nd = d; near = i }
    }
    // Shape: principal axis of the cells (elongated = a ridge or a valley running that way).
    mx /= cells.length; mz /= cells.length
    let sxx = 0, szz = 0, sxz = 0
    for (const i of cells) { const dx = i % w - mx, dz = Math.floor(i / w) - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz }
    const tr = sxx + szz, det = sxx * szz - sxz * sxz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det))
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc)
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz)
    const runs = l1 / l2 >= 4 ? [compass(Math.cos(ang), Math.sin(ang)), compass(-Math.cos(ang), -Math.sin(ang))].sort().join('-') : null
    // Rise (hill) or depth (valley): against the lowest / highest known ground within L of it.
    const ex = ext % w, ez = Math.floor(ext / w)
    let other = top[ext]
    for (let dz = -L; dz <= L; dz++) for (let dx = -L; dx <= L; dx++) {
      const xx = ex + dx, zz = ez + dz
      if (xx < 0 || zz < 0 || xx >= w || zz >= h || dx * dx + dz * dz > L * L) continue
      const t = top[zz * w + xx]
      if (Number.isNaN(t)) continue
      if (kind === 'hill' ? t < other : t > other) other = t
    }
    const pick = kind === 'flat' ? near : ext
    const at = { x: x0 + pick % w, y: top[pick], z: z0 + Math.floor(pick / w) }
    const f = { kind, cells: cells.length, at, dist: Math.round(Math.hypot(at.x + 0.5 - eye.x, at.z + 0.5 - eye.z)), open: unseen >= OPEN_MIN }
    if (kind === 'hill') { f.rise = top[ext] - other; f.ridge = runs }
    if (kind === 'valley') { f.depth = other - top[ext]; f.runs = runs }
    out.push(f)
  }
  return out
}

// blocks: lookAround's; eye: {x,y,z}. → { forms (per column, FORMS indices), map (groundMap),
// cliffs, hills, valleys, flats } each nearest first; null when no ground is in view.
function landforms(blocks, eye) {
  const g = groundMap(blocks)
  if (!g) return null
  const forms = geomorphons(g)
  const near = (a, b) => a.dist - b.dist
  return {
    map: g, forms,
    cliffs: findCliffs(g, eye).sort(near),
    hills: regions(g, forms, 'hill', new Set([PK, RI]), eye).sort(near),
    valleys: regions(g, forms, 'valley', new Set([VL, PT]), eye).sort(near),
    flats: regions(g, forms, 'flat', new Set([FL]), eye).sort(near),
  }
}

module.exports = { landforms, groundMap, geomorphons, FORMS, L, FLAT }
