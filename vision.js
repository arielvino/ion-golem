// Raycasting vision system — casts rays from bot's eye to build 3D awareness
const { Vec3 } = require('vec3')
const state = require('./state')
const { TRANSPARENT, NOTABLE_TRANSPARENT, PASSABLE, HAZARDS, RESOURCES } = require('./config/blocks')

// Shared diagonal-passage check for voxel raycasting.
// Returns true if the diagonal step from (px,py,pz) to (bx,by,bz) is blocked.
// For 2D diagonals: checks if both corner blocks are solid.
// For 3D diagonals: checks all 6 faces of the corner cube (2 per axis pair).
function isDiagBlocked(bot, px, py, pz, bx, by, bz, passSet) {
  const dx = bx !== px, dy = by !== py, dz = bz !== pz
  if (dx + dy + dz < 2) return false
  const isSolid = (x, y, z) => {
    try {
      const b = bot.blockAt(new Vec3(x, y, z))
      return b && !passSet.has(b.name)
    } catch (e) { return true }
  }
  // XZ faces
  if (dx && dz) {
    if (isSolid(bx, py, pz) && isSolid(px, py, bz)) return true
    if (dy && isSolid(bx, by, pz) && isSolid(px, by, bz)) return true
  }
  // XY faces
  if (dx && dy) {
    if (isSolid(bx, py, pz) && isSolid(px, by, pz)) return true
    if (dz && isSolid(bx, py, bz) && isSolid(px, by, bz)) return true
  }
  // YZ faces
  if (dy && dz) {
    if (isSolid(px, by, pz) && isSolid(px, py, bz)) return true
    if (dx && isSolid(bx, by, pz) && isSolid(bx, py, bz)) return true
  }
  return false
}

// Voxel-walk the integer cells a ray from→to passes through, skipping the start
// cell and any repeated cell (steps = ceil(dist*2), same density used everywhere).
// Yields [bx, by, bz, lastBx, lastBy, lastBz] per distinct cell strictly between
// the endpoints — lastB* is the previous distinct cell, for diagonal-corner checks.
// Shared by _rayClear (vision) and findBlockingBlock (reachability); _markSightline
// is deliberately NOT routed through this — it uses a different distance threshold
// and processes the first cell (lastKey=null), which would change its DB writes.
function* voxelCells(from, to, minDist = 1) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist < minDist) return
  const steps = Math.ceil(dist * 2)
  const sx = dx / steps, sy = dy / steps, sz = dz / steps
  let lastBx = Math.floor(from.x), lastBy = Math.floor(from.y), lastBz = Math.floor(from.z)
  for (let i = 1; i < steps; i++) {
    const bx = Math.floor(from.x + sx * i)
    const by = Math.floor(from.y + sy * i)
    const bz = Math.floor(from.z + sz * i)
    if (bx === lastBx && by === lastBy && bz === lastBz) continue
    yield [bx, by, bz, lastBx, lastBy, lastBz]
    lastBx = bx; lastBy = by; lastBz = bz
  }
}

function describeDir(dir) {
  const parts = []
  if (dir.y > 0.3) parts.push('up')
  else if (dir.y < -0.3) parts.push('down')
  if (dir.z < -0.3) parts.push('N')
  else if (dir.z > 0.3) parts.push('S')
  if (dir.x < -0.3) parts.push('W')
  else if (dir.x > 0.3) parts.push('E')
  return parts.join('-') || 'level'
}

