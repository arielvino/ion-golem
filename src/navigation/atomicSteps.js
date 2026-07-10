// Atomic movement steps — hitbox-aware clearance checks
//
// Position (x, y, z) = bot's foot level. Bot stands on block at (x, y-1, z).
// Bot hitbox: 0.6 wide (fits in 1×1 column), 1.8 tall (needs 2 blocks vertical).
//
// BlockMap-based checks (canFlatStep etc.) are used by dbAstar for planning.
// Live movement (liveStep) uses direct DB queries for each block — no BlockMap.

const { Vec3 } = require('vec3')
const { BlockMap } = require('../world/blockmap')  // still used by dbAstar via getNeighbors
const state = require('../core/state')

// Returns 'yes', 'no', or 'unknown'
// 'unknown' = some required block has no data (conservative: treat as blocked)

// Floor check: solid block below, OR foot is a surface block (lily_pad, carpet)
function hasFloor(map, x, y, z) {
  if (map.isSolid(x, y - 1, z)) return true
  if (map.isSurface(x, y, z)) return true  // standing IN a surface block
  return false
}

// --- Safety filter ---
// mode: 'safe' = reject water+hazards, 'water' = allow water, 'hazard' = allow both
function isSafe(map, x, y, z, mode) {
  if (mode !== 'hazard' && map.isHazard(x, y, z)) return false
  if (mode === 'safe' && map.isWater(x, y, z)) return false
  return true
}

function canFlatStep(map, x, y, z, dx, dz, mode = 'safe') {
  // Move to (x+dx, y, z+dz) — same Y level
  const nx = x + dx, nz = z + dz
  if (!isSafe(map, nx, y, nz, mode) || !isSafe(map, nx, y - 1, nz, mode)) return 'no'
  if (map.isUnknown(nx, y, nz) || map.isUnknown(nx, y + 1, nz) || map.isUnknown(nx, y - 1, nz)) return 'unknown'
  if (!map.isPassable(nx, y, nz)) return 'no'      // foot blocked
  if (!map.isPassable(nx, y + 1, nz)) return 'no'  // head blocked
  if (!hasFloor(map, nx, y, nz)) return 'no'       // no floor
  return 'yes'
}

function canStepUp(map, x, y, z, dx, dz, mode = 'safe') {
  // Move to (x+dx, y+1, z+dz) — jump up 1 block
  const nx = x + dx, nz = z + dz
  if (!isSafe(map, nx, y + 1, nz, mode) || !isSafe(map, nx, y, nz, mode)) return 'no'
  if (map.isUnknown(x, y + 2, z) || map.isUnknown(nx, y + 1, nz) ||
      map.isUnknown(nx, y + 2, nz) || map.isUnknown(nx, y, nz)) return 'unknown'
  if (!map.isPassable(x, y + 2, z)) return 'no'      // jump clearance at origin
  if (!map.isPassable(nx, y + 1, nz)) return 'no'    // foot at destination
  if (!map.isPassable(nx, y + 2, nz)) return 'no'    // head at destination
  if (!map.isSolid(nx, y, nz)) return 'no'           // step surface (must be solid to step onto)
  return 'yes'
}
// Note: step-up always needs a solid step block, surface blocks don't apply here

function canStepDown(map, x, y, z, dx, dz, drop, mode = 'safe') {
  // Move to (x+dx, y-drop, z+dz) — drop 1-3 blocks
  // drop=1: safe, drop=2: safe, drop=3: safe (no fall damage)
  if (drop < 1 || drop > 3) return 'no'
  const nx = x + dx, nz = z + dz

  // Body clearance to walk into the gap (at origin Y level)
  if (!isSafe(map, nx, y, nz, mode)) return 'no'
  if (map.isUnknown(nx, y, nz) || map.isUnknown(nx, y + 1, nz)) return 'unknown'
  if (!map.isPassable(nx, y, nz)) return 'no'        // foot level walk-in
  if (!map.isPassable(nx, y + 1, nz)) return 'no'    // head level walk-in

  // Fall space — all blocks in the drop must be passable
  for (let d = 1; d <= drop; d++) {
    if (!isSafe(map, nx, y - d, nz, mode)) return 'no'
    if (map.isUnknown(nx, y - d, nz)) return 'unknown'
    if (!map.isPassable(nx, y - d, nz)) return 'no'
  }

  // Landing floor — solid ground or surface block at foot level
  const landY = y - drop  // foot level after landing
  const floorY = landY - 1
  if (!isSafe(map, nx, floorY, nz, mode)) return 'no'
  if (map.isUnknown(nx, floorY, nz) && !map.isSurface(nx, landY, nz)) return 'unknown'
  if (!hasFloor(map, nx, landY, nz)) return 'no'

  return 'yes'
}

