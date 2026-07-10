// chunkScan.js — fast type search over loaded chunk data via palette-skip.
//
// bot.findBlocks walks every position through an octahedron cursor with no palette
// awareness. Here we read the loaded columns directly (bot.world.getColumns(), sync)
// and use each 16³ section's palette to SKIP whole sections (4096 blocks) that can't
// contain the target. For a rare block (e.g. nether_bricks in the overworld) almost
// every section is skipped, so a full view-distance search is cheap. The caller then
// LOS-gates the few hits — discovery here, visibility there (no x-ray: knowledge stays
// line-of-sight gated downstream).
const state = require('./state')
const { normalizeItemName } = require('./utils')

// Map every state id of every block whose name matches `query` (exact, else substring)
// to its block name. O(1) membership + name lookup during the scan.
function resolveTargets(query) {
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)
  const normalized = normalizeItemName(query)
  const idToName = new Map()
  if (!normalized) return idToName
  const exact = mcData.blocksByName[normalized]
  const names = exact ? [normalized] : Object.keys(mcData.blocksByName).filter(n => n.includes(normalized))
  for (const n of names) {
    const b = mcData.blocksByName[n]
    if (b && b.minStateId != null && b.maxStateId != null) {
      for (let id = b.minStateId; id <= b.maxStateId; id++) idToName.set(id, n)
    }
  }
  return idToName
}

// Scan loaded chunks for blocks whose state id is in `idToName`.
// Returns [{x,y,z,name,dist}], nearest-first, capped at `count`.
function findByTypeMap(idToName, { maxDistance = 64, count = 64, origin } = {}) {
  const bot = state.bot
  if (!bot?.world || idToName.size === 0) return []
  const eye = origin || bot.entity.position
  const maxD2 = maxDistance * maxDistance
  const chunkR = Math.ceil(maxDistance / 16) + 1
  const botCX = Math.floor(eye.x / 16), botCZ = Math.floor(eye.z / 16)
  const out = []

  for (const { chunkX, chunkZ, column } of bot.world.getColumns()) {
    const cx = Number(chunkX), cz = Number(chunkZ)
    if (Math.abs(cx - botCX) > chunkR || Math.abs(cz - botCZ) > chunkR) continue
    const baseX = cx * 16, baseZ = cz * 16
    const minY = column.minY ?? -64
    const sections = column.sections || []
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s]
      if (!section) continue
      const container = section.data
      if (!container) continue
      // --- section skip via palette / single value ---
      if (container.palette) {                       // IndirectPaletteContainer
        let hit = false
        for (const id of container.palette) { if (idToName.has(id)) { hit = true; break } }
        if (!hit) continue
      } else if (container.value !== undefined) {     // SingleValueContainer (all one block)
        if (!idToName.has(container.value)) continue
      } // else DirectPaletteContainer — no palette, must scan
      // --- scan the 4096 blocks of this section ---
      const baseY = minY + s * 16
      for (let i = 0; i < 4096; i++) {
        const name = idToName.get(container.get(i))
        if (!name) continue
        const lx = i & 15, lz = (i >> 4) & 15, ly = (i >> 8) & 15
        const wx = baseX + lx, wy = baseY + ly, wz = baseZ + lz
        const dx = wx + 0.5 - eye.x, dy = wy + 0.5 - eye.y, dz = wz + 0.5 - eye.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > maxD2) continue
        out.push({ x: wx, y: wy, z: wz, name, dist: Math.sqrt(d2) })
      }
    }
  }
  out.sort((a, b) => a.dist - b.dist)
  return out.length > count ? out.slice(0, count) : out
}

function findByType(query, opts) {
  return findByTypeMap(resolveTargets(query), opts)
}

const AIR = new Set(['air', 'cave_air', 'void_air'])
const _opaqueCache = new Map()

