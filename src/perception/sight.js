// sight.js — every block the bot can see from where it stands, all around, out to R.
//
// Copies the cube of radius R around the eye out of the chunk section palettes, then
// casts one ray from the eye to the centre of every block on the cube's surface (about
// one ray per block at distance R). A ray passes air, water, glass, leaves, plants —
// anything that is not a full opaque cube — and stops at the first one that is (lava
// counts as opaque: nobody sees through it). Each block counts once, however many rays
// reach it. A block visible only by a sliver can be missed; that is accepted as
// realistic (research: TODO.md, "Biome base material").
//
// This is vision, so it may read the world directly (the no-x-ray rule is about
// navigation and actions knowing blocks the bot never saw).
const { Vec3 } = require('vec3')
const { performance } = require('perf_hooks')

const AIR = new Set(['air', 'cave_air', 'void_air'])

// stateId -> 1 if sight stops there. One table per registry.
const _opaque = new WeakMap()
function opaqueTable(registry) {
  let t = _opaque.get(registry)
  if (t) return t
  t = new Uint8Array(1 << 16)
  for (const b of Object.values(registry.blocksByStateId)) {
    if ((b.boundingBox === 'block' && !b.transparent) || b.name === 'lava') {
      for (let s = b.minStateId; s <= b.maxStateId; s++) t[s] = 1
    }
  }
  _opaque.set(registry, t)
  return t
}

// Copy the cube [eye-R, eye+R] into a Uint16Array of state ids, via section palettes.
function snapshot(bot, eye, R) {
  const side = 2 * R + 1, snap = new Uint16Array(side * side * side)
  const x0 = Math.floor(eye.x) - R, y0 = Math.floor(eye.y) - R, z0 = Math.floor(eye.z) - R
  const minY = bot.game.minY
  for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x0 + side - 1) / 16); cx++)
    for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z0 + side - 1) / 16); cz++) {
      const col = bot.world.getColumn(cx, cz); if (!col) continue          // unloaded = air
      for (let sy = 0; sy < col.sections.length; sy++) {
        const by = minY + sy * 16; if (by + 15 < y0 || by > y0 + side - 1) continue
        const d = col.sections[sy]?.data; if (!d) continue
        const single = d.value !== undefined && !d.palette ? d.value : -1
        const pal = d.palette, bits = d.data
        for (let ly = 0; ly < 16; ly++) {
          const y = by + ly - y0; if (y < 0 || y >= side) continue
          for (let lz = 0; lz < 16; lz++) {
            const z = cz * 16 + lz - z0; if (z < 0 || z >= side) continue
            const row = (y * side + z) * side
            for (let lx = 0; lx < 16; lx++) {
              const x = cx * 16 + lx - x0; if (x < 0 || x >= side) continue
              const i = (ly << 8) | (lz << 4) | lx
              snap[row + x] = single >= 0 ? single : pal ? pal[bits.get(i)] : bits.get(i)
            }
          }
        }
      }
    }
  return { snap, side, x0, y0, z0, ox: eye.x - x0, oy: eye.y - y0, oz: eye.z - z0 }
}

// One ray per block on the cube shell at distance R, aimed at its centre. Marks every cell a ray
// passes until the first opaque one (inclusive), up to distance R. Returns seen cells and how
// many rays ran their full length unblocked.
function castRays({ snap, side, ox, oy, oz }, opaque, R) {
  const seen = new Uint8Array(side * side * side)
  const ex = Math.floor(ox), ey = Math.floor(oy), ez = Math.floor(oz)
  let rays = 0, open = 0
  const ray = (a, b, c) => {
    let dx = ex + a + 0.5 - ox, dy = ey + b + 0.5 - oy, dz = ez + c + 0.5 - oz
    const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L
    rays++
    let x = ex, y = ey, z = ez
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1
    const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz)
    let tx = (dx > 0 ? x + 1 - ox : ox - x) * tdx, ty = (dy > 0 ? y + 1 - oy : oy - y) * tdy, tz = (dz > 0 ? z + 1 - oz : oz - z) * tdz
    for (;;) {
      let t
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx } else if (ty < tz) { y += sy; t = ty; ty += tdy } else { z += sz; t = tz; tz += tdz }
      if (t > R) { open++; return }
      const idx = (y * side + z) * side + x
      seen[idx] = 1
      if (opaque[snap[idx]]) return
    }
  }
  for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
    if (Math.abs(a) === R || Math.abs(b) === R) for (let c = -R; c <= R; c++) ray(a, b, c)
    else { ray(a, b, -R); ray(a, b, R) }
  }
  return { seen, rays, open }
}

// Every seen non-air cell as { id, name, x, y, z, biome }, the biome being that of the cell
// itself (not of where the bot stands). Biomes are stored per 4x4x4 cell: one lookup each.
function seenBlocks(bot, { snap, side, x0, y0, z0 }, seen) {
  const nameOf = (s) => bot.registry.blocksByStateId[s]?.name || `state#${s}`
  const biomeCache = new Map(), out = [], p = new Vec3(0, 0, 0)
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i]) continue
    const name = nameOf(snap[i]); if (AIR.has(name)) continue
    const x = x0 + i % side, z = z0 + Math.floor(i / side) % side, y = y0 + Math.floor(i / (side * side))
    const key = `${x >> 2},${y >> 2},${z >> 2}`
    let biome = biomeCache.get(key)
    if (biome === undefined) { p.set(x, y, z); biome = bot.registry.biomes[bot.world.getBiome(p)]?.name || 'unknown'; biomeCache.set(key, biome) }
    out.push({ id: snap[i], name, x, y, z, biome })
  }
  return out
}

// → { eye, radius, blocks: [{ id, name, x, y, z, biome }] (no air), rays, open (rays that
//   reached R unblocked), ms: { snapshot, rays, blocks } }
function lookAround(bot, R = 64) {
  const now = () => performance.now()
  const eye = bot.entity.position.offset(0, 1.62, 0)
  let t = now()
  const cube = snapshot(bot, eye, R)
  const tSnap = now() - t
  t = now()
  const { seen, rays, open } = castRays(cube, opaqueTable(bot.registry), R)
  const tRays = now() - t
  t = now()
  const blocks = seenBlocks(bot, cube, seen)
  const tBlocks = now() - t
  return { eye, radius: R, blocks, rays, open, ms: { snapshot: tSnap, rays: tRays, blocks: tBlocks } }
}

module.exports = { lookAround, snapshot, castRays, seenBlocks, opaqueTable, AIR }