// Get all valid moves from position (x, y, z)
// Returns [{x, y, z, cost, type}]
function getNeighbors(map, x, y, z, mode = 'safe') {
  const moves = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    // Flat step
    if (canFlatStep(map, x, y, z, dx, dz, mode) === 'yes')
      moves.push({ x: x + dx, y, z: z + dz, cost: 1, type: 'flat' })

    // Step up
    if (canStepUp(map, x, y, z, dx, dz, mode) === 'yes')
      moves.push({ x: x + dx, y: y + 1, z: z + dz, cost: 1.5, type: 'up' })

    // Step down (1-3 block drops, take shallowest valid)
    for (let drop = 1; drop <= 3; drop++) {
      if (canStepDown(map, x, y, z, dx, dz, drop, mode) === 'yes') {
        moves.push({ x: x + dx, y: y - drop, z: z + dz, cost: 1 + drop * 0.2, type: 'down' })
        break
      }
    }
  }
  return moves
}

// Get valid neighbors using direct DB queries (same checks as liveStep)
function dbGetNeighbors(x, y, z, mode = 'safe') {
  const moves = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (dbCanFlat(x, y, z, dx, dz, mode)) moves.push({ x: x + dx, y, z: z + dz, cost: 1 })
    if (dbCanUp(x, y, z, dx, dz, mode)) moves.push({ x: x + dx, y: y + 1, z: z + dz, cost: 1.5 })
    for (let d = 1; d <= 3; d++) {
      if (dbCanDown(x, y, z, dx, dz, d, mode)) { moves.push({ x: x + dx, y: y - d, z: z + dz, cost: 1 + d * 0.2 }); break }
    }
  }
  return moves
}

// A* pathfinder using direct DB queries — plans path before walking.
// Uses same block checks as liveStep, so the planned path is safe to execute.
function dbPlanPath(sx, sy, sz, tx, ty, tz, mode = 'safe', maxNodes = 3000) {
  const key = (x, y, z) => `${x},${y},${z}`
  const open = [{ x: sx, y: sy, z: sz, g: 0, f: Math.abs(sx - tx) + Math.abs(sy - ty) + Math.abs(sz - tz) }]
  const gScore = new Map(); gScore.set(key(sx, sy, sz), 0)
  const cameFrom = new Map()
  let searched = 0

  while (open.length > 0 && searched < maxNodes) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i
    const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop(); searched++
    const ck = key(cur.x, cur.y, cur.z)
    if (cur.g > (gScore.get(ck) ?? Infinity)) continue
    if (cur.x === tx && cur.z === tz) { // reached target XZ block
      const path = []; let k = ck
      while (k) { const [px, py, pz] = k.split(',').map(Number); path.unshift({ x: px, y: py, z: pz }); k = cameFrom.get(k) }
      return path
    }
    for (const n of dbGetNeighbors(cur.x, cur.y, cur.z, mode)) {
      const nk = key(n.x, n.y, n.z)
      const tentG = cur.g + n.cost
      if (tentG >= (gScore.get(nk) ?? Infinity)) continue
      gScore.set(nk, tentG)
      cameFrom.set(nk, ck)
      open.push({ x: n.x, y: n.y, z: n.z, g: tentG, f: tentG + Math.abs(n.x - tx) + Math.abs(n.y - ty) + Math.abs(n.z - tz) })
    }
  }
  return null
}

// ─── Live Movement Primitives ──────────────────────────────────────
// These execute actual bot movement, verified against DB block queries.

const { PASSABLE, SURFACE, HAZARDS, WATER_BLOCKS } = require('../config/blocks')

// Query single block from DB only. No bot.blockAt (no x-ray).
// Vision updates DB every 3s. For immediate neighbors, the vision
// auto-fill and frequent updates keep the data fresh.
function dbBlock(x, y, z) {
  try {
    const row = state.stmts.getBlockAt.get(x, y, z)
    return row ? row.name : null
  } catch (e) { return null }
}

