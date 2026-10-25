#!/usr/bin/env node
// Finds a spot for a cave test box: 5x5-chunk windows of an existing world, ranked by the cave
// system build.js would copy out of them.
//
// Reads the region files directly. In each window it takes the slice build.js would (median
// surface section, --below sections under it, up to the tallest block plus headroom). A cave
// cell is an open, dry cell with natural terrain somewhere above it in its column. The 6-connected
// groups of cave cells that touch open sky (a mouth) are the window's caves. The biggest of them
// is reported with: its size, its mouth cells, its y range, the ores that touch it, and the
// water/lava cells that touch it (a wet cave is no good for a walking test).
//
// Usage (from bot/):
//   node tools/testworld/findcave.js [--src ../server/world] [--below 4] [--spread 2] X,Z [X,Z ...]
// Each X,Z is a block position; windows centred on its chunk and on chunks up to --spread
// away are tried. Then build the best one with
//   node tools/testworld/build.js --name cave --center X,Z --below N

const path = require('path')
const mcData = require('minecraft-data')('26.3')
const { readChunk } = require('./anvil')
const { roleOf } = require('../../src/config/natural-blocks')

const MIN_Y = -64
const SIZE = 5
const HEADROOM = 16
const OVERWORLD = 'dimensions/minecraft/overworld'
const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function parseArgs () {
  const a = { src: path.resolve(__dirname, '../../../server/world'), below: 4, spread: 2, at: [] }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = path.resolve(argv[++i])
    else if (argv[i] === '--below') a.below = Number(argv[++i])
    else if (argv[i] === '--spread') a.spread = Number(argv[++i])
    else if (/^-?\d+,-?\d+$/.test(argv[i])) a.at.push(argv[i].split(',').map(Number))
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!a.at.length) throw new Error('give at least one X,Z')
  return a
}

// Block kinds by name: 1 open (walkable-through, dry), 2 cover (natural terrain or ore),
// 3 water, 4 lava, 0 anything else (solid, not natural).
const KIND = new Map()
for (const b of mcData.blocksArray) {
  let k = 0
  if (/^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(b.name)) k = 3
  else if (b.name === 'lava') k = 4
  else if (b.boundingBox === 'empty') k = 1
  else if (!/^(ice|packed_ice|blue_ice|snow_block|powder_snow)$/.test(b.name) &&
    (['terrain', 'resource'].includes(roleOf(b.name, 'overworld', '')) || ['terrain', 'resource'].includes(roleOf(b.name, 'overworld', 'badlands')))) k = 2
  KIND.set(b.name, k)
}
const isOre = name => name.endsWith('_ore') || name === 'ancient_debris'

// A section's 4096 block names (index (y * 16 + z) * 16 + x) from a 26.x block_states compound.
function sectionNames (sec) {
  const states = sec.block_states.value
  const pal = states.palette.value
  const names = pal.type === 'compound' ? pal.value.map(e => (e.id || e['']).value) : pal.value
  const short = names.map(n => n.replace(/^minecraft:/, ''))
  if (short.length === 1 || !states.data) return { uniform: short[0] }
  const bits = Math.max(4, Math.ceil(Math.log2(short.length)))
  const per = Math.floor(64 / bits)
  const mask = (1n << BigInt(bits)) - 1n
  const out = new Array(4096)
  let i = 0
  for (const [hi, lo] of states.data.value) {
    let v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)
    for (let k = 0; k < per && i < 4096; k++, i++) { out[i] = short[Number(v & mask)]; v >>= BigInt(bits) }
  }
  return { names: out }
}

function heightmap (tree, type) {
  const out = []
  for (const [hi, lo] of tree.value.Heightmaps.value[type].value) {
    let v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)
    for (let k = 0; k < 7 && out.length < 256; k++) { out.push(Number(v & 0x1ffn) + MIN_Y); v >>= 9n }
  }
  return out
}

// Heightmaps from the blocks, for chunks saved without them (build.js's output): the first y
// above the highest solid block, without leaves and with.
const SOLID = new Set(mcData.blocksArray.filter(b => b.boundingBox === 'block' && b.name !== 'barrier').map(b => b.name))
function scanHeights (secs) {
  const surface = new Array(256).fill(MIN_Y)
  const top = new Array(256).fill(MIN_Y)
  const ys = [...secs.keys()].sort((a, b) => b - a)
  for (let i = 0; i < 256; i++) {
    let leafless = null
    let any = null
    for (const sy of ys) {
      const s = secs.get(sy)
      for (let y = 15; y >= 0 && leafless === null; y--) {
        const n = s.uniform || s.names[(y * 16 + (i >> 4)) * 16 + (i & 15)]
        if (!SOLID.has(n)) continue
        if (any === null) any = sy * 16 + y + 1
        if (!n.endsWith('_leaves')) leafless = sy * 16 + y + 1
      }
      if (leafless !== null) break
    }
    surface[i] = leafless ?? MIN_Y
    top[i] = any ?? MIN_Y
  }
  return { surface, top }
}