// Detect sharp distance jumps between adjacent rays within each pitch band.
// Returns array of { dir, depth, wallDist, known } for corridor/gap openings.
function detectGaps(hitDists, dirs, bands, maxDist, eyePos) {
  const MIN_DEPTH = 6
  const MAX_SHORT = 6
  const MIN_RATIO = 3.0
  const ENCLOSED_THRESHOLD = 0.5

  // Skip if on surface: count rays hitting within 8 blocks
  let shortCount = 0
  for (let i = 0; i < hitDists.length; i++) {
    if (hitDists[i] <= 8) shortCount++
  }
  if (shortCount < hitDists.length * ENCLOSED_THRESHOLD) return []

  const rawGaps = []
  for (const band of bands) {
    if (band.count < 4) continue
    for (let i = 0; i < band.count; i++) {
      const ci = band.startIdx + i
      const ni = band.startIdx + ((i + 1) % band.count)
      const dC = hitDists[ci], dN = hitDists[ni]
      // Check both orderings: short→long and long→short
      let shortIdx, longIdx, shortDist, longDist
      if (dC <= MAX_SHORT && dN >= MIN_DEPTH && dN >= dC * MIN_RATIO) {
        shortIdx = ci; longIdx = ni; shortDist = dC; longDist = dN
      } else if (dN <= MAX_SHORT && dC >= MIN_DEPTH && dC >= dN * MIN_RATIO) {
        shortIdx = ni; longIdx = ci; shortDist = dN; longDist = dC
      } else {
        continue
      }
      rawGaps.push({ dir: dirs[longIdx], depth: longDist, wallDist: shortDist })
    }
  }

  if (rawGaps.length === 0) return []

  // Deduplicate: sort by depth desc, merge gaps within ~30° (dot product > 0.85)
  rawGaps.sort((a, b) => b.depth - a.depth)
  const gaps = []
  for (const g of rawGaps) {
    let dominated = false
    for (const kept of gaps) {
      const dot = g.dir.x * kept.dir.x + g.dir.y * kept.dir.y + g.dir.z * kept.dir.z
      if (dot > 0.85) { dominated = true; break }
    }
    if (!dominated) gaps.push(g)
    if (gaps.length >= 6) break
  }

  // DB validation: check if gap areas have been explored
  for (const g of gaps) {
    if (!state.stmts?.getBlockAt) { g.known = false; continue }
    let hasData = false
    for (const frac of [0.33, 0.66, 1.0]) {
      const sx = Math.floor(eyePos.x + g.dir.x * g.depth * frac)
      const sy = Math.floor(eyePos.y + g.dir.y * g.depth * frac)
      const sz = Math.floor(eyePos.z + g.dir.z * g.depth * frac)
      const row = state.stmts.getBlockAt.get(sx, sy, sz)
      if (row) { hasData = true; break }
    }
    g.known = hasData
  }

  return gaps
}

