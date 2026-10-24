// caves.js — caves the bot can make out from the surface, by their shape.
//
// Reads one ray-cast view (sight.js): the terrain blocks it saw, and the open cells its dry
// sightlines passed (dark ones too: a dark hole is still a hole). An open cell is a cave cue when
//   covered: a seen terrain block stands above it in its column (a ceiling, an overhang), or
//   pit:     it lies PIT_DEPTH+ blocks below the seen ground on both sides, along x or along z
//            (the nearest seen column within RIM on each side) — a hole or a gap in the ground.
// Cue cells are joined 6-connected; a group of MIN_CELLS+ is a suspected cave. Only natural
// terrain roofs a cave (natural-blocks.js): a house or a tree is not one. Cells the bot dug
// itself are not a cave either (noteDug). Sightlines stop at water: nothing seen through it.
//
// Measured on the real server (2026-10-24, daylight, 5 known + 5 new random land patches, 800
// surface spots, ground truth from the whole world): 97% of reports were real caves, and 93-97%
// of the caves a spot could see 3+ blocks into were reported.
//
// Surface only: underground, everything around is "covered", so no report there.
const { roleOf } = require('../config/natural-blocks')

const PIT_DEPTH = 3
const RIM = 3
const MIN_CELLS = 20
const NEAR_EYE = 1.5   // cells this close to the eye are the bot's own spot, not a cue
const DUG_MAX = 4096

// Cells the bot dug (session memory): its own tunnels and pits are not caves.
const dug = new Set()
function noteDug(pos) {
  if (dug.size >= DUG_MAX) dug.delete(dug.values().next().value)
  dug.add(`${pos.x},${pos.y},${pos.z}`)
}

// stateId -> 1 if the block is natural terrain or ore (what a cave is cut into). One per registry.
const _cover = new WeakMap()
function coverTable(registry, opaque) {
  let t = _cover.get(registry)
  if (t) return t
  t = new Uint8Array(1 << 16)
  for (const b of Object.values(registry.blocksByStateId)) {
    if (!['terrain', 'resource'].includes(roleOf(b.name, 'overworld', ''))) continue
    for (let s = b.minStateId; s <= b.maxStateId; s++) if (opaque[s]) t[s] = 1
  }
  _cover.set(registry, t)
  return t
}

// cube: sight.snapshot's; seen, dry: castRays'. → [{ cells, at: {x,y,z} (its nearest cell),
// dist }] nearest first; [] when the bot is not under open sky.
function suspectCaves(registry, { snap, side, x0, y0, z0, ox, oy, oz }, seen, dry, opaque) {
  const cover = coverTable(registry, opaque)
  const seenTop = new Int16Array(side * side).fill(-1)     // per column: highest seen terrain block
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i] || !cover[snap[i]]) continue
    const x = i % side, z = Math.floor(i / side) % side, y = Math.floor(i / (side * side))
    const k = z * side + x
    if (y > seenTop[k]) seenTop[k] = y
  }
  const ex = Math.floor(ox), ey = Math.floor(oy), ez = Math.floor(oz)
  if (seenTop[ez * side + ex] > ey) return []                // underground or under an overhang

  const top = (x, z) => (x < 0 || z < 0 || x >= side || z >= side) ? -1 : seenTop[z * side + x]
  const rim = (x, z, dx, dz) => {
    let p = -1, q = -1
    for (let k = 1; k <= RIM && p < 0; k++) p = top(x + dx * k, z + dz * k)
    for (let k = 1; k <= RIM && q < 0; k++) q = top(x - dx * k, z - dz * k)
    return p < 0 || q < 0 ? -1 : Math.min(p, q)
  }
  const cue = new Uint8Array(dry.length)
  for (let i = 0; i < dry.length; i++) {
    if (!dry[i]) continue
    const x = i % side, z = Math.floor(i / side) % side, y = Math.floor(i / (side * side))
    if (Math.hypot(x + 0.5 - ox, y + 0.5 - oy, z + 0.5 - oz) <= NEAR_EYE) continue
    if (dug.has(`${x0 + x},${y0 + y},${z0 + z}`)) continue
    const r = Math.max(rim(x, z, 1, 0), rim(x, z, 0, 1))
    if (top(x, z) > y || (r >= 0 && r - y >= PIT_DEPTH)) cue[i] = 1
  }

  const out = []
  const steps = [1, -1, side, -side, side * side, -side * side]
  for (let i0 = 0; i0 < cue.length; i0++) {
    if (cue[i0] !== 1) continue
    cue[i0] = 2
    const stack = [i0]
    let cells = 0, best = Infinity, at = null
    while (stack.length) {
      const i = stack.pop(); cells++
      const x = i % side, z = Math.floor(i / side) % side, y = Math.floor(i / (side * side))
      const d = Math.hypot(x + 0.5 - ox, y + 0.5 - oy, z + 0.5 - oz)
      if (d < best) { best = d; at = { x: x0 + x, y: y0 + y, z: z0 + z } }
      for (const s of steps) {
        const j = i + s
        if (j < 0 || j >= cue.length || cue[j] !== 1) continue
        // stay in the same row/column across the x and z edges of the cube
        if ((s === 1 && x === side - 1) || (s === -1 && x === 0)) continue
        if ((s === side && z === side - 1) || (s === -side && z === 0)) continue
        cue[j] = 2; stack.push(j)
      }
    }
    if (cells >= MIN_CELLS) out.push({ cells, at, dist: Math.round(best) })
  }
  return out.sort((a, b) => a.dist - b.dist)
}

module.exports = { suspectCaves, noteDug, MIN_CELLS, PIT_DEPTH }
