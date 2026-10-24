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
// Measured on the real server (2026-10-24, daylight, 40 random land patches it was not tuned on,
// 998 surface spots, ground truth from the whole world): of 58 caves some spot could see 3+ blocks
// into, 54 were reported (93%; each miss was seen from one spot only); of the distinct places
// reported, 121 were real caves and 16 natural ledges or hollows under 30 cells (88%).
// MIN_CELLS 30 would give 86% / 94%.
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

// Natural, but no cave roof: ice spikes lean over open air (8 of 11 false places on the real
// server were under them), and snow lies on top of things.
const NOT_ROOF = new Set(['ice', 'packed_ice', 'blue_ice', 'snow_block', 'powder_snow'])
const ROCK = new Set(['terrain', 'resource'])

// stateId -> 1 if the block is natural terrain or ore (what a cave is cut into), in any overworld
// biome (badlands terracotta too). One per registry.
const _cover = new WeakMap()
function coverTable(registry, opaque) {
  let t = _cover.get(registry)
  if (t) return t
  t = new Uint8Array(1 << 16)
  for (const b of Object.values(registry.blocksByStateId)) {
    if (NOT_ROOF.has(b.name)) continue
    if (!ROCK.has(roleOf(b.name, 'overworld', '')) && !ROCK.has(roleOf(b.name, 'overworld', 'badlands'))) continue
    for (let s = b.minStateId; s <= b.maxStateId; s++) if (opaque[s]) t[s] = 1
  }
  _cover.set(registry, t)
  return t
}

// cube: sight.snapshot's; seen, dry: castRays'. → [{ cells, at: {x,y,z} (its nearest cell),
// dist }] nearest first; [] when the bot is not under open sky.
function suspectCaves(registry, { snap, side, x0, y0, z0, ox, oy, oz }, seen, dry, opaque) {
  const cover = coverTable(registry, opaque)
  const plane = side * side
  const seenTop = new Int16Array(plane).fill(-1)            // per column (z * side + x): highest seen terrain block
  for (let y = 0, i = 0; y < side; y++) for (let k = 0; k < plane; k++, i++) {
    if (seen[i] && cover[snap[i]]) seenTop[k] = y
  }
  const ex = Math.floor(ox), ey = Math.floor(oy), ez = Math.floor(oz)
  if (seenTop[ez * side + ex] > ey) return []                // underground or under an overhang

  // Per column, the pit rim: along x and along z, the lower of the nearest seen column within RIM
  // on each side; the higher of the two axes. -1: no rim.
  const top = (x, z) => (x < 0 || z < 0 || x >= side || z >= side) ? -1 : seenTop[z * side + x]
  const rimAxis = (x, z, dx, dz) => {
    let p = -1, q = -1
    for (let k = 1; k <= RIM && p < 0; k++) p = top(x + dx * k, z + dz * k)
    for (let k = 1; k <= RIM && q < 0; k++) q = top(x - dx * k, z - dz * k)
    return p < 0 || q < 0 ? -1 : Math.min(p, q)
  }
  const rim = new Int16Array(plane)
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) rim[z * side + x] = Math.max(rimAxis(x, z, 1, 0), rimAxis(x, z, 0, 1))

  const cue = new Uint8Array(dry.length)
  for (let y = 0, i = 0; y < side; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++, i++) {
    if (!dry[i]) continue
    const k = z * side + x
    if (!(seenTop[k] > y || (rim[k] >= 0 && rim[k] - y >= PIT_DEPTH))) continue
    if (Math.hypot(x + 0.5 - ox, y + 0.5 - oy, z + 0.5 - oz) <= NEAR_EYE) continue
    if (dug.size && dug.has(`${x0 + x},${y0 + y},${z0 + z}`)) continue
    cue[i] = 1
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