const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]

const cache = new Map()
async function loadChunk (src, cx, cz) {
  const k = `${cx},${cz}`
  if (cache.has(k)) return cache.get(k)
  const tree = await readChunk(path.join(src, OVERWORLD, 'region'), cx, cz)
  let c = null
  if (tree && tree.value.Status.value === 'minecraft:full') {
    const secs = new Map()
    for (const sec of tree.value.sections.value.value) if (sec.block_states) secs.set(sec.Y.value, sectionNames(sec))
    c = tree.value.Heightmaps
      ? { secs, surface: heightmap(tree, 'MOTION_BLOCKING_NO_LEAVES'), top: heightmap(tree, 'MOTION_BLOCKING') }
      : { secs, ...scanHeights(secs) }
  }
  cache.set(k, c)
  return c
}

async function evalWindow (src, ccx, ccz, below) {
  const cols = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const c = await loadChunk(src, ccx + dx, ccz + dz)
      if (!c) return null
      cols.push({ dx: dx + 2, dz: dz + 2, c })
    }
  }
  const surfaceY = median(cols.flatMap(e => e.c.surface)) - 1
  const syMid = Math.floor(surfaceY / 16)
  const syLo = syMid - below
  const topY = Math.max(...cols.flatMap(e => e.c.top)) - 1
  const syHi = Math.max(syMid + 2, Math.ceil((topY + HEADROOM + 1) / 16) - 1)
  const W = SIZE * 16
  const Y0 = syLo * 16
  const H = (syHi - syLo + 1) * 16
  const kind = new Uint8Array(W * W * H)
  const name = new Array(W * W * H)
  const idx = (x, y, z) => (y * W + z) * W + x
  for (const { dx, dz, c } of cols) {
    for (let sy = syLo; sy <= syHi; sy++) {
      const s = c.secs.get(sy) || { uniform: 'air' }
      for (let i = 0; i < 4096; i++) {
        const n = s.uniform || s.names[i]
        const j = idx(dx * 16 + (i & 15), (sy - syLo) * 16 + (i >> 8), dz * 16 + ((i >> 4) & 15))
        kind[j] = KIND.get(n) ?? 0
        name[j] = n
      }
    }
  }
  // highest cover block per column
  const top = new Int16Array(W * W).fill(-1)
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      for (let y = H - 1; y >= 0; y--) if (kind[idx(x, y, z)] === 2) { top[z * W + x] = y; break }
    }
  }
  const covered = (x, y, z) => y < top[z * W + x]
  const comp = new Int32Array(W * W * H).fill(-1)
  let best = null
  for (let y0 = 0; y0 < H; y0++) {
    for (let z0 = 0; z0 < W; z0++) {
      for (let x0 = 0; x0 < W; x0++) {
        const i0 = idx(x0, y0, z0)
        if (comp[i0] !== -1 || kind[i0] !== 1 || !covered(x0, y0, z0)) continue
        const id = i0
        const stack = [i0]
        comp[i0] = id
        let size = 0; let mouth = 0; let ymin = 1e9; let ymax = -1e9; let wet = 0; let lava = 0; let edge = 0
        const ores = {}
        const orePos = []
        const touched = new Set()
        let mouthAt = null
        while (stack.length) {
          const i = stack.pop()
          size++
          const x = i % W; const z = Math.floor(i / W) % W; const y = Math.floor(i / (W * W))
          ymin = Math.min(ymin, y); ymax = Math.max(ymax, y)
          if (x === 0 || z === 0 || x === W - 1 || z === W - 1) edge++
          let isMouth = false
          for (const [a, b, c] of NB) {
            const p = x + a; const q = y + b; const r = z + c
            if (p < 0 || r < 0 || p >= W || r >= W || q < 0 || q >= H) continue
            const j = idx(p, q, r)
            const k = kind[j]
            if (k === 1) {
              if (!covered(p, q, r)) isMouth = true
              else if (comp[j] === -1) { comp[j] = id; stack.push(j) }
            } else if (!touched.has(j)) {
              touched.add(j)
              if (k === 3) wet++
              else if (k === 4) lava++
              else if (isOre(name[j])) { ores[name[j]] = (ores[name[j]] || 0) + 1; orePos.push(j) }
            }
          }
          if (isMouth) { mouth++; if (!mouthAt) mouthAt = [x, y, z] }
        }
        if (mouth && (!best || size > best.size)) best = { id, size, mouth, mouthAt, ymin, ymax, wet, lava, edge, ores, orePos }
      }
    }
  }
  if (!best) return null
  const walk = walkIn(kind, comp, best, W, H, covered)
  const X0 = (ccx - 2) * 16; const Z0 = (ccz - 2) * 16
  return {
    center: [ccx * 16 + 8, ccz * 16 + 8],
    surfaceY,
    slice: [Y0, Y0 + H - 1],
    ...best,
    ymin: Y0 + best.ymin,
    ymax: Y0 + best.ymax,
    mouthAt: [X0 + best.mouthAt[0], Y0 + best.mouthAt[1], Z0 + best.mouthAt[2]],
    walk: { ...walk, low: Y0 + walk.low }
  }
}

