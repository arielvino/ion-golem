// DB-based path planners — A* over the honest `blocks` DB (+ live vision).
// No bot.blockAt fill: DB + vision only, so plans never "see through" walls.
//
//   • dbAstar         — small region, atomicSteps neighbours (used by dbPathfind/hybrid)
//   • airRopePath     — wide region, walkable-corridor search (kept for future use)
//   • optimisticAstar — optimistic-frontier A* over blockquery predicates (cardinalWalk)
//   • planFromHere    — plan from the bot's current block, resurvey-and-retry once
const state = require('./state')
const { BlockMap } = require('./blockmap')
const { getNeighbors } = require('./atomicSteps')
const { getLastVisionResult } = require('./vision')
const { surveyForNav } = require('./visibility')
const { _pPassable, _pHazard, _pSurface, _pFloor, _pKnownSolid, _pKnownClear } = require('./blockquery')

// ─── DB-Based A* Pathfinder ──────────────────────────────────────────

// Simple min-heap for A* open set
class MinHeap {
  constructor() { this.data = [] }
  push(item) {
    this.data.push(item)
    let i = this.data.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.data[p].f <= this.data[i].f) break
      ;[this.data[p], this.data[i]] = [this.data[i], this.data[p]]
      i = p
    }
  }
  pop() {
    const top = this.data[0]
    const last = this.data.pop()
    if (this.data.length > 0) {
      this.data[0] = last
      let i = 0
      while (true) {
        let min = i
        const l = 2 * i + 1, r = 2 * i + 2
        if (l < this.data.length && this.data[l].f < this.data[min].f) min = l
        if (r < this.data.length && this.data[r].f < this.data[min].f) min = r
        if (min === i) break
        ;[this.data[min], this.data[i]] = [this.data[i], this.data[min]]
        i = min
      }
    }
    return top
  }
  get length() { return this.data.length }
}

// A* search using atomic steps on BlockMap data
function dbAstar(sx, sy, sz, tx, ty, tz, maxNodes = 2000) {
  const margin = 10
  const map = new BlockMap()
  const loaded = map.loadRegion(
    Math.min(sx, tx) - margin, Math.min(sy, ty) - margin, Math.min(sz, tz) - margin,
    Math.max(sx, tx) + margin, Math.max(sy, ty) + margin, Math.max(sz, tz) + margin
  )
  if (loaded < 20) {
    console.log(`  [A*] too few blocks in region: ${loaded}`)
    return null
  }

  // Merge current vision data (fresher than DB)
  const vision = getLastVisionResult()
  if (vision) map.mergeVision(vision)

  // No bot.blockAt fill — DB + vision only (no x-ray rule)

  // Check if start position has any valid neighbors
  const startNeighbors = getNeighbors(map, sx, sy, sz)
  if (startNeighbors.length === 0) {
    console.log(`  [A*] no valid moves from start (${sx},${sy},${sz}), floor=${map.get(sx,sy-1,sz)}, foot=${map.get(sx,sy,sz)}, head=${map.get(sx,sy+1,sz)}`)
    return null
  }

  const heuristic = (x, y, z) => Math.abs(x - tx) + Math.abs(y - ty) + Math.abs(z - tz)
  const key = (x, y, z) => `${x},${y},${z}`

  const open = new MinHeap()
  const gScore = new Map()  // key → cost from start
  const cameFrom = new Map() // key → parent key

  const startKey = key(sx, sy, sz)
  gScore.set(startKey, 0)
  open.push({ x: sx, y: sy, z: sz, f: heuristic(sx, sy, sz) })

  let expanded = 0
  while (open.length > 0 && expanded < maxNodes) {
    const cur = open.pop()
    const ck = key(cur.x, cur.y, cur.z)
    expanded++

    // Arrival check — reached target XZ block
    if (cur.x === tx && cur.z === tz) {
      // Reconstruct path
      const path = [{ x: cur.x, y: cur.y, z: cur.z }]
      let pk = ck
      while (cameFrom.has(pk)) {
        pk = cameFrom.get(pk)
        const [px, py, pz] = pk.split(',').map(Number)
        path.push({ x: px, y: py, z: pz })
      }
      path.reverse()
      console.log(`  [A*] found path: ${path.length} steps, ${expanded} nodes explored, ${map.size} blocks in map`)
      return path
    }

    const curG = gScore.get(ck)
    const neighbors = getNeighbors(map, cur.x, cur.y, cur.z)

    for (const n of neighbors) {
      const nk = key(n.x, n.y, n.z)
      const ng = curG + n.cost
      const existing = gScore.get(nk)
      if (existing !== undefined && existing <= ng) continue
      gScore.set(nk, ng)
      cameFrom.set(nk, ck)
      open.push({ x: n.x, y: n.y, z: n.z, f: ng + heuristic(n.x, n.y, n.z) })
    }
  }

  if (expanded >= maxNodes) console.log(`  [A*] budget exhausted (${maxNodes} nodes, ${map.size} blocks)`)
  else console.log(`  [A*] no path found (${expanded} nodes explored, ${map.size} blocks in map)`)
  return null
}