// mode: 'see' = rays pass through all transparent blocks
//        'reach' = rays only pass through blocks the bot can walk through
// yawCenter: null = full sphere, or radians (0=south, PI/2=west, PI=north, -PI/2=east)
// yawSpread: half-angle of the cone in radians (default PI = full sphere, PI/4 = 45° cone)
function castVisionRays(resolution = 16, maxDist = 256, mode = 'see', yawCenter = null, yawSpread = Math.PI) {
  const bot = state.bot
  if (!bot?.entity) return null
  const eyePos = bot.entity.position.offset(0, 1.62, 0)
  const results = {
    openDirs: [],
    resources: {},
    hazards: {},
    seenBlocks: {},
    skyVisible: false,
    waterNearby: [],
    groundBelow: 0,
    ceilingAbove: 0,
    nearBlocks: {},
    allBlocks: [],
    visibleStructures: new Set(),
    gaps: [],
  }

  const angStep = 1.0 / resolution
  const nHoriz = Math.min(Math.max(Math.ceil(2 * Math.PI / angStep), 16), 256)
  const nVert = Math.min(Math.max(Math.ceil(Math.PI / angStep), 8), 128)

  const dirs = []
  const bands = []  // { startIdx, count } per pitch band
  for (let vi = 0; vi <= nVert; vi++) {
    const startIdx = dirs.length
    const pitch = -Math.PI / 2 + (Math.PI * vi) / nVert
    const cosPitch = Math.cos(pitch)
    const sinPitch = Math.sin(pitch)
    const ringSize = Math.max(1, Math.round(nHoriz * cosPitch))
    for (let hi = 0; hi < ringSize; hi++) {
      const yaw = (2 * Math.PI * hi) / ringSize
      // Filter by yaw cone if specified
      if (yawCenter !== null) {
        let diff = Math.abs(((yaw - yawCenter + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
        if (diff > yawSpread) continue
      }
      dirs.push({
        x: cosPitch * Math.cos(yaw),
        y: sinPitch,
        z: cosPitch * Math.sin(yaw),
      })
    }
    bands.push({ startIdx, count: dirs.length - startIdx })
  }
  const hitDists = new Uint16Array(dirs.length)  // hit distance per ray

  const seen = new Set()
  const solid = new Set()
  const passThrough = mode === 'reach' ? PASSABLE : TRANSPARENT
  const reachMap = new Map() // key -> 'yes' | null (null = needs resolution)

  for (let ri = 0; ri < dirs.length; ri++) {
    const dir = dirs[ri]
    let airCount = 0
    let passageBlocked = false
    let hadBarrier = false
    let prevBx = Math.floor(eyePos.x), prevBy = Math.floor(eyePos.y), prevBz = Math.floor(eyePos.z)
    let hitStep = maxDist
    for (let step = 1; step <= maxDist; step++) {
      hitStep = step
      const x = eyePos.x + dir.x * step
      const y = eyePos.y + dir.y * step
      const z = eyePos.z + dir.z * step
      const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z)

      if (!passageBlocked) {
        if (isDiagBlocked(bot, prevBx, prevBy, prevBz, bx, by, bz, passThrough))
          passageBlocked = true
      }
      prevBx = bx; prevBy = by; prevBz = bz

      const key = `${bx},${by},${bz}`
      if (seen.has(key)) {
        if (solid.has(key) || passageBlocked) break
        airCount++
        continue
      }

      let block
      try { block = bot.blockAt(new Vec3(bx, by, bz)) } catch(e) { break }
      if (!block) break
      seen.add(key)

      const name = block.name
      if (passThrough.has(name)) {
        if (passageBlocked) break
        airCount++
        // Record passable blocks near bot for DB pathfinding corridor data
        if (step <= 5) {
          results.allBlocks.push({ x: bx, y: by, z: bz, name })
        }
        if (NOTABLE_TRANSPARENT.has(name)) {
          if (!results.seenBlocks[name]) results.seenBlocks[name] = []
          if (results.seenBlocks[name].length < 10) {
            results.seenBlocks[name].push({ x: bx, y: by, z: bz, dist: step })
          }
          const reach = hadBarrier ? null : 'yes'
          const prev = reachMap.get(key)
          if (prev !== 'yes') reachMap.set(key, reach)
          if (step > 5) results.allBlocks.push({ x: bx, y: by, z: bz, name })
        }
        continue
      }

      if (mode === 'see' && TRANSPARENT.has(name)) {
        if (passageBlocked) break
        // Transparent but not passable = barrier (glass, water, leaves, iron bars, etc.)
        if (!PASSABLE.has(name)) hadBarrier = true
        if (NOTABLE_TRANSPARENT.has(name)) {
          if (!results.seenBlocks[name]) results.seenBlocks[name] = []
          if (results.seenBlocks[name].length < 10) {
            results.seenBlocks[name].push({ x: bx, y: by, z: bz, dist: step })
          }
          const reach = hadBarrier ? null : 'yes'
          const prev = reachMap.get(key)
          if (prev !== 'yes') reachMap.set(key, reach)
          results.allBlocks.push({ x: bx, y: by, z: bz, name })
        }
        continue
      }

      if (passageBlocked) { solid.add(key); break }

      solid.add(key)
      if (step <= 2) {
        results.nearBlocks[name] = (results.nearBlocks[name] || 0) + 1
      }

      // Track reachability for solid blocks at ray terminus
      const reach = hadBarrier ? null : 'yes'
      const prev = reachMap.get(key)
      if (prev !== 'yes') reachMap.set(key, reach)

      if (state.stmts.isPlaced && state.stmts.isPlaced.get(bx, by, bz)) {
        try {
          const structRow = state.stmts.blockStructure && state.stmts.blockStructure.get(bx, by, bz)
          if (structRow) results.visibleStructures.add(structRow.name)
        } catch(e) { console.warn('  [VISION] structure lookup err:', e.message) }
      }
      results.allBlocks.push({ x: bx, y: by, z: bz, name })
      if (!results.seenBlocks[name]) results.seenBlocks[name] = []
      if (results.seenBlocks[name].length < 10) {
        results.seenBlocks[name].push({ x: bx, y: by, z: bz, dist: step })
      }
      if (RESOURCES.has(name)) {
        if (!results.resources[name]) results.resources[name] = []
        if (results.resources[name].length < 3) {
          results.resources[name].push({ x: bx, y: by, z: bz, dist: step })
        }
      }
      if (HAZARDS.has(name)) {
        if (!results.hazards[name]) results.hazards[name] = []
        if (results.hazards[name].length < 3) {
          results.hazards[name].push({ x: bx, y: by, z: bz, dist: step })
        }
      }
      break
    }
    hitDists[ri] = hitStep
    const openThreshold = maxDist <= 16 ? 3 : 8
    if (airCount >= openThreshold) {
      const label = describeDir(dir)
      results.openDirs.push({ label, dist: airCount, dir })
    }
  }

  results.gaps = detectGaps(hitDists, dirs, bands, maxDist, eyePos)

  // Vertical checks: sky and ground
  let skyDist = 0
  for (let dy = 1; dy <= 64; dy++) {
    const b = bot.blockAt(eyePos.offset(0, dy, 0))
    if (!b) { results.skyVisible = true; break }
    if (TRANSPARENT.has(b.name)) { skyDist = dy; continue }
    results.ceilingAbove = dy
    break
  }
  if (skyDist > 60) results.skyVisible = true

  for (let dy = 1; dy <= 32; dy++) {
    const b = bot.blockAt(eyePos.offset(0, -dy, 0))
    if (!b) break
    if (!TRANSPARENT.has(b.name)) { results.groundBelow = dy; break }
  }

  // Apply reachability to allBlocks entries
  for (const b of results.allBlocks) {
    const key = `${b.x},${b.y},${b.z}`
    const r = reachMap.get(key)
    if (r === 'yes') b.reachable = 'yes'
    else if (r === null) b.reachable = null // needs resolution
    // else: not in reachMap, leave undefined (will default to 'unknown' in DB)
  }

  // Resolve reachability for blocks that need it
  resolveReachability(results.allBlocks)

  _lastVisionResult = results
  return results
}

function resolveReachability(blocks) {
  if (!state.stmts?.getBlockAt) return
  const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
  for (const b of blocks) {
    if (b.reachable !== null || b.reachable === 'yes') continue
    // b.reachable is null — needs resolution via 6-neighbor lookup
    let anyPassable = false, anyMissing = false, anyWater = false
    for (const [dx, dy, dz] of offsets) {
      const row = state.stmts.getBlockAt.get(b.x + dx, b.y + dy, b.z + dz)
      if (!row) { anyMissing = true; continue }
      if (PASSABLE.has(row.name)) { anyPassable = true; break }
      if (row.name === 'water') anyWater = true
    }
    if (anyPassable) b.reachable = 'yes'
    else if (anyMissing) b.reachable = 'unknown'
    else if (anyWater) b.reachable = 'drowned'
    else b.reachable = 'no'
  }
}

let _lastVisionResult = null

function getLastVisionResult() {
  return _lastVisionResult
}

const _shorten = (n) => n
  .replace('deepslate_', 'deep_')
  .replace('_leaves', '_leaf')
  .replace('_planks', '_plk')

// opts.survey: a surveyVisible() result. When present, see= is built from the
// find+LOS survey (complete recall) instead of the ray-sampled v.seenBlocks.
function formatVision(v, opts = {}) {
  const survey = opts.survey
  if (!v && !survey) return ''
  const parts = []

  if (survey && survey.blocks && Object.keys(survey.blocks).length > 0) {
    const entries = Object.entries(survey.blocks)
    entries.sort((a, b) => {
      const aHaz = HAZARDS.has(a[0]) ? 0 : 1
      const bHaz = HAZARDS.has(b[0]) ? 0 : 1
      if (aHaz !== bHaz) return aHaz - bHaz
      const aOre = RESOURCES.has(a[0]) ? 0 : 1
      const bOre = RESOURCES.has(b[0]) ? 0 : 1
      if (aOre !== bOre) return aOre - bOre
      return b[1].count - a[1].count
    })
    const blockStrs = entries.slice(0, 20).map(([name, r]) => {
      const at = r.nearest
      return r.count > 1
        ? `${_shorten(name)}x${r.count}@${at.x},${at.y},${at.z}`
        : `${_shorten(name)}@${at.x},${at.y},${at.z}`
    })
    if (blockStrs.length) parts.push(`see=[${blockStrs.join(',')}]`)
  } else if (v && v.seenBlocks && Object.keys(v.seenBlocks).length > 0) {
    const entries = Object.entries(v.seenBlocks)
    entries.sort((a, b) => {
      const aHaz = HAZARDS.has(a[0]) ? 0 : 1
      const bHaz = HAZARDS.has(b[0]) ? 0 : 1
      if (aHaz !== bHaz) return aHaz - bHaz
      const aOre = RESOURCES.has(a[0]) ? 0 : 1
      const bOre = RESOURCES.has(b[0]) ? 0 : 1
      if (aOre !== bOre) return aOre - bOre
      return b[1].length - a[1].length
    })
    const blockStrs = []
    for (const [name, positions] of entries.slice(0, 20)) {
      const closest = positions[0]
      const shortName = _shorten(name)
      if (positions.length === 1) {
        blockStrs.push(`${shortName}@${closest.x},${closest.y},${closest.z}`)
      } else {
        blockStrs.push(`${shortName}x${positions.length}@${closest.x},${closest.y},${closest.z}`)
      }
    }
    parts.push(`see=[${blockStrs.join(',')}]`)
  }

  // Affordances (open passages, gaps, near blocks, sky/ceiling, structures) still
  // come from the ray sweep — guard for a null ray result at startup.
  if (!v) return parts.length > 0 ? ` VISION=[${parts.join(' | ')}]` : ''

  if (v.openDirs.length > 0) {
    const byLabel = {}
    for (const o of v.openDirs) {
      if (!byLabel[o.label] || o.dist > byLabel[o.label]) byLabel[o.label] = o.dist
    }
    const passages = Object.entries(byLabel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, dist]) => `${label}:${dist}m`)
    parts.push(`open=${passages.join(',')}`)
  }

  if (v.gaps && v.gaps.length > 0) {
    const gapStrs = v.gaps.slice(0, 4).map(g => {
      const tag = g.known ? '' : '?'
      return `${describeDir(g.dir)}:${g.depth}m(wall@${g.wallDist}m)${tag}`
    })
    parts.push(`gaps=${gapStrs.join(',')}`)
  }

  if (v.nearBlocks && Object.keys(v.nearBlocks).length > 0) {
    const near = Object.entries(v.nearBlocks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}x${count}`)
    parts.push(`near=${near.join(',')}`)
  }

  if (v.skyVisible) parts.push('sky=visible')
  else if (v.ceilingAbove > 0) parts.push(`ceiling=${v.ceilingAbove}m`)
  if (v.groundBelow > 2) parts.push(`drop=${v.groundBelow}m`)

  if (v.visibleStructures && v.visibleStructures.size > 0) {
    parts.push(`see_builds=[${[...v.visibleStructures].map(n => `"${n}"`).join(',')}]`)
  }

  return parts.length > 0 ? ` VISION=[${parts.join(' | ')}]` : ''
}

function _rayClear(from, to, blockSet) {
  const allowSet = blockSet || TRANSPARENT
  const bot = state.bot
  for (const [bx, by, bz, lastBx, lastBy, lastBz] of voxelCells(from, to)) {
    if (isDiagBlocked(bot, lastBx, lastBy, lastBz, bx, by, bz, allowSet)) return false
    try {
      const b = bot.blockAt(new Vec3(bx, by, bz))
      if (!b) return false
      if (!allowSet.has(b.name)) return false
    } catch (e) { return false }
  }
  return true
}

function hasLineOfSight(from, entityPos, entityHeight) {
  const h = entityHeight || 1.8
  const hw = 0.3  // half-width of entity hitbox
  // Check feet, eyes, and center
  const targets = [
    entityPos.offset(0, 0.1, 0),        // feet
    entityPos.offset(0, h * 0.5, 0),     // center
    entityPos.offset(0, h - 0.1, 0),     // eyes
    entityPos.offset(hw, h * 0.5, 0),    // side
    entityPos.offset(-hw, h * 0.5, 0),   // side
    entityPos.offset(0, h * 0.5, hw),    // side
    entityPos.offset(0, h * 0.5, -hw),   // side
  ]
  for (const t of targets) {
    if (_rayClear(from, t)) return true
  }
  return false
}

// Reachability == clear sightline through PASSABLE blocks (was a verbatim copy of
// _rayClear; kept as a thin wrapper so the rayReachable export name stays stable).
function _rayReachable(from, to) {
  return _rayClear(from, to, PASSABLE)
}

// Direction name to yaw (radians). Minecraft: 0=south, PI/2=west, PI=north, -PI/2=east
const DIR_YAWS = {
  's': Math.PI, 'south': Math.PI,
  'n': 0, 'north': 0,
  'w': Math.PI / 2, 'west': Math.PI / 2,
  'e': -Math.PI / 2, 'east': -Math.PI / 2,
  'sw': Math.PI * 3 / 4, 'south-west': Math.PI * 3 / 4,
  'nw': Math.PI / 4, 'north-west': Math.PI / 4,
  'se': -Math.PI * 3 / 4, 'south-east': -Math.PI * 3 / 4,
  'ne': -Math.PI / 4, 'north-east': -Math.PI / 4,
}
function dirToYaw(dirName) {
  return DIR_YAWS[dirName.toLowerCase().replace(/ /g, '-')] ?? null
}

module.exports = {
  TRANSPARENT, NOTABLE_TRANSPARENT, PASSABLE, HAZARDS, RESOURCES,
  castVisionRays, formatVision, hasLineOfSight, rayClear: _rayClear, rayReachable: _rayReachable, voxelCells, describeDir, getLastVisionResult, isDiagBlocked,
  dirToYaw,
}
