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
// Light: in the dark nothing is seen. A block shows only if the face a ray reaches is
// lit, and that face's light is the light of the cell in front of it, the last one the
// ray crossed (an opaque block has no light of its own). Cells the ray only passes
// (plants, water, glass) are lit by their own cell. So dark air on the way doesn't hide
// a lit wall, and a lit cave mouth shows from a dark tunnel. Light sources always show.
// Effective light = max(block light, sky light - night darkening). Overworld only: the
// Nether and the End are dimly lit everywhere.
//
// This is vision, so it may read the world directly (the no-x-ray rule is about
// navigation and actions knowing blocks the bot never saw).
const { Vec3 } = require('vec3')
const { performance } = require('perf_hooks')

const AIR = new Set(['air', 'cave_air', 'void_air'])

const MIN_LIGHT = 1          // below this a block is too dark to see

// Vanilla's sky darkening (Level.updateSkyBrightness): 0 at noon, 11 at midnight, more in
// rain and thunder. timeOfDay 0-24000; rain/thunder 0-1.
function skyDarken(timeOfDay, rain = 0, thunder = 0) {
  const d = ((timeOfDay / 24000 - 0.25) % 1 + 1) % 1
  const angle = (d * 2 + (0.5 - Math.cos(d * Math.PI) / 2)) / 3
  const d2 = 0.5 + 2 * Math.max(-0.25, Math.min(0.25, Math.cos(angle * Math.PI * 2)))
  return Math.floor((1 - d2 * (1 - rain * 5 / 16) * (1 - thunder * 5 / 16)) * 11)
}

// stateId -> 1 if the block gives off light (always seen). One table per registry.
const _emits = new WeakMap()
function emitTable(registry) {
  let t = _emits.get(registry)
  if (t) return t
  t = new Uint8Array(1 << 16)
  for (const b of Object.values(registry.blocksByStateId)) {
    if (b.emitLight > 0) for (let s = b.minStateId; s <= b.maxStateId; s++) t[s] = 1
  }
  _emits.set(registry, t)
  return t
}

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
// darken (a number) also copies each cell's effective light into `light`; null skips it.
function snapshot(bot, eye, R, darken = null) {
  const side = 2 * R + 1, snap = new Uint16Array(side * side * side)
  const light = darken === null ? null : new Uint8Array(side * side * side)
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
        // Light sections run one below the block sections: index sy + 1.
        const bl = light && col.blockLightSections?.[sy + 1], sl = light && col.skyLightSections?.[sy + 1]
        for (let ly = 0; ly < 16; ly++) {
          const y = by + ly - y0; if (y < 0 || y >= side) continue
          for (let lz = 0; lz < 16; lz++) {
            const z = cz * 16 + lz - z0; if (z < 0 || z >= side) continue
            const row = (y * side + z) * side
            for (let lx = 0; lx < 16; lx++) {
              const x = cx * 16 + lx - x0; if (x < 0 || x >= side) continue
              const i = (ly << 8) | (lz << 4) | lx
              snap[row + x] = single >= 0 ? single : pal ? pal[bits.get(i)] : bits.get(i)
              if (light) light[row + x] = Math.max(bl ? bl.get(i) : 0, (sl ? sl.get(i) : 0) - darken)
            }
          }
        }
      }
    }
  return { snap, light, side, x0, y0, z0, ox: eye.x - x0, oy: eye.y - y0, oz: eye.z - z0 }
}

const NEAR = 8               // blocks: the darkness close enough to matter — about what one torch lights
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']   // +x east, +z south