// Air rope: A* through known passable blocks in DB to find shortest connected corridor.
// Unlike dbAstar (small region, 2000 nodes), this searches the ENTIRE explored area
// for a connected path of walkable blocks (foot+head passable, floor solid/surface).
// Every node is guaranteed to be on solid ground — no sky/shaft blocks.
function airRopePath(sx, sy, sz, tx, ty, tz, maxNodes = 10000) {
  const { PASSABLE, SURFACE } = require('./config/blocks')

  // Load passable blocks from DB in wide region encompassing start→target
  const margin = 30
  const map = new BlockMap()
  const loaded = map.loadRegion(
    Math.min(sx, tx) - margin, Math.min(sy, ty) - margin, Math.min(sz, tz) - margin,
    Math.max(sx, tx) + margin, Math.max(sy, ty) + margin, Math.max(sz, tz) + margin
  )
  if (loaded < 10) return null

  // Merge vision
  const vision = getLastVisionResult()
  if (vision) map.mergeVision(vision)

  // Floor check: solid below, or standing on a surface block
  const hasFloorAt = (x, y, z) => {
    const below = map.get(x, y - 1, z)
    if (below && !PASSABLE.has(below)) return true  // solid floor
    const foot = map.get(x, y, z)
    if (foot && SURFACE.has(foot)) return true      // standing on lily_pad/carpet
    return false
  }

  // A* with Manhattan heuristic — finds shortest path
  const key = (x, y, z) => `${x},${y},${z}`
  const startKey = key(sx, sy, sz)

  // Min-heap by f = g + h
  const open = [{ x: sx, y: sy, z: sz, g: 0, f: Math.abs(sx - tx) + Math.abs(sy - ty) + Math.abs(sz - tz) }]
  const gScore = new Map()
  const cameFrom = new Map()
  gScore.set(startKey, 0)
  let found = null
  let searched = 0

  while (open.length > 0 && searched < maxNodes) {
    // Pop node with lowest f score
    let bestIdx = 0
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i
    }
    const cur = open[bestIdx]
    open[bestIdx] = open[open.length - 1]; open.pop()
    searched++

    const curKey = key(cur.x, cur.y, cur.z)

    // Skip if we've already found a better path to this node
    if (cur.g > (gScore.get(curKey) ?? Infinity)) continue

    // Arrived?
    const dist = Math.abs(cur.x - tx) + Math.abs(cur.y - ty) + Math.abs(cur.z - tz)
    if (dist <= 3) { found = cur; break }

    // Expand: 4 cardinal × 3 Y offsets (flat, up, down)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, nz = cur.z + dz
      for (const dy of [0, 1, -1]) {
        const ny = cur.y + dy
        const nk = key(nx, ny, nz)

        const foot = map.get(nx, ny, nz)
        const head = map.get(nx, ny + 1, nz)
        if (foot === null || head === null) continue   // unknown
        if (!PASSABLE.has(foot) || !PASSABLE.has(head)) continue  // blocked

        // Must have solid floor — no floating air
        if (!hasFloorAt(nx, ny, nz)) continue

        // Step-up needs jump clearance at origin
        if (dy === 1) {
          const jumpClear = map.get(cur.x, cur.y + 2, cur.z)
          if (jumpClear !== null && !PASSABLE.has(jumpClear)) continue
        }

        const stepCost = dy === 0 ? 1.0 : (dy === 1 ? 1.5 : 1.2)
        const tentG = cur.g + stepCost
        const prevG = gScore.get(nk)
        if (prevG !== undefined && tentG >= prevG) continue

        gScore.set(nk, tentG)
        cameFrom.set(nk, curKey)
        const h = Math.abs(nx - tx) + Math.abs(ny - ty) + Math.abs(nz - tz)
        open.push({ x: nx, y: ny, z: nz, g: tentG, f: tentG + h })
      }
    }
  }

  if (!found) return null

  // Reconstruct shortest path
  const path = []
  let ck = key(found.x, found.y, found.z)
  while (ck) {
    const [px, py, pz] = ck.split(',').map(Number)
    path.unshift({ x: px, y: py, z: pz })
    ck = cameFrom.get(ck)
  }

  console.log(`  [airRope] found path: ${path.length} nodes (searched ${searched})`)
  return path.length >= 2 ? path : null
}

// ─── Optimistic-frontier A* (cardinalWalk's planner) ──────────────────
// The planner is OPTIMISTIC about the unknown (see blockquery.js): A* plans a
// hopeful route toward the target; the bot walks it with the STRICT liveStep,
// omni-resurveys as it goes, and replans when real blocks appear. Genuinely-
// unreachable cells (can't be revealed) go into `avoid` so the next plan routes
// elsewhere — guarantees progress/termination.