// How far into the cave the bot gets on foot from the surface, no digging or placing: BFS over
// standing spots (two open cells over a solid one) with steps to the 4 neighbours up 1 or down
// up to 3. Returns the cave cells stood on, the lowest y reached, and the cave's ores within
// reach (4.5 blocks from the eye) of a spot reached.
const REACH = 4.5
function walkIn (kind, comp, cave, W, H, covered) {
  const idx = (x, y, z) => (y * W + z) * W + x
  const open = (x, y, z) => x >= 0 && z >= 0 && x < W && z < W && y >= 0 && y < H && kind[idx(x, y, z)] === 1
  const solid = (x, y, z) => x >= 0 && z >= 0 && x < W && z < W && y >= 0 && y < H && (kind[idx(x, y, z)] === 2 || kind[idx(x, y, z)] === 0)
  const stand = (x, y, z) => open(x, y, z) && open(x, y + 1, z) && solid(x, y - 1, z)
  const seen = new Uint8Array(W * W * H)
  const q = []
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      for (let y = H - 2; y > 0; y--) {
        if (!stand(x, y, z) || covered(x, y, z)) continue
        seen[idx(x, y, z)] = 1; q.push(idx(x, y, z))
      }
    }
  }
  const reached = []
  let low = Infinity
  for (let h = 0; h < q.length; h++) {
    const i = q[h]
    const x = i % W; const z = Math.floor(i / W) % W; const y = Math.floor(i / (W * W))
    if (comp[i] === cave.id) { reached.push(i); low = Math.min(low, y) }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz
      for (let dy = 1; dy >= -3; dy--) {
        const ny = y + dy
        if (dy === 1 && !open(x, y + 2, z)) continue
        if (dy < 0) {
          let clear = true
          for (let yy = ny + 2; yy <= y + 1 && clear; yy++) clear = open(nx, yy, nz)
          if (!clear) break
        }
        if (!stand(nx, ny, nz)) continue
        const j = idx(nx, ny, nz)
        if (!seen[j]) { seen[j] = 1; q.push(j) }
        break
      }
    }
  }
  let oresInReach = 0
  for (const o of cave.orePos) {
    const ox = o % W; const oz = Math.floor(o / W) % W; const oy = Math.floor(o / (W * W))
    if (reached.some(i => Math.hypot(i % W + 0.5 - ox - 0.5, Math.floor(i / (W * W)) + 1.62 - oy - 0.5, Math.floor(i / W) % W + 0.5 - oz - 0.5) <= REACH)) oresInReach++
  }
  return { spots: reached.length, low, oresInReach }
}

async function main () {
  const a = parseArgs()
  const rows = []
  for (const [X, Z] of a.at) {
    for (let dx = -a.spread; dx <= a.spread; dx++) {
      for (let dz = -a.spread; dz <= a.spread; dz++) {
        const r = await evalWindow(a.src, (X >> 4) + dx, (Z >> 4) + dz, a.below)
        if (r) rows.push(r)
      }
    }
    cache.clear()
  }
  const oreCount = r => Object.values(r.ores).reduce((s, n) => s + n, 0)
  rows.sort((p, q) => (q.wet === 0) - (p.wet === 0) || oreCount(q) - oreCount(p))
  for (const r of rows.slice(0, 20)) {
    const ores = Object.entries(r.ores).sort((p, q) => q[1] - p[1]).map(([n, c]) => `${n.replace(/_ore$/, '')}:${c}`).join(' ')
    console.log(`--center ${r.center.join(',')}  cave ${r.size} cells, y ${r.ymin}..${r.ymax} (slice ${r.slice.join('..')}, surface ${r.surfaceY}), mouth ${r.mouth} @${r.mouthAt.join(',')}, wet ${r.wet} lava ${r.lava}, on edge ${r.edge} | ores ${oreCount(r)}: ${ores} | on foot: ${r.walk.spots} spots, down to y ${r.walk.low}, ${r.walk.oresInReach} ores in reach`)
  }
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1) })

module.exports = { sectionNames, heightmap }