// One ray per block on the cube shell at distance R, aimed at its centre. Marks every cell a ray
// passes until the first opaque one (inclusive), up to distance R. With a light cube, a cell is
// marked only if lit where the ray meets it (see the header) or it emits light; a ray goes on
// through dark air, so a lit block beyond it is still seen.
//
// The same rays measure how dark the near space is (near): a ray is dark if any cell it enters
// within NEAR is unlit — the cell in front of the block it stops at included, since that is the
// light the block's face is seen by. Shell rays crowd toward the cube's corners, so each counts by
// the slice of view it covers (∝ 1/|offset|³), which makes every direction weigh the same.
// Returns the seen cells, how many rays ran their full length unblocked, and near:
// { here (light at the eye), share (of the view), dirs: [[dir, share of that direction]] (8
// compass points, or up / down when mostly vertical), darkest first } — null without light data.
function castRays({ snap, light, side, ox, oy, oz }, opaque, R, emits = null) {
  const seen = new Uint8Array(side * side * side)
  const lit = (idx, face) => !light || light[face] >= MIN_LIGHT || (emits && emits[snap[idx]])
  const ex = Math.floor(ox), ey = Math.floor(oy), ez = Math.floor(oz)
  const here = light ? light[(ey * side + ez) * side + ex] : null
  const per = new Map()   // dir -> [dark weight, total weight]
  let rays = 0, open = 0
  const ray = (a, b, c) => {
    let dx = ex + a + 0.5 - ox, dy = ey + b + 0.5 - oy, dz = ez + c + 0.5 - oz
    const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L
    rays++
    let x = ex, y = ey, z = ez, prev = (ey * side + ez) * side + ex, dark = here !== null && here < MIN_LIGHT
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1
    const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz)
    let tx = (dx > 0 ? x + 1 - ox : ox - x) * tdx, ty = (dy > 0 ? y + 1 - oy : oy - y) * tdy, tz = (dz > 0 ? z + 1 - oz : oz - z) * tdz
    for (;;) {
      let t
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx } else if (ty < tz) { y += sy; t = ty; ty += tdy } else { z += sz; t = tz; tz += tdz }
      if (t > R) { open++; break }
      const idx = (y * side + z) * side + x
      if (opaque[snap[idx]]) { if (lit(idx, prev)) seen[idx] = 1; break }
      if (lit(idx, idx)) seen[idx] = 1
      if (t <= NEAR && light && light[idx] < MIN_LIGHT) dark = true
      prev = idx
    }
    if (here === null) return
    const d = Math.abs(dy) > Math.hypot(dx, dz) ? (dy > 0 ? 'up' : 'down')
      : COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]
    const w = 1 / (L * L * L)
    const e = per.get(d) || per.set(d, [0, 0]).get(d)
    e[1] += w
    if (dark) e[0] += w
  }
  for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
    if (Math.abs(a) === R || Math.abs(b) === R) for (let c = -R; c <= R; c++) ray(a, b, c)
    else { ray(a, b, -R); ray(a, b, R) }
  }
  let near = null
  if (here !== null) {
    let darkW = 0, allW = 0
    for (const [n, total] of per.values()) { darkW += n; allW += total }
    near = { here, share: darkW / allW,
      dirs: [...per].map(([d, [n, total]]) => [d, n / total]).sort((a, b) => b[1] - a[1]) }
  }
  return { seen, rays, open, near }
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

// → { eye, radius, blocks: [{ id, name, x, y, z, biome }] (no air), dark (castRays' near, null
//   outside the overworld), rays, open (rays that reached R unblocked), ms: { snapshot, rays, blocks } }
function lookAround(bot, R = 64) {
  const now = () => performance.now()
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const dark = /overworld/.test(bot.game?.dimension || '')
  const darken = dark ? skyDarken(bot.time?.timeOfDay ?? 6000, bot.rainState || 0, bot.thunderState || 0) : null
  let t = now()
  const cube = snapshot(bot, eye, R, darken)
  const tSnap = now() - t
  t = now()
  const { seen, rays, open, near: darkness } = castRays(cube, opaqueTable(bot.registry), R, dark ? emitTable(bot.registry) : null)
  const tRays = now() - t
  t = now()
  const blocks = seenBlocks(bot, cube, seen)
  const tBlocks = now() - t
  return { eye, radius: R, blocks, dark: darkness, rays, open, ms: { snapshot: tSnap, rays: tRays, blocks: tBlocks } }
}

module.exports = { lookAround, snapshot, castRays, seenBlocks, opaqueTable, emitTable, skyDarken, MIN_LIGHT, NEAR, AIR }