function dbPassable(x, y, z) { const n = dbBlock(x, y, z); return n !== null && PASSABLE.has(n) }
function dbSolid(x, y, z)   { const n = dbBlock(x, y, z); return n !== null && !PASSABLE.has(n) }
function dbUnknown(x, y, z)  { return dbBlock(x, y, z) === null }
function dbHazard(x, y, z)  { const n = dbBlock(x, y, z); return n !== null && HAZARDS.has(n) }
function dbWater(x, y, z)   { const n = dbBlock(x, y, z); return WATER_BLOCKS.has(n) }
function dbSurface(x, y, z) { const n = dbBlock(x, y, z); return n !== null && SURFACE.has(n) }

function dbHasFloor(x, y, z) {
  if (dbSolid(x, y - 1, z)) return true
  if (dbSurface(x, y, z)) return true
  return false
}

// Safety check: reject hazards and/or water based on mode
function dbSafe(x, y, z, mode) {
  if (mode !== 'hazard' && dbHazard(x, y, z)) return false
  if (mode === 'safe' && dbWater(x, y, z)) return false
  return true
}

// Live clearance checks — direct DB queries, no BlockMap
function dbCanFlat(cx, cy, cz, dx, dz, mode) {
  const nx = cx + dx, nz = cz + dz
  if (!dbSafe(nx, cy, nz, mode) || !dbSafe(nx, cy - 1, nz, mode)) return false
  if (dbUnknown(nx, cy, nz) || dbUnknown(nx, cy + 1, nz) || dbUnknown(nx, cy - 1, nz)) return false
  if (!dbPassable(nx, cy, nz)) return false      // foot blocked
  if (!dbPassable(nx, cy + 1, nz)) return false  // head blocked
  if (!dbHasFloor(nx, cy, nz)) return false       // no floor
  return true
}

function dbCanUp(cx, cy, cz, dx, dz, mode) {
  const nx = cx + dx, nz = cz + dz
  if (!dbSafe(nx, cy + 1, nz, mode) || !dbSafe(nx, cy, nz, mode)) return false
  if (dbUnknown(cx, cy + 2, cz) || dbUnknown(nx, cy + 1, nz) || dbUnknown(nx, cy + 2, nz) || dbUnknown(nx, cy, nz)) return false
  if (!dbPassable(cx, cy + 2, cz)) return false      // jump clearance at origin
  if (!dbPassable(nx, cy + 1, nz)) return false       // foot at destination
  if (!dbPassable(nx, cy + 2, nz)) return false       // head at destination
  if (!dbSolid(nx, cy, nz)) return false              // step surface
  return true
}

function dbCanDown(cx, cy, cz, dx, dz, drop, mode) {
  if (drop < 1 || drop > 3) return false
  const nx = cx + dx, nz = cz + dz
  if (!dbSafe(nx, cy, nz, mode)) return false
  if (dbUnknown(nx, cy, nz) || dbUnknown(nx, cy + 1, nz)) return false
  if (!dbPassable(nx, cy, nz)) return false        // foot walk-in
  if (!dbPassable(nx, cy + 1, nz)) return false    // head walk-in
  for (let d = 1; d <= drop; d++) {
    if (!dbSafe(nx, cy - d, nz, mode)) return false
    if (dbUnknown(nx, cy - d, nz)) return false
    if (!dbPassable(nx, cy - d, nz)) return false
  }
  const landY = cy - drop
  if (!dbSafe(nx, landY - 1, nz, mode)) return false
  if (dbUnknown(nx, landY - 1, nz) && !dbSurface(nx, landY, nz)) return false
  if (!dbHasFloor(nx, landY, nz)) return false
  return true
}