// Optimistic neighbour expansion. Flat is optimistic (walks over fog at level Y);
// step-up/step-down only onto KNOWN-good geometry, so the planner never leaps
// blindly into an unseen void — the executor + replan handle real elevation.
function _pNeighbors(x, y, z, mode, avoid) {
  const out = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, nz = z + dz
    // FLAT — optimistic over unknown. Floor support is the block BELOW the foot
    // (y-1): solid/unknown ground, or a surface block at foot level (carpet/lily).
    // Checking the foot cell itself would reject all known-air walkable space.
    if (!(avoid && avoid.has(`${nx},${y},${nz}`)) &&
        _pPassable(nx, y, nz) && _pPassable(nx, y + 1, nz) &&
        (_pFloor(nx, y - 1, nz) || _pSurface(nx, y, nz)) &&
        !_pHazard(nx, y, nz) && !_pHazard(nx, y - 1, nz)) {
      out.push({ x: nx, y, z: nz, cost: 1 })
      continue
    }
    // STEP-UP — only onto a KNOWN solid step (flat was blocked by it)
    if (!(avoid && avoid.has(`${nx},${y + 1},${nz}`)) &&
        _pPassable(x, y + 2, z) && _pPassable(nx, y + 1, nz) && _pPassable(nx, y + 2, nz) &&
        _pKnownSolid(nx, y, nz) && !_pHazard(nx, y + 1, nz)) {
      out.push({ x: nx, y: y + 1, z: nz, cost: 1.6 })
    }
    // STEP-DOWN — only into a KNOWN drop (clear fall column + known landing floor)
    for (let d = 1; d <= 3; d++) {
      if (avoid && avoid.has(`${nx},${y - d},${nz}`)) continue
      if (!_pPassable(nx, y, nz) || !_pPassable(nx, y + 1, nz)) break
      let clear = true
      for (let k = 1; k <= d; k++) { if (!_pKnownClear(nx, y - k, nz)) { clear = false; break } }
      if (!clear) continue
      const landY = y - d
      if ((_pKnownSolid(nx, landY - 1, nz) || _pSurface(nx, landY, nz)) && !_pHazard(nx, landY, nz)) {
        out.push({ x: nx, y: landY, z: nz, cost: 1 + d * 0.3 }); break
      }
    }
  }
  return out
}

// A* with optimistic neighbours. Arrives on target XZ block. Returns [{x,y,z}] or null.
function optimisticAstar(sx, sy, sz, tx, ty, tz, mode, avoid, maxNodes = 6000) {
  const key = (x, y, z) => `${x},${y},${z}`
  const h = (x, y, z) => Math.abs(x - tx) + Math.abs(y - ty) + Math.abs(z - tz)
  const open = new MinHeap()
  const gScore = new Map()
  const cameFrom = new Map()
  const startKey = key(sx, sy, sz)
  gScore.set(startKey, 0)
  open.push({ x: sx, y: sy, z: sz, f: h(sx, sy, sz) })
  let expanded = 0
  while (open.length > 0 && expanded < maxNodes) {
    const cur = open.pop()
    const ck = key(cur.x, cur.y, cur.z)
    expanded++
    if (cur.x === tx && cur.z === tz) {
      const path = [{ x: cur.x, y: cur.y, z: cur.z }]
      let pk = ck
      while (cameFrom.has(pk)) { pk = cameFrom.get(pk); const [px, py, pz] = pk.split(',').map(Number); path.push({ x: px, y: py, z: pz }) }
      path.reverse()
      return path
    }
    const curG = gScore.get(ck)
    for (const n of _pNeighbors(cur.x, cur.y, cur.z, mode, avoid)) {
      const nk = key(n.x, n.y, n.z)
      const ng = curG + n.cost
      const existing = gScore.get(nk)
      if (existing !== undefined && existing <= ng) continue
      gScore.set(nk, ng)
      cameFrom.set(nk, ck)
      open.push({ x: n.x, y: n.y, z: n.z, f: ng + h(n.x, n.y, n.z) })
    }
  }
  return null
}

// Plan from the bot's current block. Omni-resurveys once and retries if the
// first plan fails (a wall of seen solids may just need a fresh look).
function planFromHere(tx, ty, tz, mode, avoid) {
  const pos = state.bot.entity.position
  const sx = Math.floor(pos.x), sy = Math.round(pos.y), sz = Math.floor(pos.z)
  let path = optimisticAstar(sx, sy, sz, tx, ty, tz, mode, avoid)
  if (!path || path.length < 2) {
    surveyForNav({ maxDistance: 32 })
    path = optimisticAstar(sx, sy, sz, tx, ty, tz, mode, avoid)
  }
  return (path && path.length >= 2) ? path : null
}

module.exports = { MinHeap, dbAstar, airRopePath, optimisticAstar, _pNeighbors, planFromHere }