// State ids of blocks that fully occlude sight (solid full cubes). Used as the
// "is this face buried?" test: a face whose neighbor is opaque can never be seen.
// Approximation: mcData marks slabs/stairs boundingBox:'block', so partial blocks
// over-count as opaque (a neighbor behind a slab may read buried). Harmless for
// awareness — LOS still confirms the partial block itself.
function getOpaqueSet(mcData) {
  const key = mcData.version?.minecraftVersion || 'x'
  if (_opaqueCache.has(key)) return _opaqueCache.get(key)
  const set = new Set()
  for (const b of mcData.blocksArray) {
    if (b.boundingBox === 'block' && !b.transparent && b.minStateId != null) {
      for (let id = b.minStateId; id <= b.maxStateId; id++) set.add(id)
    }
  }
  _opaqueCache.set(key, set)
  return set
}

// Exposure-aware candidate scan over loaded chunks. Returns [{x,y,z,name,dist}]
// for blocks that are: (1) within maxDistance, (2) inside the FOV cone (cosHalf>-1;
// -1 = omni), and (3) face-exposed — at least one EYE-FACING neighbor is non-opaque,
// so the block could be visible. Buried blocks (all eye-facing neighbors opaque) are
// dropped before the costly LOS raycast. Discovery only — the caller still LOS-gates.
//
// Cone culling is two-stage and conservative: whole 16³ sections are rejected only
// when their BOUNDING SPHERE (center C, radius R=8√3) lies entirely outside the cone
// (so a cone that pierces a section's middle, or the self/near chunk where the eye is
// inside the sphere, is always kept), then survivors are cone-tested per block.
// Two return shapes:
//   - default (flat): [{x,y,z,name,dist}] nearest-first, sliced to `count`. Used by look.
//   - groupNearest=K: Map name -> { total, nearest:[≤K {x,y,z,name,dist} asc by dist] }.
//     Per-type aggregation so a dense type (water) keeps only its nearest K instead of
//     thousands, and a rare distant type (sugar_cane) is never crowded out by a global
//     cap. `count` is ignored in this mode (range is bounded by maxDistance, not a cap).
// opts: { origin, look, cosHalf=-1, maxDistance=64, count=2000, idToName=null, groupNearest=0 }
function scanCandidates({ origin, look, cosHalf = -1, maxDistance = 64, count = 2000, idToName = null, groupNearest = 0 } = {}) {
  const bot = state.bot
  if (!bot?.world || !bot.entity) return []
  const mcData = require('minecraft-data')(bot.version)
  const opaque = getOpaqueSet(mcData)
  const byState = mcData.blocksByStateId
  const eye = origin || bot.entity.position
  const maxD = maxDistance, maxD2 = maxD * maxD
  const useCone = cosHalf > -1
  const halfAngle = useCone ? Math.acos(Math.max(-1, Math.min(1, cosHalf))) : Math.PI
  const lx0 = useCone ? look.x : 0, ly0 = useCone ? look.y : 0, lz0 = useCone ? look.z : 0
  const chunkR = Math.ceil(maxD / 16) + 1
  const botCX = Math.floor(eye.x / 16), botCZ = Math.floor(eye.z / 16)
  const R = 8 * Math.sqrt(3)

  // index loaded columns within range for O(1) cross-section neighbor lookups
  const colMap = new Map()
  for (const { chunkX, chunkZ, column } of bot.world.getColumns()) {
    const cx = Number(chunkX), cz = Number(chunkZ)
    if (Math.abs(cx - botCX) > chunkR || Math.abs(cz - botCZ) > chunkR) continue
    colMap.set(cx + ',' + cz, column)
  }

  function stateIdAt(wx, wy, wz) {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16)
    const col = colMap.get(cx + ',' + cz)
    if (!col) return null
    const minY = col.minY ?? -64
    const sIdx = Math.floor((wy - minY) / 16)
    const sections = col.sections || []
    if (sIdx < 0 || sIdx >= sections.length) return null
    const sec = sections[sIdx]
    if (!sec || !sec.data) return null
    const llx = ((wx % 16) + 16) % 16, llz = ((wz % 16) + 16) % 16
    const lly = wy - (minY + sIdx * 16)
    return sec.data.get((lly << 8) | (llz << 4) | llx)
  }

  const out = []
  const groups = groupNearest > 0 ? new Map() : null
  // keep arr sorted ascending by dist, length ≤ K
  const insertNearest = (arr, item, K) => {
    if (arr.length >= K && item.dist >= arr[arr.length - 1].dist) return
    let i = arr.length - 1
    while (i >= 0 && arr[i].dist > item.dist) i--
    arr.splice(i + 1, 0, item)
    if (arr.length > K) arr.pop()
  }
  for (const [key, column] of colMap) {
    const [cx, cz] = key.split(',').map(Number)
    const baseX = cx * 16, baseZ = cz * 16
    const minY = column.minY ?? -64
    const sections = column.sections || []
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s]
      if (!section) continue
      const container = section.data
      if (!container) continue
      const baseY = minY + s * 16

      // --- section bounding-sphere cull (distance, then cone) ---
      const ddx = baseX + 8 - eye.x, ddy = baseY + 8 - eye.y, ddz = baseZ + 8 - eye.z
      const dC = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
      if (dC - R > maxD) continue
      if (useCone && dC > R) {
        const dot = (ddx * lx0 + ddy * ly0 + ddz * lz0) / dC
        const phi = Math.acos(Math.max(-1, Math.min(1, dot)))
        if (phi - Math.asin(Math.min(1, R / dC)) > halfAngle) continue
      }

      // --- section content skip: by type (palette) or all-air ---
      if (idToName) {
        if (container.palette) {
          let hit = false
          for (const id of container.palette) { if (idToName.has(id)) { hit = true; break } }
          if (!hit) continue
        } else if (container.value !== undefined) {
          if (!idToName.has(container.value)) continue
        }
      } else if (container.value !== undefined) {
        const nm = byState[container.value]?.name
        if (!nm || AIR.has(nm)) continue
      }

      // --- read the section once, then test each cell ---
      const arr = new Int32Array(4096)
      for (let i = 0; i < 4096; i++) arr[i] = container.get(i)
      for (let i = 0; i < 4096; i++) {
        const id = arr[i]
        let name
        if (idToName) { name = idToName.get(id); if (!name) continue }
        else { name = byState[id]?.name; if (!name || AIR.has(name)) continue }
        const llx = i & 15, llz = (i >> 4) & 15, lly = (i >> 8) & 15
        const wx = baseX + llx, wy = baseY + lly, wz = baseZ + llz
        const dx = wx + 0.5 - eye.x, dy = wy + 0.5 - eye.y, dz = wz + 0.5 - eye.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > maxD2) continue
        const dist = Math.sqrt(d2)
        if (useCone && (dx * lx0 + dy * ly0 + dz * lz0) / dist < cosHalf) continue

        // exposure: at least one eye-facing neighbor is non-opaque
        const fx = eye.x > wx + 1 ? 1 : eye.x < wx ? -1 : 0
        const fy = eye.y > wy + 1 ? 1 : eye.y < wy ? -1 : 0
        const fz = eye.z > wz + 1 ? 1 : eye.z < wz ? -1 : 0
        let exposed = !(fx || fy || fz) // eye inside the block's cell → exposed
        const nbr = (nlx, nly, nlz, nwx, nwy, nwz) => {
          const nid = (nlx >= 0 && nlx < 16 && nly >= 0 && nly < 16 && nlz >= 0 && nlz < 16)
            ? arr[(nly << 8) | (nlz << 4) | nlx]
            : stateIdAt(nwx, nwy, nwz)
          return nid === null || !opaque.has(nid)
        }
        if (!exposed && fx) exposed = nbr(llx + fx, lly, llz, wx + fx, wy, wz)
        if (!exposed && fy) exposed = nbr(llx, lly + fy, llz, wx, wy + fy, wz)
        if (!exposed && fz) exposed = nbr(llx, lly, llz + fz, wx, wy, wz + fz)
        if (!exposed) continue

        if (groups) {
          let g = groups.get(name)
          if (!g) groups.set(name, g = { total: 0, nearest: [] })
          g.total++
          insertNearest(g.nearest, { x: wx, y: wy, z: wz, name, dist }, groupNearest)
        } else {
          out.push({ x: wx, y: wy, z: wz, name, dist })
        }
      }
    }
  }
  if (groups) return groups
  out.sort((a, b) => a.dist - b.dist)
  return out.length > count ? out.slice(0, count) : out
}

module.exports = { findByType, findByTypeMap, resolveTargets, scanCandidates, getOpaqueSet }