// Core atomic movement: move exactly 1 block in cardinal direction.
// Checks clearance against DB queries, executes physics, verifies arrival.
//
// opts.mode: 'safe' (default) | 'water' | 'hazard'
// Returns: { ok: boolean, type: 'flat'|'up'|'down'|'blocked', dy: number }
async function liveStep(bot, dx, dz, opts = {}) {
  const mode = opts.mode || 'safe'
  const pos = bot.entity.position
  const cx = Math.floor(pos.x), cy = Math.round(pos.y), cz = Math.floor(pos.z)
  const nx = cx + dx, nz = cz + dz

  // Determine move type from DB checks: try flat, then up, then down
  let moveType = null, targetY = cy, drop = 0

  if (dbCanFlat(cx, cy, cz, dx, dz, mode)) {
    moveType = 'flat'; targetY = cy
  } else if (dbCanUp(cx, cy, cz, dx, dz, mode)) {
    moveType = 'up'; targetY = cy + 1
  } else {
    for (let d = 1; d <= 3; d++) {
      if (dbCanDown(cx, cy, cz, dx, dz, d, mode)) {
        moveType = 'down'; targetY = cy - d; drop = d; break
      }
    }
  }

  if (!moveType) {
    return { ok: false, type: 'blocked', dy: 0 }
  }

  // Log step attempt
  const floorName = dbBlock(nx, targetY - 1, nz) || '?'
  const footName = dbBlock(nx, targetY, nz) || '?'
  console.log(`  [liveStep] ${cx},${cy},${cz} → ${nx},${targetY},${nz} ${moveType}${drop ? `(drop=${drop})` : ''} mode=${mode} floor=${floorName} foot=${footName}`)

  // Execute physical movement using predictive release.
  // Physics: vel = vel * inertia + accel. On ground inertia = 0.546.
  // When we release keys, the bot still moves |vel| this tick (already committed),
  // then slides: vel*inertia + vel*inertia^2 + ... = vel * inertia/(1-inertia).
  // Total slide = vel + vel * inertia/(1-inertia) = vel / (1-inertia) = vel * 2.2026
  const tick = () => bot.waitForTicks(1)
  const GROUND_INERTIA = 0.546
  const TOTAL_SLIDE_FACTOR = 1 / (1 - GROUND_INERTIA) // 2.2026 — includes current tick movement

  // Pure cardinal yaw — snaps perfectly to sensitivity grid
  const cardinalYaw = dx === 1 ? -Math.PI / 2   // east
                    : dx === -1 ? Math.PI / 2    // west
                    : dz === 1 ? Math.PI          // south
                    : 0                            // north

  // Movement axis helpers
  const axis = dx !== 0 ? 'x' : 'z'
  const dir = dx !== 0 ? dx : dz  // +1 or -1
  const targetCenter = (dx !== 0 ? nx : nz) + 0.5
  const getPos = () => bot.entity.position[axis]
  const getVel = () => bot.entity.velocity[axis]
  const remaining = () => (targetCenter - getPos()) * dir  // positive = still need to go
  // Check if releasing NOW will land at or past target center.
  // Must trigger one tick early because the bot moves |vel| blocks between
  // our check and when clearControlStates actually takes effect.
  // So: release when slide >= remaining - |vel| (remaining AFTER one more tick)
  const slideWillReach = () => {
    const vel = Math.abs(getVel())
    return vel * TOTAL_SLIDE_FACTOR >= remaining() - vel
  }
  const arrived = () => Math.floor(bot.entity.position.x) === nx && Math.floor(bot.entity.position.z) === nz

  // Wait for bot to settle (velocity < 0.003 = negligeableVelocity)
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await tick()
      const v = bot.entity.velocity
      if (Math.abs(v.x) < 0.003 && Math.abs(v.z) < 0.003) break
    }
  }

  try {
    // Lookahead recenter: if the cell we're stepping into is a 1-wide corridor
    // mouth (solid block on one perpendicular side), pull the bot to center on the
    // perpendicular axis FIRST. The step itself centers the moving axis; perp drift
    // is what clips side walls, and once the hitbox is inside the gap the bot can't
    // strafe out. Cheap DB check — only fires at constrictions, free on open ground.
    const perpAxis = dx !== 0 ? 'z' : 'x'
    const pc = bot.entity.position[perpAxis]
    if (Math.abs((Math.floor(pc) + 0.5) - pc) > 0.15) {
      const wall = (o) => dx !== 0
        ? (dbSolid(nx, cy, nz + o) || dbSolid(nx, cy + 1, nz + o))
        : (dbSolid(nx + o, cy, nz) || dbSolid(nx + o, cy + 1, nz))
      if (wall(1) || wall(-1)) {
        await centerInBlock(bot, { axis: perpAxis })
        if (state.abortSignal) { bot.clearControlStates(); return { ok: false, type: 'blocked', dy: 0 } }
      }
    }

    if (moveType === 'flat') {
      await bot.look(cardinalYaw, 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      const deadline = Date.now() + 1500
      let sprintDropped = false
      let tickCount = 0
      while (Date.now() < deadline) {
        await tick()
        tickCount++
        if (state.abortSignal) break
        const rem = remaining()
        const vel = Math.abs(getVel())
        const slide = vel * TOTAL_SLIDE_FACTOR
        // Drop sprint when within 0.8 blocks — walk the rest for precision
        if (!sprintDropped && rem < 0.8) {
          bot.setControlState('sprint', false)
          sprintDropped = true
        }
        console.log(`    [t${tickCount}] p=${getPos().toFixed(2)} v=${vel.toFixed(3)} r=${rem.toFixed(2)} s=${slide.toFixed(2)} sp=${!sprintDropped?'Y':'N'}`)
        if (slide >= rem) break
      }
      bot.clearControlStates()
      await settle()

    } else if (moveType === 'up') {
      // Walk toward step block, jump, release forward when XZ reaches target
      await bot.look(cardinalYaw, 0, true)
      bot.setControlState('forward', true)
      // Walk into step block until horizontal velocity drops (pressed against it)
      for (let i = 0; i < 15; i++) {
        await tick()
        if (state.abortSignal) break
        if (Math.abs(getVel()) < 0.01) break
      }
      // Jump while still pressing forward — need momentum to reach the step top
      bot.setControlState('jump', true)
      const deadline = Date.now() + 1500
      while (Date.now() < deadline) {
        await tick()
        if (state.abortSignal) break
        // Release forward the moment XZ enters target block — prevents overshoot
        if (arrived()) {
          bot.setControlState('forward', false)
          bot.setControlState('jump', false)
        }
        if (bot.entity.onGround && Math.round(bot.entity.position.y) >= targetY) break
      }
      bot.clearControlStates()
      await settle()

    } else if (moveType === 'down') {
      // Step-down: use same predictive release as flat steps to reach target
      // block center precisely. For drop=1, MC auto-steps down (no fall).
      // For drop=2+, bot falls after reaching the target XZ column.
      await bot.look(cardinalYaw, 0, true)
      bot.setControlState('forward', true)
      // Walk to target block center — same logic as flat step (no sprint for safety)
      const deadline = Date.now() + 1500
      while (Date.now() < deadline) {
        await tick()
        if (state.abortSignal) break
        if (slideWillReach()) break
      }
      bot.clearControlStates()
      // For drop>=2: wait for landing after clearing the edge
      if (drop >= 2) {
        const landDeadline = Date.now() + 2000
        while (Date.now() < landDeadline) {
          await tick()
          if (state.abortSignal) break
          if (bot.entity.onGround) break
        }
      }
      await settle()
    }
  } catch (e) {
    bot.clearControlStates()
    return { ok: false, type: moveType, dy: targetY - cy }
  }

  // Verify arrival: floor(position) must match expected block
  const finalPos = bot.entity.position
  const arrivedX = Math.floor(finalPos.x) === nx
  const arrivedZ = Math.floor(finalPos.z) === nz
  const arrivedY = Math.round(finalPos.y) === targetY

  const actualX = Math.floor(finalPos.x), actualY = Math.round(finalPos.y), actualZ = Math.floor(finalPos.z)

  // How far from target center?
  const offX = (finalPos.x - (nx + 0.5)).toFixed(2)
  const offZ = (finalPos.z - (nz + 0.5)).toFixed(2)

  if (arrivedX && arrivedZ && arrivedY) {
    console.log(`  [liveStep] OK at ${actualX},${actualY},${actualZ} (off=${offX},${offZ})`)
    return { ok: true, type: moveType, dy: targetY - cy }
  }

  // Close enough? Allow 1 Y tolerance for step-down (might land slightly different)
  if (arrivedX && arrivedZ && moveType === 'down' && bot.entity.onGround) {
    console.log(`  [liveStep] OK at ${actualX},${actualY},${actualZ} (landed Y≠expected, off=${offX},${offZ})`)
    return { ok: true, type: moveType, dy: Math.round(finalPos.y) - cy }
  }

  console.log(`  [liveStep] FAIL expected ${nx},${targetY},${nz} actual ${actualX},${actualY},${actualZ} onGround=${bot.entity.onGround}`)
  return { ok: false, type: moveType, dy: targetY - cy }
}

// ─── Micro-movement: sub-block centering ───────────────────────────
// Glide forward along ONE cardinal axis to a precise coordinate, reusing
// liveStep's predictive velocity-release (release the key one tick early and let
// ground inertia slide the bot onto the mark). Walking only — no sprint — for the
// precision the sub-block distances of centering need. Moves at most ~1 block; the
// caller guarantees the lane to targetCoord is clear (centering only ever moves
// within the block the bot already stands in, so that holds by construction).
async function glideAxis(bot, axis, targetCoord, opts = {}) {
  const dir = Math.sign(targetCoord - bot.entity.position[axis])
  if (dir === 0) return
  const cardinalYaw = axis === 'x'
    ? (dir === 1 ? -Math.PI / 2 : Math.PI / 2)   // +x east, -x west
    : (dir === 1 ? Math.PI : 0)                   // +z south, -z north
  const tick = () => bot.waitForTicks(1)
  const TOTAL_SLIDE = 1 / (1 - 0.546)  // 2.2026 — ground-inertia slide, same as liveStep
  const getPos = () => bot.entity.position[axis]
  const getVel = () => Math.abs(bot.entity.velocity[axis])
  const remaining = () => (targetCoord - getPos()) * dir

  await bot.look(cardinalYaw, 0, true)
  bot.setControlState('forward', true)
  const deadline = Date.now() + (opts.timeout || 800)
  while (Date.now() < deadline) {
    await tick()
    if (state.abortSignal) break
    const rem = remaining()
    if (rem <= 0) break  // reached or overshot the mark
    // Release when this tick's velocity will slide us to the mark (one tick early,
    // since the bot moves |vel| more between this check and clearControlStates).
    if (getVel() * TOTAL_SLIDE >= rem - getVel()) break
  }
  bot.clearControlStates()
  for (let i = 0; i < 10; i++) {
    await tick()
    if (Math.abs(bot.entity.velocity.x) < 0.003 && Math.abs(bot.entity.velocity.z) < 0.003) break
  }
}

// Pull the bot to its current block's center on one axis (or both). Centering only
// moves the bot toward the middle of the block it already occupies — i.e. AWAY
// from the side walls it's about to thread — so it can never glide into a wall, and
// it stays over the same floor block it's already standing on. Used as a lookahead
// before entering a 1-wide constriction: a bot wedged in a 1-wide gap has solid
// perpendicular neighbours and physically cannot strafe out, so it must be centered
// BEFORE the threshold step.
// opts.axis: 'x' | 'z' | undefined (both). opts.tol: max accepted offset (0.15).
async function centerInBlock(bot, opts = {}) {
  const tol = opts.tol ?? 0.15
  const axes = opts.axis ? [opts.axis] : ['x', 'z']
  if (!bot.entity.onGround) return false   // airborne: centering is meaningless/unsafe
  const fx = Math.floor(bot.entity.position.x)
  const fy = Math.round(bot.entity.position.y)
  const fz = Math.floor(bot.entity.position.z)
  // Don't pull the bot off a ledge: if the block it nominally occupies has no floor
  // (it's balanced on a neighbour's edge), centering would walk it into air.
  if (!dbHasFloor(fx, fy, fz)) return false
  let centered = true
  for (const axis of axes) {
    // A couple of passes, in case a glide slightly overshoots center.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (state.abortSignal) return false
      const coord = bot.entity.position[axis]
      const target = Math.floor(coord) + 0.5
      if (Math.abs(target - coord) <= tol) break
      await glideAxis(bot, axis, target)
    }
    const c2 = bot.entity.position[axis]
    if (Math.abs((Math.floor(c2) + 0.5) - c2) > tol) centered = false
  }
  return centered
}

// Follow a path from dbAstar step by step using liveStep.
// path: [{x,y,z}, ...] — ordered waypoints
// Count consecutive flat steps in the same direction from pathIdx
function countStraightRun(path, idx) {
  if (idx >= path.length - 1) return 0
  const from = path[idx]
  const to = path[idx + 1]
  const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y
  if (dy !== 0 || (dx === 0 && dz === 0)) return 0 // not flat
  let count = 1
  for (let i = idx + 1; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    if (b.x - a.x !== dx || b.z - a.z !== dz || b.y !== a.y) break
    count++
  }
  return count
}

// Sprint through multiple consecutive flat steps in the same direction.
// No intermediate checks — just sprint to the final block center and stop.
// The path is pre-planned safe, so we only need to land precisely at the end.
async function sprintRun(bot, path, startIdx, count) {
  const tick = () => bot.waitForTicks(1)
  const GROUND_INERTIA = 0.546
  const TOTAL_SLIDE = 1 / (1 - GROUND_INERTIA) // 2.2026

  const to = path[startIdx + 1]
  const dx = to.x - path[startIdx].x, dz = to.z - path[startIdx].z
  const axis = dx !== 0 ? 'x' : 'z'
  const dir = dx !== 0 ? dx : dz
  const cardinalYaw = dx === 1 ? -Math.PI / 2 : dx === -1 ? Math.PI / 2 : dz === 1 ? Math.PI : 0

  // Only care about the final block center
  const finalNode = path[startIdx + count]
  const finalCenter = (dx !== 0 ? finalNode.x : finalNode.z) + 0.5
  const getPos = () => bot.entity.position[axis]
  const getVel = () => Math.abs(bot.entity.velocity[axis])
  const remaining = () => (finalCenter - getPos()) * dir

  let exitReason = 'unknown'
  try {
    // Pre-sprint recenter: sprintRun never corrects perpendicular drift, so if any
    // cell in this straight run is a 1-wide constriction, center the perpendicular
    // axis ONCE before launching — then pure cardinal sprinting preserves it for the
    // whole corridor. (Same rationale as liveStep's lookahead; sprintRun bypasses it.)
    const perpAxis = axis === 'x' ? 'z' : 'x'
    let constricted = false
    for (let i = startIdx; i <= startIdx + count && i < path.length; i++) {
      const n = path[i]
      const s1 = axis === 'x' ? (dbSolid(n.x, n.y, n.z + 1) || dbSolid(n.x, n.y + 1, n.z + 1))
                              : (dbSolid(n.x + 1, n.y, n.z) || dbSolid(n.x + 1, n.y + 1, n.z))
      const s2 = axis === 'x' ? (dbSolid(n.x, n.y, n.z - 1) || dbSolid(n.x, n.y + 1, n.z - 1))
                              : (dbSolid(n.x - 1, n.y, n.z) || dbSolid(n.x - 1, n.y + 1, n.z))
      if (s1 || s2) { constricted = true; break }
    }
    if (constricted) {
      const ppc = bot.entity.position[perpAxis]
      if (Math.abs((Math.floor(ppc) + 0.5) - ppc) > 0.15) await centerInBlock(bot, { axis: perpAxis })
      if (state.abortSignal) { exitReason = 'abort'; bot.clearControlStates(); return false }
    }

    const yawBefore = bot.entity.yaw
    await bot.look(cardinalYaw, 0, true)
    const yawAfter = bot.entity.yaw
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    console.log(`  [sr] start: yawTarget=${cardinalYaw.toFixed(4)} yawBefore=${yawBefore.toFixed(4)} yawAfter=${yawAfter.toFixed(4)} onGround=${bot.entity.onGround} isInWeb=${bot.entity.isInWeb} pos=${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(6)},${bot.entity.position.z.toFixed(2)} vel=${bot.entity.velocity.x.toFixed(4)},${bot.entity.velocity.y.toFixed(4)},${bot.entity.velocity.z.toFixed(4)} ctrl.fwd=${bot.controlState.forward} ctrl.sprint=${bot.controlState.sprint}`)

    const deadline = Date.now() + count * 600 + 2000
    let tickNum = 0
    while (Date.now() < deadline) {
      await tick()
      tickNum++
      if (state.abortSignal) { exitReason = 'abort'; break }
      const rem = remaining()
      const vel = getVel()
      const slide = vel * TOTAL_SLIDE
      if (tickNum <= 5 || vel > 0.001) {
        console.log(`    [sr t${tickNum}] p=${getPos().toFixed(2)} v=${vel.toFixed(3)} r=${rem.toFixed(2)} s=${slide.toFixed(2)} y=${bot.entity.position.y.toFixed(4)} onG=${bot.entity.onGround} vRaw=${bot.entity.velocity.x.toFixed(4)},${bot.entity.velocity.y.toFixed(4)},${bot.entity.velocity.z.toFixed(4)}`)
      }
      if (rem < 0.8) bot.setControlState('sprint', false)
      if (slide >= rem - vel) { exitReason = 'slideReached'; break }
    }
    if (exitReason === 'unknown') exitReason = 'deadline'
  } catch (e) {
    exitReason = `error: ${e.message}`
    console.log(`  [sprintRun] CAUGHT: ${e.message}`)
  }

  bot.clearControlStates()
  try {
    for (let i = 0; i < 10; i++) {
      await tick()
      if (Math.abs(bot.entity.velocity.x) < 0.003 && Math.abs(bot.entity.velocity.z) < 0.003) break
    }
  } catch (e) { /* velocity settling interrupted */ }

  const off = (getPos() - finalCenter).toFixed(2)
  const offBlocks = Math.abs(Math.floor(bot.entity.position[axis]) - finalNode[axis === 'x' ? 'x' : 'z'])
  console.log(`  [sprintRun] ${count} blocks ${axis}${dir > 0 ? '+' : '-'}, off=${off} (${offBlocks} blocks) exit=${exitReason}`)

  return offBlocks <= 1
}

// Walk the path to the final node. No range tolerance — walk to exact block.
// Returns true if bot reached the final node's block coords.
async function followPath(bot, path, opts = {}) {
  const getMode = opts.modeFunc || (() => opts.mode || 'safe')
  const PER_STEP_TIMEOUT = 3000  // 3s per step — resets on each successful step
  let lastProgress = Date.now()

  if (!path || path.length < 2) return false

  const target = path[path.length - 1]
  let pathIdx = 0

  for (let step = 0; step < path.length * 2; step++) { // safety bound
    if (state.abortSignal) { console.log(`  [followPath] aborted`); return false }
    if (Date.now() - lastProgress > PER_STEP_TIMEOUT) { console.log(`  [followPath] timeout (no progress for ${PER_STEP_TIMEOUT}ms)`); return false }

    // Arrived at exact final block?
    const pos = bot.entity.position
    if (Math.floor(pos.x) === target.x && Math.floor(pos.z) === target.z) return true

    // Find closest path node ahead of us
    const cx = Math.floor(pos.x), cy = Math.round(pos.y), cz = Math.floor(pos.z)
    while (pathIdx < path.length - 1) {
      const n = path[pathIdx]
      if (n.x === cx && n.z === cz && Math.abs(n.y - cy) <= 1) { pathIdx++; continue }
      break
    }
    if (pathIdx >= path.length) return true

    // Check for consecutive same-direction flat steps — sprint through them.
    // pathIdx is a DESTINATION (next node to reach), but countStraightRun and
    // sprintRun use START convention (where the bot stands). Use pathIdx-1
    // (the last matched node = bot's current position) so the first edge
    // (bot→destination) is included in the flatness check. This prevents
    // sprinting over step-ups: if bot→pathIdx has dy≠0, countStraightRun
    // returns 0 and we fall through to liveStep which handles it.
    if (pathIdx > 0) {
      const runStart = pathIdx - 1
      const runLen = countStraightRun(path, runStart)
      if (runLen >= 3) {
        const ok = await sprintRun(bot, path, runStart, runLen)
        pathIdx = runStart + runLen
        if (ok) lastProgress = Date.now()
        if (!ok) return false
        continue
      }
    }

    const next = path[pathIdx]
    const dx = Math.sign(next.x - cx)
    const dz = Math.sign(next.z - cz)

    // If we need to go diagonally, take the bigger axis first
    let stepDx = 0, stepDz = 0
    if (dx !== 0 && dz !== 0) {
      if (Math.abs(next.x - cx) >= Math.abs(next.z - cz)) stepDx = dx
      else stepDz = dz
    } else {
      stepDx = dx; stepDz = dz
    }

    if (stepDx === 0 && stepDz === 0) {
      console.log(`  [followPath] skip node ${pathIdx}: same XZ (${next.x},${next.y},${next.z}) bot at ${cx},${cy},${cz}`)
      pathIdx++
      continue
    }

    const result = await liveStep(bot, stepDx, stepDz, { mode: getMode() })
    if (result.ok) lastProgress = Date.now()
    if (!result.ok) {
      // Don't abort the whole path for a 1-block overshoot — check if bot
      // is still roughly on track (within 2 blocks of the planned node)
      const fp = bot.entity.position
      const offX = Math.abs(Math.floor(fp.x) - next.x)
      const offZ = Math.abs(Math.floor(fp.z) - next.z)
      if (offX <= 2 && offZ <= 2) {
        console.log(`  [followPath] step ${pathIdx} overshot (off ${offX},${offZ}), continuing`)
        // Re-sync pathIdx to closest node from current position
        continue
      }
      console.log(`  [followPath] step ${pathIdx} failed badly (off ${offX},${offZ}), aborting`)
      return false
    }
  }

  // Check if we ended at the target block
  const fp = bot.entity.position
  if (Math.floor(fp.x) === target.x && Math.floor(fp.z) === target.z) return true
  console.log(`  [followPath] exhausted step budget`)
  return false
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { canFlatStep, canStepUp, canStepDown, getNeighbors, hasFloor, isSafe, liveStep, followPath, dbPlanPath, dbCanFlat, dbCanUp, dbCanDown, dbBlock, centerInBlock }
