// Navigation system — layered planner + movement primitives
// Layer 1: guard checks (abort, hostiles, health) at every step
// Layer 2: planner decides HOW to reach target (walk, dig, staircase)
// Layer 3: primitives execute one small step
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const state = require('../core/state')
const { tickWait, AbortError, sleep, raceAbort } = require('../core/tick')
const { castVisionRays, TRANSPARENT, PASSABLE, HAZARDS } = require('../perception/vision')
const { isPlaceable, WATER_BLOCKS, STRUCTURAL_AIR } = require('../config/blocks')
const { surveyForNav } = require('../perception/visibility')
const { removeBlock, trackPathBlock, isPathBlock, logGameEvent } = require('../world/memory')
const { liveStep, followPath, dbBlock, centerInBlock } = require('./atomicSteps')
const { preCheck } = require('../engine/guard')
const { c, color } = require('../lib/colors')
const { sendChat, debugChat } = require('../core/utils')
// Extracted planner/query/goal/reachability modules (see REFACTORING.md §1)
const { _pHazard, _pSurface, _pKnownSolid, _pKnownClear } = require('./blockquery')
const { dbAstar, planFromHere, _pNeighbors } = require('./pathplanner')
const { reachGoal, headingGoal, until } = require('./goals')
const { _getReachVec, _reachCheck, _digToward } = require('./reachability')

// Summarize tool/material state for failure reasons visible to the AI
function getToolSummary(bot) {
  const items = bot.inventory.items()
  const picks = items.filter(i => i.name.includes('pickaxe')).map(i => i.name)
  const parts = []
  if (picks.length > 0) {
    parts.push(`picks: ${picks.join(',')}`)
  } else {
    parts.push('NO pickaxe')
  }
  const mats = {}
  for (const i of items) {
    if (i.name === 'cobblestone' || i.name === 'cobbled_deepslate' || i.name.includes('_planks') ||
        i.name.includes('_log') || i.name === 'stick' || i.name === 'iron_ingot' ||
        i.name === 'crafting_table' || i.name === 'diamond') {
      mats[i.name] = (mats[i.name] || 0) + i.count
    }
  }
  const matStr = Object.entries(mats).map(([n, c]) => `${c} ${n}`).join(', ')
  if (matStr) parts.push(`have: ${matStr}`)
  return parts.length > 0 ? ` (${parts.join('; ')})` : ''
}

// Blocks that are painfully slow to mine without a pickaxe
const HARD_BLOCKS = new Set([
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate',
  'granite', 'diorite', 'andesite', 'tuff', 'calcite',
  'obsidian', 'netherrack', 'basalt', 'blackstone',
  'sandstone', 'red_sandstone', 'smooth_stone', 'bricks',
  'mossy_cobblestone', 'smooth_basalt',
])

// ─── Movement Primitives ───────────────────────────────────────────
// All movement goes through liveStep (from atomicSteps.js).
// walkTo and walkForward have been removed — no mineflayer pathfinder.

// Safety mode for liveStep/digBlock/hasWalkableLOS.
// state.navSafetyMode is set by navigateTo from opts.mode ('safe'/'water'/'hazard').
// If bot is currently IN water, upgrade to at least 'water' so it can escape.
function navMode() {
  const base = state.navSafetyMode || 'safe'
  if (base === 'hazard') return 'hazard'
  if (base === 'water' || state.bot?.entity?.isInWater) return 'water'
  return 'safe'
}

// Clear all transient nav state in one place. navigateTo calls this from a
// `finally`, so every exit path (arrival, timeout, abort, thrown error) leaves
// clean state — abort paths used to leak navSafetyMode/navFistMining through 7
// scattered partial clears that didn't all reset every field.
function clearNavState() {
  state.navigationStatus = null
  state.navSafetyMode = null
  state.navFistMining = false
}

// Dig a single block safely — checks neighbors for hazards first
async function digBlock(pos, opts = {}) {
  const bot = state.bot
  const b = bot.blockAt(pos)
  if (!b || !b.diggable || STRUCTURAL_AIR.has(b.name)) return false

  // Protect blueprint-placed blocks from being destroyed by navigation
  if (!opts.ignorePlacedBlocks && state.stmts.isPlaced && state.stmts.isPlaced.get(pos.x, pos.y, pos.z)) {
    console.log(`  digBlock: placed block (blueprint) at ${pos.x},${pos.y},${pos.z}, skipping`)
    return false
  }

  // Protect path blocks (staircases, tunnels) from being destroyed
  if (!opts.ignorePathBlocks && isPathBlock(pos.x, pos.y, pos.z)) {
    console.log(`  digBlock: path block at ${pos.x},${pos.y},${pos.z}, skipping`)
    return false
  }

  // Check adjacent blocks for hazards before digging
  const mode = navMode()
  if (!opts.allowHazards && mode !== 'hazard') {
    const neighbors = [
      pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
      pos.offset(0, 0, 1), pos.offset(0, 0, -1),
      pos.offset(0, 1, 0),
    ]
    for (const np of neighbors) {
      const nb = bot.blockAt(np)
      if (!nb) continue
      if (nb.name === 'lava') {
        console.log(`  digBlock: lava adjacent at ${np}, skipping`)
        return false
      }
      if (mode === 'safe' && WATER_BLOCKS.has(nb.name)) {
        console.log(`  digBlock: water adjacent at ${np}, skipping`)
        return false
      }
    }
  }

  try {
    await bot.tool.equipForBlock(b).catch(() => {})
    // Detect fist-mining on hard blocks (stone, ores, deepslate, etc.)
    const held = bot.heldItem
    if (!held || !held.name.includes('pickaxe')) {
      if (HARD_BLOCKS.has(b.name) || b.name.includes('_ore')) {
        state.navFistMining = true
      }
    }
    // raceAbort: bot.dig waits for the server's block-break confirmation and can
    // hang forever if the bot is pushed out of reach mid-dig (common underwater),
    // never resolving and never observing abortSignal. A bare await here wedged
    // the whole nav coroutine — and since nav holds the single background-task
    // slot, every queued action (including 'stop') stalled behind it: the
    // "staircase deadlock". Bound it by timeout + abort, like mining.js does.
    await raceAbort(bot.dig(b), 30000)
    removeBlock(pos.x, pos.y, pos.z)
    // Record the now-open cell in the honest DB as its true post-dig block
    // (air/cave_air, or water if it flowed in). removeBlock only DELETES the row,
    // which leaves the cell "unknown" — and the STRICT liveStep refuses to enter
    // unknown cells (dbCanUp/dbCanFlat reject on dbUnknown). That made staircase
    // and tunnel dig a step and then immediately bail with "liveStep blocked",
    // unable to see that the space they just dug is open. We're adjacent and
    // looking at it, so this write is LOS-honest.
    try {
      const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z)
      const after = bot.blockAt(pos)
      state.stmts.upsertBlock.run(bx, by, bz, after ? after.name : 'cave_air', state.bot.time?.age || 0)
    } catch (e) { /* DB write is best-effort; next survey will correct it */ }
    logGameEvent('mine', b.name, 1, pos.x, pos.y, pos.z, { tool: bot.heldItem?.name || 'hand', reason: opts.reason || 'navigation' })
    return true
  } catch (e) {
    console.log(`  digBlock err at ${pos}: ${e.message}`)
    return false
  }
}

// Place a block against refBlock's face, robust to mineflayer's "Event
// blockUpdate ... did not fire within timeout of 5000ms" — which it raises even
// when the server DID place the block (missing/late confirmation packet).
// Routing placeBlock through raceAbort (a 10s timer layered over placeBlock's
// own 5s blockUpdate wait) both leaked that rejection as an UNHANDLED rejection
// and misreported real placements as failures (the staircase "couldn't place
// step" bug). Here we await placeBlock in a single try/catch frame so the
// rejection is always consumed (placeBlock self-times-out at ~5s, so no hang),
// then VERIFY against the live world. On success we also record the block in the
// honest DB — same reason as digBlock: otherwise the placed step stays "unknown"
// and the STRICT liveStep (dbCanUp's dbSolid check) refuses to climb onto it.
// Returns true iff the cell is solid afterward.
async function safePlace(bot, refBlock, faceVec, placePos) {
  try {
    await bot.placeBlock(refBlock, faceVec)
  } catch (e) { /* verify via world state below — covers the blockUpdate timeout */ }
  let after = null
  try { after = bot.blockAt(placePos) } catch (e) {}
  const ok = !!(after && !PASSABLE.has(after.name))
  if (ok) {
    try {
      state.stmts.upsertBlock.run(Math.floor(placePos.x), Math.floor(placePos.y), Math.floor(placePos.z), after.name, state.bot.time?.age || 0)
    } catch (e) { /* best-effort DB write; next survey corrects it */ }
  }
  return ok
}

// ─── LOS & Waypoint Finding ────────────────────────────────────────

// Check if there's a walkable path between two points (no solid blocks in the way)
function hasWalkableLOS(from, to) {
  const bot = state.bot
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist < 1) return true
  const steps = Math.ceil(dist * 2)
  const sx = dx / steps, sy = dy / steps, sz = dz / steps
  let lastBx = null, lastBy = null, lastBz = null

  for (let i = 1; i < steps; i++) {
    const bx = Math.floor(from.x + sx * i)
    const by = Math.floor(from.y + sy * i)
    const bz = Math.floor(from.z + sz * i)
    if (bx === lastBx && by === lastBy && bz === lastBz) continue
    lastBx = bx; lastBy = by; lastBz = bz

    try {
      // Check foot and head level
      const foot = bot.blockAt(new Vec3(bx, by, bz))
      const head = bot.blockAt(new Vec3(bx, by + 1, bz))
      if (!foot || !head) return false
      if (!PASSABLE.has(foot.name) && !TRANSPARENT.has(foot.name)) return false
      if (!PASSABLE.has(head.name) && !TRANSPARENT.has(head.name)) return false
      // Check for hazards at foot level
      const ground = bot.blockAt(new Vec3(bx, by - 1, bz))
      if (!ground) return false
      if (navMode() === 'safe' && (HAZARDS.has(foot.name) || HAZARDS.has(ground.name))) return false
      // Check ground exists (no bottomless pits)
      if (PASSABLE.has(ground.name) || TRANSPARENT.has(ground.name)) {
        const below2 = bot.blockAt(new Vec3(bx, by - 2, bz))
        if (below2 && (PASSABLE.has(below2.name) || TRANSPARENT.has(below2.name))) {
          // 2+ block drop, not walkable LOS
          return false
        }
      }
    } catch (e) { return false }
  }
  return true
}

// Internal sub-goal helper for cardinalWalk (NOT a cascade strategy). Picks the
// best intermediate sub-goal toward target from the honest `blocks` DB (LOS-seen,
// fed by the omni surveyForNav) — NOT the old angular castVisionRays. Returns a
// known-walkable Vec3 cell meaningfully closer to the target, or null.
// Precondition: caller has just run surveyForNav, so the DB reflects surroundings.
function findWaypoint(target) {
  const bot = state.bot
  const pos = bot.entity.position
  const px = Math.floor(pos.x), py = Math.round(pos.y), pz = Math.floor(pos.z)
  const targetDist = pos.distanceTo(target)

  const R = 16        // horizontal search radius (blocks)
  const YBAND = 3     // vertical band around current Y
  let bestPos = null
  let bestScore = -Infinity

  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const horiz = Math.sqrt(dx * dx + dz * dz)
      if (horiz < 3 || horiz > R) continue   // must be a real, in-range move
      for (let dy = -YBAND; dy <= YBAND; dy++) {
        const x = px + dx, y = py + dy, z = pz + dz
        // Known-walkable: foot+head known-clear, known floor below, no hazards.
        if (!_pKnownClear(x, y, z) || !_pKnownClear(x, y + 1, z)) continue
        if (!(_pKnownSolid(x, y - 1, z) || _pSurface(x, y, z))) continue
        if (_pHazard(x, y, z) || _pHazard(x, y - 1, z)) continue

        const cell = new Vec3(x + 0.5, y, z + 0.5)
        const cellToTarget = cell.distanceTo(target)
        if (cellToTarget >= targetDist - 1) continue   // must make progress

        // Prefer cells closer to target, with a mild pull toward longer reaches.
        const score = (targetDist - cellToTarget) * 2 + horiz
        if (score > bestScore) { bestScore = score; bestPos = cell }
      }
    }
  }

  return bestPos
}

// ─── Digging Strategies ────────────────────────────────────────────

// Dig ONE step of a tunnel toward target. Returns to planner after each step.
// Never digs straight down (block bot is standing on).
async function tunnelStep(tx, ty, tz, ctx = {}) {
  const bot = state.bot
  // Water: don't skip — navMode() allows water steps when bot is in water

  const cur = bot.entity.position
  const dx = tx - cur.x, dy = ty - cur.y, dz = tz - cur.z
  const horizDist = Math.sqrt(dx * dx + dz * dz)

  // Block coordinates — Math.floor, not Math.round
  const cx = Math.floor(cur.x), cy = Math.round(cur.y), cz = Math.floor(cur.z)

  // Decide direction + vertical intent.
  let stepY = 0, sx = 0, sz = 0
  const goal = ctx.goal
  const heading = goal && goal.kind === 'heading'
  if (heading) {
    // ── Heading mode (directional, predicate-terminated goal) ───────
    // Direction was COMMITTED once by the goal and is simply FOLLOWED here — no
    // per-step re-derivation from a target XZ, so the heading can't flip sign or
    // reverse. A directional tunnel stays at one Y level (flat); the DRIVER
    // decides when to stop (goal.until, e.g. a wall ahead or open sky).
    sx = goal.dir[0]; sz = goal.dir[1]
  } else {
    // ── Coordinate mode: derive heading + vertical intent from the target ──
    if (dy > 2) stepY = 1
    else if (dy < -2) stepY = -1

    // Primary horizontal direction — only if there's meaningful horizontal distance
    if (horizDist > 1.5) {
      if (Math.abs(dx) >= Math.abs(dz)) sx = dx > 0 ? 1 : -1
      else sz = dz > 0 ? 1 : -1
    } else if (stepY === 0) {
      // Very close horizontally, no vertical diff — just pick the bigger axis
      if (Math.abs(dx) >= Math.abs(dz)) sx = dx > 0 ? 1 : -1
      else sz = dz > 0 ? 1 : -1
    }
    // else: primarily vertical movement, sx=sz=0
  }

  // Purely vertical (target directly above/below) — use staircase pattern
  if (sx === 0 && sz === 0 && stepY !== 0) {
    // Pick a horizontal direction to dig into (can't dig straight down safely)
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]]
    for (const [ddx, ddz] of dirs) {
      const fb = bot.blockAt(new Vec3(cx + ddx, cy + (stepY < 0 ? -1 : 0), cz + ddz))
      if (fb && !TRANSPARENT.has(fb.name)) { sx = ddx; sz = ddz; break }
    }
    if (sx === 0 && sz === 0) { sx = 1 }  // fallback
  }

  const tgtDesc = heading ? `heading (${sx},${sz})` : `target=${tx},${ty},${tz}`
  console.log(`  tunnelStep: pos=${Math.round(cur.x)},${cy},${Math.round(cur.z)} → dir=(${sx},${stepY},${sz}) ${tgtDesc}`)

  // Check for floating (no ground anywhere ahead)
  const belowBlock = bot.blockAt(new Vec3(cx, cy - 1, cz))
  const fwdFoot = bot.blockAt(new Vec3(cx + sx, cy, cz + sz))
  const fwdHead = bot.blockAt(new Vec3(cx + sx, cy + 1, cz + sz))
  const fwdBelow = bot.blockAt(new Vec3(cx + sx, cy - 1, cz + sz))
  const isFloating = belowBlock && TRANSPARENT.has(belowBlock.name)
    && fwdFoot && TRANSPARENT.has(fwdFoot.name)
    && fwdHead && TRANSPARENT.has(fwdHead.name)
    && fwdBelow && TRANSPARENT.has(fwdBelow.name)
  if (isFloating) {
    console.log('  tunnelStep: floating, waiting to land')
    bot.clearControlStates()
    await sleep(500)
    return false
  }

  const ny = cy + stepY

  // Dig the 2-3 blocks ahead
  if (stepY > 0) {
    // Going up: dig ceiling, then ahead at new height
    await digBlock(new Vec3(cx, cy + 2, cz))
    await digBlock(new Vec3(cx + sx, ny, cz + sz))
    await digBlock(new Vec3(cx + sx, ny + 1, cz + sz))
  } else if (stepY < 0) {
    // Going down: dig forward-and-down staircase
    await digBlock(new Vec3(cx + sx, ny, cz + sz))
    await digBlock(new Vec3(cx + sx, ny + 1, cz + sz))
    // Also clear head space at current level
    await digBlock(new Vec3(cx + sx, ny + 2, cz + sz))
  } else {
    // Level: dig foot and head ahead
    await digBlock(new Vec3(cx + sx, cy, cz + sz))
    await digBlock(new Vec3(cx + sx, cy + 1, cz + sz))
  }

  // Center on the perpendicular axis before stepping into the freshly-dug tunnel.
  // The tunnel is 1-wide, so its side blocks are solid walls — an off-center hitbox
  // would clip them. Replaces the old corner-dig hack, which widened the tunnel
  // (destroying extra blocks) instead of just centering the bot.
  if (state.abortSignal) return false
  await centerInBlock(bot, { axis: sx !== 0 ? 'z' : 'x' })

  // Walk forward into the cleared space
  if (state.abortSignal) return false

  if (stepY > 0) {
    // Check floor ahead exists for jumping up
    const floorAhead = bot.blockAt(new Vec3(cx + sx, cy, cz + sz))
    if (!floorAhead || TRANSPARENT.has(floorAhead.name)) {
      console.log('  tunnelStep: no floor ahead for up-step, going level instead')
      stepY = 0
    }
  }

  const mode = navMode()
  const stepResult = await liveStep(bot, sx, sz, { mode })
  if (!stepResult.ok) { console.log(`  tunnelStep: liveStep blocked (${stepResult.type})`); return false }

  // Record floor block as path
  const afterPos = bot.entity.position
  const fx = Math.floor(afterPos.x), fy = Math.round(afterPos.y) - 1, fz = Math.floor(afterPos.z)
  trackPathBlock(fx, fy, fz, 'tunnel')
  if (heading) ctx.advanced = (ctx.advanced || 0) + 1  // heading-goal progress
  return true
}

// Dig staircase: one step up or down toward target Y.
// Never digs the block the bot is standing on.
async function staircaseStep(tx, ty, tz, ctx = {}) {
  const bot = state.bot
  // Water: don't skip — navMode() allows water steps when bot is in water

  const cur = bot.entity.position
  const curY = Math.round(cur.y)
  let needUp, needDown, stepX = 0, stepZ = 0

  const goal = ctx.goal
  if (goal && goal.kind === 'heading') {
    // ── Heading mode (directional, predicate-terminated goal) ───────
    // Direction + up/down pattern were COMMITTED once by the goal and are simply
    // FOLLOWED here — no per-step re-derivation from a target XZ, so there is no
    // overshoot and no 180° reversal. The DRIVER decides when to stop (goal.until,
    // e.g. y<=30 or a wall ahead); this step just keeps cutting the staircase.
    stepX = goal.dir[0]; stepZ = goal.dir[1]
    needUp = goal.pattern === 'up'
    needDown = goal.pattern === 'down'
    if (!needUp && !needDown) return false  // a heading staircase must ascend or descend
    ctx.lastStairDir = [stepX, stepZ]
  } else {
    // ── Coordinate mode (reach a target Y) ──────────────────────────
    needUp = ty > curY
    needDown = ty < curY
    if (!needUp && !needDown) return false // already at target Y

    // Pick direction toward target, but NEVER reverse 180° — that would dig
    // through the staircase we just built. If the target flips to the opposite
    // direction, offset sideways (turn 90°) first to avoid destroying our steps.
    const dx0 = tx - cur.x, dz0 = tz - cur.z
    const dist0 = Math.sqrt(dx0 * dx0 + dz0 * dz0)

    // Compute the "ideal" direction toward target
    let idealX = 0, idealZ = 0
    if (Math.abs(dx0) >= Math.abs(dz0)) idealX = dx0 > 0 ? 1 : -1
    else idealZ = dz0 > 0 ? 1 : -1

    if (ctx.lastStairDir) {
      const lastX = ctx.lastStairDir[0], lastZ = ctx.lastStairDir[1]
      // Check if ideal direction is a 180° reversal of last direction
      const isReverse = (idealX === -lastX && idealX !== 0) || (idealZ === -lastZ && idealZ !== 0)
      if (isReverse) {
        // Turn 90° instead of reversing — pick a perpendicular direction
        // If we were going along X, turn to Z axis (and vice versa)
        if (lastX !== 0) {
          // Was moving along X axis — turn to Z axis, pick side toward target
          stepX = 0
          stepZ = dz0 >= 0 ? 1 : -1
          if (stepZ === 0) stepZ = 1
        } else {
          // Was moving along Z axis — turn to X axis, pick side toward target
          stepZ = 0
          stepX = dx0 >= 0 ? 1 : -1
          if (stepX === 0) stepX = 1
        }
        console.log(`  stairDir: would reverse 180° — turning 90° instead (${lastX},${lastZ} → ${stepX},${stepZ})`)
      } else if (dist0 <= 3) {
        // Close to target X/Z — keep same direction to avoid zigzag
        stepX = lastX
        stepZ = lastZ
      } else {
        // Far enough and not reversing — go toward target
        stepX = idealX
        stepZ = idealZ
      }
    } else {
      // No last direction — pick ideal or fallback
      if (dist0 >= 1) {
        stepX = idealX
        stepZ = idealZ
      } else {
        stepX = 1
      }
    }
    ctx.lastStairDir = [stepX, stepZ]
  }

  const cx = Math.floor(cur.x), cz = Math.floor(cur.z)

  // Check for drops beyond the step in chosen direction (bot momentum can overshoot)
  // No solid-wall requirement — step placement code handles air steps
  const beyond = bot.blockAt(new Vec3(cx + stepX * 2, curY, cz + stepZ * 2))
  const beyondBelow = bot.blockAt(new Vec3(cx + stepX * 2, curY - 1, cz + stepZ * 2))
  if (beyond && TRANSPARENT.has(beyond.name) && beyondBelow && TRANSPARENT.has(beyondBelow.name)) {
    // Drop beyond step — try to place a safety block
    const placePos = new Vec3(cx + stepX * 2, curY, cz + stepZ * 2)
    const placeableSlot = bot.inventory.items().find(i => isPlaceable(i.name))
    if (placeableSlot) {
      const adjacents = [
        { pos: new Vec3(placePos.x, placePos.y - 1, placePos.z), face: new Vec3(0, 1, 0) },
        { pos: new Vec3(placePos.x - 1, placePos.y, placePos.z), face: new Vec3(1, 0, 0) },
        { pos: new Vec3(placePos.x + 1, placePos.y, placePos.z), face: new Vec3(-1, 0, 0) },
        { pos: new Vec3(placePos.x, placePos.y, placePos.z - 1), face: new Vec3(0, 0, 1) },
        { pos: new Vec3(placePos.x, placePos.y, placePos.z + 1), face: new Vec3(0, 0, -1) },
        { pos: new Vec3(placePos.x, placePos.y + 1, placePos.z), face: new Vec3(0, -1, 0) },
      ]
      await raceAbort(bot.equip(placeableSlot, 'hand'), 10000)
      for (const adj of adjacents) {
        const refBlock = bot.blockAt(adj.pos)
        if (refBlock && !TRANSPARENT.has(refBlock.name)) {
          await raceAbort(bot.lookAt(adj.pos.offset(0.5, 0.5, 0.5)), 10000).catch(() => {})
          if (await safePlace(bot, refBlock, adj.face, placePos)) {
            logGameEvent('place', placeableSlot.name, 1, placePos.x, placePos.y, placePos.z, { reason: 'staircase' })
            console.log(`  stairUp: placed safety block at ${placePos}`)
            break
          }
        }
      }
    }
  }

  if (needUp) {
    // Traditional staircase up: the block ahead at feet level is the step.
    // Dig above head for jump room, dig ahead at +1 and +2 for body space,
    // keep ahead at +0 solid as the step, then jump-walk onto it.
    const beforeY = bot.entity.position.y

    // Ensure current body space is clear (might be stuck in stone)
    await digBlock(new Vec3(cx, curY, cz))
    await digBlock(new Vec3(cx, curY + 1, cz))
    if (state.abortSignal) return false

    // Check if step block ahead is solid; if not, place one
    const stepPos = new Vec3(cx + stepX, curY, cz + stepZ)
    const stepBlock = bot.blockAt(stepPos)
    if (!stepBlock || TRANSPARENT.has(stepBlock.name)) {
      const placeableSlot = bot.inventory.items().find(i => isPlaceable(i.name))
      if (!placeableSlot) {
        console.log('  stairUp: no blocks for step')
        return false
      }
      await raceAbort(bot.equip(placeableSlot, 'hand'), 10000)
      // Try all 6 adjacent blocks as placement reference
      const adjacents = [
        { pos: new Vec3(cx + stepX, curY - 1, cz + stepZ), face: new Vec3(0, 1, 0) },  // below
        { pos: new Vec3(cx + stepX, curY + 1, cz + stepZ), face: new Vec3(0, -1, 0) }, // above
        { pos: new Vec3(cx + stepX - 1, curY, cz + stepZ), face: new Vec3(1, 0, 0) },  // -X side
        { pos: new Vec3(cx + stepX + 1, curY, cz + stepZ), face: new Vec3(-1, 0, 0) }, // +X side
        { pos: new Vec3(cx + stepX, curY, cz + stepZ - 1), face: new Vec3(0, 0, 1) },  // -Z side
        { pos: new Vec3(cx + stepX, curY, cz + stepZ + 1), face: new Vec3(0, 0, -1) }, // +Z side
      ]
      let placed = false
      for (const adj of adjacents) {
        const refBlock = bot.blockAt(adj.pos)
        if (refBlock && !TRANSPARENT.has(refBlock.name)) {
          await raceAbort(bot.lookAt(adj.pos.offset(0.5, 0.5, 0.5)), 10000).catch(() => {})
          if (await safePlace(bot, refBlock, adj.face, stepPos)) {
            logGameEvent('place', placeableSlot.name, 1, cx + stepX, curY, cz + stepZ, { reason: 'staircase' })
            console.log(`  stairUp: placed step at ${cx + stepX},${curY},${cz + stepZ} (ref=${refBlock.name}@${adj.pos.x},${adj.pos.y},${adj.pos.z})`)
            placed = true
            break
          }
        }
      }
      if (!placed) {
        console.log(`  stairUp: couldn't place step (no solid adjacent blocks)`)
        return false
      }
    }

    // Dig space for body at +1 level ahead (feet after stepping up)
    await digBlock(new Vec3(cx + stepX, curY + 1, cz + stepZ))
    // Dig space for head at +2 level ahead
    await digBlock(new Vec3(cx + stepX, curY + 2, cz + stepZ))
    // Dig above head at current pos for jump clearance
    await digBlock(new Vec3(cx, curY + 2, cz))
    if (state.abortSignal) return false

    // Reveal the step cells before the STRICT liveStep — an unsurveyed (unknown)
    // step block makes dbCanUp reject the climb even when the step is really there.
    if (dbBlock(cx + stepX, curY, cz + stepZ) === null ||
        dbBlock(cx + stepX, curY + 1, cz + stepZ) === null) {
      surveyForNav({ maxDistance: 16 })
    }

    // Step up using liveStep (handles walk-into-wall + jump + landing verification)
    const upMode = navMode()
    const upResult = await liveStep(bot, stepX, stepZ, { mode: upMode })
    if (!upResult.ok) {
      console.log(`  stairUp: liveStep failed (${upResult.type})`)
      return false
    }
    bot.clearControlStates()
    await sleep(150) // let physics settle

    const afterY = Math.round(bot.entity.position.y)
    const landPos = bot.entity.position
    console.log(`  stairUp: Y ${Math.round(beforeY)}→${afterY} ground=${bot.entity.onGround} pos=${landPos.x.toFixed(1)},${landPos.y.toFixed(1)},${landPos.z.toFixed(1)}`)

    if (afterY <= Math.round(beforeY)) return false
    ctx.advanced = (ctx.advanced || 0) + 1  // real ascent — heading-goal progress
  } else {
    // Going down — proper descending staircase: dig the block one ahead and one below,
    // plus head clearance. Bot walks forward and drops 1 block onto the new floor.
    // This creates a step pattern that can be climbed back up by jumping.
    //
    //  Before:     After (side view, going right):
    //  [B]##       [B]__
    //  ####         #[B]__    <- bot drops 1 block
    //  ####          ####
    //
    // Dig forward-and-below (the new floor level)
    await digBlock(new Vec3(cx + stepX, curY - 1, cz + stepZ))
    // Dig forward at current level (body space to walk into)
    await digBlock(new Vec3(cx + stepX, curY, cz + stepZ))
    // Dig forward-and-above for head clearance while walking in
    await digBlock(new Vec3(cx + stepX, curY + 1, cz + stepZ))

    if (state.abortSignal) return false

    // Check for hazards below the new floor
    if (navMode() === 'safe') {
      const below2 = bot.blockAt(new Vec3(cx + stepX, curY - 2, cz + stepZ))
      if (below2 && HAZARDS.has(below2.name)) {
        console.log('  staircaseDown: hazard below, aborting')
        return false
      }
    }
    // Check the new floor exists (don't drop into a void)
    const newFloor = bot.blockAt(new Vec3(cx + stepX, curY - 2, cz + stepZ))
    if (newFloor && TRANSPARENT.has(newFloor.name)) {
      // No solid floor 2 below — check 3 below
      const below3 = bot.blockAt(new Vec3(cx + stepX, curY - 3, cz + stepZ))
      if (!below3 || TRANSPARENT.has(below3.name)) {
        console.log('  staircaseDown: no floor below, too deep to drop')
        return false
      }
    }

    // Reveal the landing cells before the STRICT liveStep. We just dug the body
    // space, but the floor the bot DROPS ONTO (curY-2 and below) was never
    // surveyed, so the DB has it as "unknown" — and dbCanDown rejects unknown,
    // making a perfectly good drop "block" on a phantom (the old staircase-stuck
    // bug). We're adjacent and looking into the freshly-dug opening, so an omni
    // survey here is LOS-honest. (cardinalWalk does the same — see ~line 1211.)
    if (dbBlock(cx + stepX, curY - 1, cz + stepZ) === null ||
        dbBlock(cx + stepX, curY - 2, cz + stepZ) === null ||
        dbBlock(cx + stepX, curY - 3, cz + stepZ) === null) {
      surveyForNav({ maxDistance: 16 })
    }

    // Step forward into the gap — bot drops 1 block
    const downMode = navMode()
    const downStep = await liveStep(bot, stepX, stepZ, { mode: downMode })
    if (!downStep.ok) { console.log('  staircaseDown: liveStep blocked'); return false }
    await sleep(200) // let physics settle after drop

    const afterY = Math.round(bot.entity.position.y)
    console.log(`  staircaseDown: Y ${curY}→${afterY} pos=${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`)
    if (afterY < curY) ctx.advanced = (ctx.advanced || 0) + 1  // real descent — heading-goal progress
  }

  // Record step block and floor support as path blocks
  const ap = bot.entity.position
  const sx2 = Math.floor(ap.x), sy2 = Math.round(ap.y), sz2 = Math.floor(ap.z)
  trackPathBlock(sx2, sy2 - 1, sz2, 'staircase')  // floor under feet
  trackPathBlock(sx2, sy2, sz2, 'staircase')        // feet level (the step itself)

  return true
}

// ─── Pillar Up ───────────────────────────────────────────────────

// Tower up: jump + place block under self, repeat. For gaining height on the surface.
async function pillarUp(targetY, maxBlocks = 5) {
  const bot = state.bot
  let blocksPlaced = 0

  for (let i = 0; i < maxBlocks; i++) {
    if (Math.round(bot.entity.position.y) >= targetY) break

    // Find placeable block in inventory
    const slot = bot.inventory.items().find(it => isPlaceable(it.name))
    if (!slot) {
      console.log('  pillarUp: no placeable blocks left')
      break
    }

    // Check for ceiling before jumping — dig if blocked
    const headY = Math.floor(bot.entity.position.y) + 2
    const ceilPos = new Vec3(Math.floor(bot.entity.position.x), headY, Math.floor(bot.entity.position.z))
    const ceiling = bot.blockAt(ceilPos)
    if (ceiling && !PASSABLE.has(ceiling.name) && !TRANSPARENT.has(ceiling.name)) {
      console.log(`  pillarUp: ceiling ${ceiling.name} at Y=${headY}, digging`)
      const dug = await digBlock(ceilPos, { reason: 'pillar_clearance' })
      if (!dug) { console.log('  pillarUp: can\'t clear ceiling'); break }
    }

    await raceAbort(bot.equip(slot, 'hand'), 10000)

    // Record the Y we're standing on — we need to place at this Y
    const startY = Math.floor(bot.entity.position.y)
    const bx = Math.floor(bot.entity.position.x)
    const bz = Math.floor(bot.entity.position.z)
    const groundPos = new Vec3(bx, startY - 1, bz)
    const groundBlock = bot.blockAt(groundPos)
    if (!groundBlock || PASSABLE.has(groundBlock.name)) {
      console.log('  pillarUp: no solid ground to pillar from')
      break
    }

    // Look straight down before jumping
    await bot.look(bot.entity.yaw, Math.PI / 2, true) // pitch=90° = straight down

    // Jump and wait until we're above our starting Y
    bot.setControlState('jump', true)
    let atPeak = false
    for (let w = 0; w < 10; w++) {
      await sleep(50)
      if (bot.entity.position.y >= startY + 0.8) { atPeak = true; break }
    }

    if (!atPeak) {
      bot.setControlState('jump', false)
      await sleep(300)
      continue
    }

    // Place block at startY (on top of ground block) using the ground as reference
    try {
      const ref = bot.blockAt(groundPos)
      if (ref && !PASSABLE.has(ref.name)) {
        await raceAbort(bot.placeBlock(ref, new Vec3(0, 1, 0)), 10000)
        blocksPlaced++
        trackPathBlock(bx, startY, bz, 'pillar')
        logGameEvent('place', slot.name, 1, bx, startY, bz, { reason: 'pillar' })
      }
    } catch (e) {
      // If blockUpdate timeout, check if block was actually placed
      const placed = bot.blockAt(new Vec3(bx, startY, bz))
      if (placed && !PASSABLE.has(placed.name) && placed.name !== groundBlock.name) {
        blocksPlaced++ // block placed despite timeout
        trackPathBlock(bx, startY, bz, 'pillar')
      } else {
        console.log(`  pillarUp: place failed: ${e.message}`)
      }
    }

    bot.setControlState('jump', false)
    await sleep(400) // wait to land on placed block

    if (state.abortSignal) break
  }

  console.log(`  pillarUp: placed ${blocksPlaced} blocks, Y now ${Math.round(bot.entity.position.y)}`)
  return blocksPlaced > 0
}

// ─── Environment Detection ────────────────────────────────────────

// Detect if bot is underground using vision rays (ceiling + no sky)
function isUnderground() {
  const v = castVisionRays(8, 16, 'reach')
  return v && !v.skyVisible && v.ceilingAbove > 0 && v.ceilingAbove < 30
}

// Execute dbPathfind strategy: compute path, walk to next waypoint
async function execDbPathfind(tx, ty, tz, range, ctx = {}) {
  const bot = state.bot
  const pos = bot.entity.position
  const sx = Math.floor(pos.x), sy = Math.round(pos.y), sz = Math.floor(pos.z)

  // Check cache (cross-step state lives on the driver-owned ctx)
  if (ctx.dbPath && ctx.dbPath.target === `${tx},${ty},${tz}`) {
    const age = Date.now() - ctx.dbPath.time
    const pathDist = pos.distanceTo(new Vec3(ctx.dbPath.path[ctx.dbPath.idx].x, ctx.dbPath.path[ctx.dbPath.idx].y, ctx.dbPath.path[ctx.dbPath.idx].z))
    if (age > 10000 || pathDist > 5) ctx.dbPath = null // stale or diverged
  }

  let path, idx
  if (ctx.dbPath && ctx.dbPath.target === `${tx},${ty},${tz}`) {
    path = ctx.dbPath.path
    idx = ctx.dbPath.idx
  } else {
    path = dbAstar(sx, sy, sz, tx, ty, tz)
    if (!path || path.length < 2) return false
    idx = 0
    ctx.dbPath = { path, idx, target: `${tx},${ty},${tz}`, time: Date.now() }
  }

  // Advance idx to closest point on path to current position
  let bestDist = Infinity
  for (let i = idx; i < path.length; i++) {
    const d = pos.distanceTo(new Vec3(path[i].x + 0.5, path[i].y, path[i].z + 0.5))
    if (d < bestDist) { bestDist = d; idx = i }
    else break // path is sequential, stop once we start getting farther
  }

  // Follow path from current index using liveStep
  const subPath = path.slice(idx)
  const mode = navMode()
  console.log(`  nav: strategy=dbPathfind (step ${idx}/${path.length - 1}, following ${subPath.length} nodes)`)
  state.navigationStatus = `dbPathfind ${subPath.length} steps`
  const ok = await followPath(bot, subPath, { modeFunc: navMode })
  // Update path index to where we got
  const fp = bot.entity.position
  for (let i = idx; i < path.length; i++) {
    if (path[i].x === Math.floor(fp.x) && path[i].z === Math.floor(fp.z)) ctx.dbPath.idx = i
  }
  return ok
}

// ─── Cardinal Walk (optimistic-frontier A*) ───────────────────────
// Walk toward target along an optimistic plan. Bounded to `maxSteps` successful
// steps so control returns to the navigateTo cascade. Returns true if forward
// progress was made (cascade resets fail counts and calls us again).
async function cardinalWalk(tx, ty, tz, maxSteps = 15, range = 2) {
  const bot = state.bot
  const mode = navMode()
  const target = new Vec3(tx, ty, tz)
  const startDist = bot.entity.position.distanceTo(target)

  surveyForNav({ maxDistance: 32 })
  const avoid = new Set()
  // Effective goal the path + replans aim at: normally the real target, but when
  // there is no optimistic path to it, an intermediate sub-goal (the former
  // 'waypoint' cascade strategy, now an INTERNAL fallback — sub-goal selection
  // belongs inside the executor; only executor-cascading lives in navigateTo).
  // findWaypoint returns the best closer, known-reachable cell from the honest DB;
  // reaching it repositions the bot and reveals map, and the cascade re-attempts
  // the real target next round. Arrival/return still measure the real target,
  // which findWaypoint guarantees is farther than the sub-goal, so reaching the
  // sub-goal still scores as progress.
  let gx = tx, gy = ty, gz = tz
  let path = planFromHere(gx, gy, gz, mode, avoid)
  if (!path) {
    const sub = findWaypoint(target)
    if (!sub) { console.log(`  cardinalWalk: no optimistic path to ${tx},${ty},${tz} and no sub-goal`); return false }
    gx = Math.floor(sub.x); gy = Math.round(sub.y); gz = Math.floor(sub.z)
    console.log(`  cardinalWalk: no path to target → sub-goal ${gx},${gy},${gz}`)
    path = planFromHere(gx, gy, gz, mode, avoid)
    if (!path) { console.log(`  cardinalWalk: no path to sub-goal ${gx},${gy},${gz} either`); return false }
  }
  console.log(`  cardinalWalk: optimistic path ${path.length} nodes toward ${gx},${gy},${gz}`)

  let idx = 0, stepsDone = 0, replans = 0, sinceSurvey = 0
  // ── Backtracking + oscillation handling ─────────────────────────────────────
  // Every successful liveStep is an `ok`, so the failure-driven `avoid` below never
  // fires when the bot is merely circling: it steps into fog, the resurvey turns the
  // route ahead into a wall, and the replan routes it BACK through the just-vacated
  // cells (optimistically open again). Two complementary cures:
  //
  // (1) DEAD-END FILLING — proper backtracking. A cell is a confirmed dead end when
  //     every cardinal exit EXCEPT the one we arrived through is closed: a known
  //     wall/hazard or an already-blacklisted cell. (Fog counts as OPEN — the
  //     optimistic neighbour fn returns it — so we go look rather than blacklist
  //     prematurely.) Blacklist it ("never enter again"); the only move left is back
  //     the way we came, so a dead-end corridor peels inside-out, innermost cell
  //     first, until the bot pops out at a real junction. A junction is NEVER wrongly
  //     jailed: it keeps >1 non-arrival exit, so it can't meet the rule until all its
  //     branches are themselves dead — which is exactly when it should.
  //
  // (2) HEADWAY bail. Dead-end filling only peels ≤1-wide protrusions; a FAT pocket
  //     (a 2-D room whose every cell keeps ≥2 open neighbours) it can never seal.
  //     Catch that separately: reaching new ground or getting closer is progress;
  //     re-treading known cells without gaining for STALL_LIMIT arrivals ⇒ bail and
  //     let the nav cascade escalate (dig / staircase / give up).
  const seen = new Set()             // every distinct cell stood on this run (frontier)
  let bestDist = bot.entity.position.distanceTo(target)
  let stall = 0, lastCell = null, cameFrom = null
  const STALL_LIMIT = 6
  while (stepsDone < maxSteps) {
    if (state.abortSignal) break
    const pos = bot.entity.position
    const dist = pos.distanceTo(target)
    if (dist <= range + 0.5) return true

    const cx = Math.floor(pos.x), cy = Math.round(pos.y), cz = Math.floor(pos.z)
    const vk = `${cx},${cy},${cz}`
    if (vk !== lastCell) {             // a genuine arrival (loop also spins w/o moving)
      // (1) Dead-end filling — blacklist + retreat when the only opening is the way back.
      const back = cameFrom ? `${Math.sign(cameFrom.x - cx)},${Math.sign(cameFrom.z - cz)}` : null
      if (back && back !== '0,0') {
        const dirs = new Set()
        for (const n of _pNeighbors(cx, cy, cz, mode, avoid)) dirs.add(`${Math.sign(n.x - cx)},${Math.sign(n.z - cz)}`)
        dirs.delete(back)              // ignore the exit we came in through
        if (dirs.size === 0) {         // nothing else open ⇒ dead end
          avoid.add(vk)
          const np = planFromHere(gx, gy, gz, mode, avoid)
          if (!np) { console.log(`  cardinalWalk: dead end at ${vk}, region sealed → bailing`); break }
          console.log(`  cardinalWalk: dead end at ${vk} → blacklisted, backtracking`)
          path = np; idx = 0; lastCell = vk; cameFrom = null
          continue
        }
      }
      // (2) Headway — open-room oscillation safety (what dead-end filling can't seal).
      lastCell = vk
      const newCell = !seen.has(vk); seen.add(vk)
      const closer = dist < bestDist - 0.5; if (closer) bestDist = dist
      if (closer || newCell) stall = 0
      else if (++stall >= STALL_LIMIT) {
        console.log(`  cardinalWalk: no headway for ${STALL_LIMIT} moves (open-room oscillation), bailing at ${vk}`)
        break
      }
    }

    // advance past nodes already reached
    while (idx < path.length - 1) {
      const n = path[idx]
      if (n.x === cx && n.z === cz && Math.abs(n.y - cy) <= 1) { idx++; continue }
      break
    }
    if (idx >= path.length) break

    const next = path[idx]
    let dx = Math.sign(next.x - cx), dz = Math.sign(next.z - cz)
    if (dx !== 0 && dz !== 0) { if (Math.abs(next.x - cx) >= Math.abs(next.z - cz)) dz = 0; else dx = 0 }
    if (dx === 0 && dz === 0) { idx++; continue }
    const nx = cx + dx, nz = cz + dz

    // look-to-reveal: if the destination cell is unknown, omni-survey to make it
    // honest before the STRICT liveStep (which blocks on unknown). Omni needs no turn.
    if (dbBlock(nx, cy, nz) === null || dbBlock(nx, cy + 1, nz) === null || dbBlock(nx, cy - 1, nz) === null) {
      surveyForNav({ maxDistance: 18 })
    }

    const res = await liveStep(bot, dx, dz, { mode })
    if (res.ok) {
      stepsDone++
      cameFrom = { x: cx, y: cy, z: cz }   // the cell we just left → arrival dir at the next
      if (++sinceSurvey >= 4) {
        sinceSurvey = 0
        surveyForNav({ maxDistance: 28 })
        // a node still ahead turned out to be a real wall → replan
        let blockedAhead = false
        for (let i = idx; i < path.length; i++) {
          if (_pKnownSolid(path[i].x, path[i].y, path[i].z) || _pKnownSolid(path[i].x, path[i].y + 1, path[i].z)) { blockedAhead = true; break }
        }
        if (blockedAhead) {
          if (++replans > 6) break
          const np = planFromHere(gx, gy, gz, mode, avoid)
          if (!np) break
          path = np; idx = 0
        }
      }
      continue
    }

    // Step blocked. Resurvey; if the destination is now a real obstacle replan,
    // else it's unrevealable — avoid it so the next plan routes around.
    surveyForNav({ maxDistance: 20 })
    avoid.add(`${next.x},${next.y},${next.z}`)
    if (!_pKnownClear(nx, cy, nz) || !_pKnownClear(nx, cy + 1, nz)) avoid.add(`${nx},${cy},${nz}`)
    if (++replans > 6) { console.log(`  cardinalWalk: replan budget exhausted`); break }
    const np = planFromHere(gx, gy, gz, mode, avoid)
    if (!np) { console.log(`  cardinalWalk: boxed in after ${replans} replans`); break }
    path = np; idx = 0
  }

  const endDist = bot.entity.position.distanceTo(target)
  return endDist < startDist - 0.5
}

// ─── Hybrid Strategy ──────────────────────────────────────────────
// Plan path with our dbAstar (DB-only, no x-ray), execute movement
// with mineflayer-pathfinder's GoalNear (physics-aware, smooth).
// Pathfinder only reads blocks near the bot for local collision —
// the bot is physically there, so this is not x-ray.
async function execHybridPath(tx, ty, tz, range) {
  const bot = state.bot
  const pos = bot.entity.position
  const sx = Math.floor(pos.x), sy = Math.round(pos.y), sz = Math.floor(pos.z)

  // Plan with our A* (DB + vision, no x-ray)
  const path = dbAstar(sx, sy, sz, tx, ty, tz)
  if (!path || path.length < 2) return false

  // Pick waypoint ~8 steps ahead on the path
  const wpIdx = Math.min(8, path.length - 1)
  const wp = path[wpIdx]

  console.log(`  nav: strategy=hybridPath (${path.length} nodes, wp=${wp.x},${wp.y},${wp.z})`)
  state.navigationStatus = `hybridPath → ${wp.x},${wp.y},${wp.z}`

  // Execute with mineflayer pathfinder — smooth physics-aware movement
  const wpRange = Math.min(range, 2)
  bot.pathfinder.setGoal(new goals.GoalNear(wp.x, wp.y, wp.z, wpRange), true)

  const start = Date.now()
  let stuckCount = 0
  let lastPos = bot.entity.position.clone()

  while (true) {
    await bot.waitForTicks(10) // 0.5s between checks
    if (state.abortSignal) { try { bot.pathfinder.setGoal(null) } catch(e) {} return false }

    const curPos = bot.entity.position
    const curDist = curPos.distanceTo(new Vec3(wp.x, wp.y, wp.z))

    // Arrived at waypoint
    if (curDist <= wpRange + 0.5) {
      try { bot.pathfinder.setGoal(null) } catch(e) {}
      return true
    }

    // Timeout
    if (Date.now() - start > 8000) {
      try { bot.pathfinder.setGoal(null) } catch(e) {}
      return false
    }

    // Stuck detection
    const moved = curPos.distanceTo(lastPos)
    if (moved < 0.15) stuckCount++
    else stuckCount = 0
    lastPos = curPos.clone()
    if (stuckCount > 6) {
      try { bot.pathfinder.setGoal(null) } catch(e) {}
      return false
    }

    // Guard check
    const check = preCheck({ ignoreMsgs: true })
    if (check && (check.interrupt === 'hostile' || check.interrupt === 'drowning')) {
      try { bot.pathfinder.setGoal(null) } catch(e) {}
      return false
    }
  }
}

// Pick ordered list of strategies for a GENERAL (open-ended) navigation — no
// strategy was requested, so "get there however you can" applies and the cascade
// is the right behaviour. Explicit-strategy tasks do NOT come here: navigateTo
// dispatches those straight to runStrategy with no cascade (see navigateTo).
function pickStrategies(pos, target, failCounts) {
  const strategies = []
  const yDiff = Math.abs(target.y - Math.round(pos.y))
  const underground = isUnderground()

  // Walkable strategies first (free, no tools needed).
  // 1. Cardinal walk — greedy steps toward target + obstacle circling. Sets an
  //    internal sub-goal (findWaypoint) when it can't path to the target.
  strategies.push({ name: 'cardinalWalk', maxFails: 3 })

  // 2. DB pathfind — A* through known terrain + liveStep execution.
  strategies.push({ name: 'dbPathfind', maxFails: 3 })

  // 3. PillarUp — target above, surface, Y-diff significant.
  if (target.y > pos.y + 3 && !underground)
    strategies.push({ name: 'pillarUp', maxFails: 2 })

  // 4. Staircase — underground only, Y-diff.
  if (yDiff > 3 && underground)
    strategies.push({ name: 'staircase', maxFails: 3 })

  // 5. Tunnel — universal last resort (surface OR underground).
  strategies.push({ name: 'tunnel', maxFails: 3 })

  // Filter out exhausted strategies
  return strategies.filter(s => (failCounts[s.name] || 0) < s.maxFails)
}

// Execute a single strategy by name. Returns true if progress was made.
// ctx holds this strategy's cross-step memory for the current navigation (the
// cascade keeps one ctx per strategy in navigateTo's ctxMap).
async function executeStrategy(name, tx, ty, tz, range, target, timeout, startTime, lastChatStrategy, ctx = {}) {
  const bot = state.bot
  const pos = bot.entity.position
  const dist = pos.distanceTo(target)

  switch (name) {
    case 'purePathfind': {
      console.log(`  nav: strategy=purePathfind (${Math.round(dist)}m)`)
      if (lastChatStrategy.v !== 'purePathfind') { lastChatStrategy.v = 'purePathfind' }
      state.navigationStatus = `purePathfind ${Math.round(dist)}m`
      bot.pathfinder.setGoal(new goals.GoalNear(tx, ty, tz, range), true)
      const pfStart = Date.now()
      let pfStuck = 0, pfLastPos = bot.entity.position.clone()
      while (true) {
        await bot.waitForTicks(10)
        if (state.abortSignal) { try { bot.pathfinder.setGoal(null) } catch(e) {} return false }
        const d = bot.entity.position.distanceTo(target)
        if (d <= range + 0.5) { try { bot.pathfinder.setGoal(null) } catch(e) {} return true }
        if (Date.now() - pfStart > 10000) { try { bot.pathfinder.setGoal(null) } catch(e) {} return false }
        const m = bot.entity.position.distanceTo(pfLastPos)
        if (m < 0.15) pfStuck++; else pfStuck = 0
        pfLastPos = bot.entity.position.clone()
        if (pfStuck > 6) { try { bot.pathfinder.setGoal(null) } catch(e) {} return false }
      }
    }
    case 'hybridPath': {
      const result = await execHybridPath(tx, ty, tz, range)
      if (result && lastChatStrategy.v !== 'hybridPath') { lastChatStrategy.v = 'hybridPath' }
      return result
    }
    case 'cardinalWalk': {
      console.log(`  nav: strategy=cardinalWalk (${Math.round(dist)}m)`)
      if (lastChatStrategy.v !== 'cardinalWalk') { debugChat(`[nav] cardinalWalk ${Math.round(dist)}m`); lastChatStrategy.v = 'cardinalWalk' }
      state.navigationStatus = `cardinal walking toward ${tx},${ty},${tz}`
      return await cardinalWalk(tx, ty, tz, 15, range)
    }
    case 'dbPathfind': {
      const result = await execDbPathfind(tx, ty, tz, range, ctx)
      if (result && lastChatStrategy.v !== 'dbPathfind') { debugChat(`[nav] dbPathfind`); lastChatStrategy.v = 'dbPathfind' }
      return result
    }
    // airRope removed from strategies (function kept for future use)
    case 'pillarUp': {
      console.log(`  nav: strategy=pillarUp (Y=${Math.round(pos.y)}→${ty})`)
      if (lastChatStrategy.v !== 'pillarUp') { debugChat(`[nav] pillarUp Y${Math.round(pos.y)}→${ty}`); lastChatStrategy.v = 'pillarUp' }
      state.navigationStatus = `pillarUp Y=${Math.round(pos.y)}→${ty}`
      return await pillarUp(ty, 5)
    }
    case 'staircase': {
      console.log(`  nav: strategy=staircase (Y=${Math.round(pos.y)}→${ty})`)
      if (lastChatStrategy.v !== 'staircase') { debugChat(`[nav] staircase Y${Math.round(pos.y)}→${ty}`); lastChatStrategy.v = 'staircase' }
      state.navigationStatus = `staircasing Y=${Math.round(pos.y)}→${ty}`
      return await staircaseStep(tx, ty, tz, ctx)
    }
    // visionWalk removed — replaced by cardinalWalk
    case 'tunnel': {
      console.log(`  nav: strategy=tunnel (${Math.round(dist)}m)`)
      if (lastChatStrategy.v !== 'tunnel') { debugChat(`[nav] tunnel`); lastChatStrategy.v = 'tunnel' }
      state.navigationStatus = `tunneling toward ${tx},${ty},${tz}`
      return await tunnelStep(tx, ty, tz)
    }
    default:
      return false
  }
}

// ─── Isolated single-strategy driver ──────────────────────────────
// Runs ONE strategy to completion in isolation: owns its own loop, timeout,
// abort handling, completion check, stuck-detection, error boundary, and a FRESH
// opaque per-run ctx. This is what makes a strategy "self-contained" — a simple
// (explicit-strategy) task calls this directly with NO cascade and NO fallback,
// so a deliberately-chosen strategy can never be silently overridden or undone
// by another (the old bug: cardinalWalk/dbPathfind climbing a staircase back up).
//
// The driver is PREDICATE-TERMINATED: it stops when goal.isDone(ctx). A coordinate
// goal's predicate is "within range of the point"; a heading goal's predicate is
// its `until` condition (y<=N, wall ahead, N steps). goal.progress(ctx) is a scalar
// where HIGHER = better; the driver flags "stuck" when it fails to increase. This
// is the one place that knows distance-to-point is just one kind of done — which
// is what makes directional digging ("staircase west until a wall") first-class.
//
// stepFn(ctx) executes ONE step (or a short burst); the DRIVER — not the step —
// decides done/failed. Cross-step memory (committed direction/pattern, cached
// path, advance counter) lives on ctx, born and discarded with this call. ctx.goal
// is set so the step can read its committed plan. Returns { ok, reason }.
async function runStrategy(name, stepFn, goal, opts = {}) {
  const bot = state.bot
  const timeout = opts.timeout || 45000
  const stuckLimit = opts.stuckLimit || 4
  const startTime = Date.now()
  const ctx = { goal, advanced: 0 }   // fresh, opaque, per-run — owned by this driver
  let stuck = 0
  let best = goal.progress(ctx)
  console.log(`\n  runStrategy[${name}]: ${goal.desc} (timeout=${Math.round(timeout / 1000)}s)`)

  while (true) {
    if (state.abortSignal) return { ok: false, reason: 'abort' }
    if (Date.now() - startTime > timeout) {
      console.log(color(c.yellow, `  runStrategy[${name}]: timeout (${goal.desc})`))
      return { ok: false, reason: 'timeout' }
    }

    if (goal.isDone(ctx)) {
      console.log(color(c.green, `  runStrategy[${name}]: done (${goal.desc})`))
      return { ok: true, reason: 'done' }
    }

    // Hostile / critical-status guard — same policy as the cascade.
    const check = preCheck({ ignoreMsgs: true })
    if (check && (check.interrupt === 'hostile' || check.interrupt === 'low_health' || check.interrupt === 'drowning')) {
      console.log(`  runStrategy[${name}]: ${check.interrupt}, aborting`)
      return { ok: false, reason: check.interrupt }
    }

    // One isolated step. A raceAbort timeout/abort from a wrapped mineflayer op
    // must not reject the driver — treat as a failed step and let the loop unwind.
    try {
      await stepFn(ctx)
    } catch (e) {
      if (e instanceof AbortError) { state.abortSignal = true; return { ok: false, reason: 'abort' } }
      console.log(color(c.yellow, `  runStrategy[${name}]: step threw (${e.message})`))
    }

    // Stuck-detection: any increase in the goal's progress scalar resets it.
    const p = goal.progress(ctx)
    if (p > best + 0.5) { stuck = 0; best = p }
    else if (++stuck >= stuckLimit) {
      console.log(color(c.red, `  runStrategy[${name}]: stuck — ${stuckLimit} steps with no progress (${goal.desc})`))
      return { ok: false, reason: 'stuck' }
    }
  }
}

// One step of a non-digging directional walk (for "move west until a wall").
async function headingWalkStep(ctx) {
  const bot = state.bot, dir = ctx.goal.dir
  const p = bot.entity.position
  const cx = Math.floor(p.x), cy = Math.round(p.y), cz = Math.floor(p.z)
  // look-to-reveal so the STRICT liveStep doesn't block on unknown cells
  if (dbBlock(cx + dir[0], cy, cz + dir[1]) === null || dbBlock(cx + dir[0], cy + 1, cz + dir[1]) === null) {
    surveyForNav({ maxDistance: 18 })
  }
  const res = await liveStep(bot, dir[0], dir[1], { mode: navMode() })
  if (res.ok) ctx.advanced = (ctx.advanced || 0) + 1
  return res.ok
}

// Run a single directional (heading) strategy to a runtime stop-condition. No
// cascade — directional intent is always explicit. stratName picks the executor:
// 'staircase' digs a descending/ascending stair; 'move' walks without digging.
async function digHeading(stratName, dir, goalOpts = {}, opts = {}) {
  state.navSafetyMode = opts.allowHazards ? 'hazard' : (opts.mode || 'safe')
  state.navFistMining = false
  const goal = headingGoal(dir, goalOpts)
  const stepFn = stratName === 'move' ? headingWalkStep
    : stratName === 'tunnel' ? (ctx) => tunnelStep(0, 0, 0, ctx)
    : (ctx) => staircaseStep(0, 0, 0, ctx)
  const res = await runStrategy(stratName, stepFn, goal, { timeout: opts.timeout || 60000, stuckLimit: opts.stuckLimit || 5 })
  clearNavState()
  if (!res.ok) {
    const p = state.bot.entity.position
    const toolInfo = getToolSummary(state.bot)
    state.navFailReason = `${stratName} ${res.reason} (${goal.desc}), at ${Math.floor(p.x)},${Math.round(p.y)},${Math.floor(p.z)}${toolInfo}`
    console.log(color(c.red, `  nav: ${state.navFailReason}`))
  }
  return res.ok
}

// Main navigation function — plans route step by step
async function navigateTo(tx, ty, tz, range = 2, timeout = 45000, opts = {}) {
  const bot = state.bot
  const target = new Vec3(tx, ty, tz)
  const startTime = Date.now()
  let failCounts = {}
  let noProgressRounds = 0

  state.navigationStatus = `navigating to ${tx},${ty},${tz}`
  state.navSafetyMode = opts.allowHazards ? 'hazard' : (opts.mode || 'safe')
  state.navFistMining = false  // reset fist-mining flag
  const lastChatStrategy = { v: null }  // wrapped in object for pass-by-ref
  console.log(`\n  nav: starting toward ${tx},${ty},${tz} (range=${range})`)

  // One clearNavState() in the finally below replaces the 7 scattered partial
  // clears that used to live on every return path (and leaked state on aborts).
  try {
  // ── Explicit-strategy task (a "simple task") ──────────────────────
  // The caller deliberately chose ONE method, so run only that method in
  // isolation via runStrategy — NO cascade, NO fallback. It succeeds or fails
  // cleanly back to the caller (the AI then decides what to do next). This is
  // the whole point: a chosen digging strategy can never be silently undone by
  // a walk strategy. Open-ended navigation (opts.strategy unset) falls through
  // to the cascade below.
  if (opts.strategy) {
    // Coordinate target → a 'reach' goal; the driver is done when within range.
    const goal = reachGoal(tx, ty, tz, range)
    const EXPLICIT = {
      staircase: [['staircase', (ctx) => staircaseStep(tx, ty, tz, ctx)]],
      tunnel:    [['tunnel',    (ctx) => tunnelStep(tx, ty, tz)]],
      // 'walk' = the non-digging navigators only (cardinalWalk, then dbPathfind);
      // never staircase/tunnel. Still isolated — no digging strategy can sneak in.
      walk:      [['cardinalWalk', (ctx) => cardinalWalk(tx, ty, tz, 15, range)],
                  ['dbPathfind',   (ctx) => execDbPathfind(tx, ty, tz, range, ctx)]],
    }
    const chain = EXPLICIT[opts.strategy]
    if (chain) {
      let res = { ok: false, reason: 'none' }
      for (const [nm, fn] of chain) {
        res = await runStrategy(nm, fn, goal, { timeout, stuckLimit: opts.strategy === 'walk' ? 3 : 5 })
        if (res.ok) break
        // A genuine abort/hazard stops the whole chain; a 'stuck'/'timeout' on
        // one walk executor may still let the next one try.
        if (res.reason === 'abort' || res.reason === 'hostile' || res.reason === 'low_health' || res.reason === 'drowning') break
      }
      if (!res.ok) {
        const p = bot.entity.position
        const toolInfo = getToolSummary(bot)
        state.navFailReason = `${opts.strategy} ${res.reason}, ${Math.round(p.distanceTo(target))}m remaining, at ${Math.floor(p.x)},${Math.round(p.y)},${Math.floor(p.z)}${toolInfo}`
        console.log(color(c.red, `  nav: ${state.navFailReason}`))
      }
      return res.ok
    }
    // Unrecognised strategy name → fall through to the general cascade.
  }

  // Per-strategy cross-step memory for the general cascade — one fresh ctx per
  // strategy, living for this navigation only (replaces the old globals).
  const ctxMap = {}

  while (true) {
    // Guard check
    try { await tickWait(100) } catch (e) {
      return false
    }

    if (state.abortSignal) {
      console.log(color(c.yellow, '  nav: aborted'))
      return false
    }

    if (Date.now() - startTime > timeout) {
      const p = bot.entity.position
      const toolInfo = getToolSummary(bot)
      state.navFailReason = `timeout after ${Math.round(timeout/1000)}s, ${Math.round(p.distanceTo(target))}m remaining, at ${Math.floor(p.x)},${Math.round(p.y)},${Math.floor(p.z)}${toolInfo}`
      console.log(color(c.yellow, `  nav: overall timeout (${state.navFailReason})`))
      return false
    }

    const pos = bot.entity.position
    const dist = pos.distanceTo(target)

    // Arrival check (with last-meter reachability dig)
    if (dist <= range + 0.5) {
      if (!opts.noReachCheck) {
        const rv = _getReachVec(opts, target)
        if (!_reachCheck(bot, rv)) {
          const dug = await _digToward(bot, rv)
          if (dug) { failCounts = {}; continue }
          console.log(`  nav: close (${Math.round(dist)}m) but can't reach target through blocks`)
          noProgressRounds++
          if (noProgressRounds >= 5) break
          continue
        }
      }
      console.log(color(c.green, `\n  nav: arrived (${Math.round(dist)}m)`))
      return true
    }

    // Pre-check for hostiles / critical status
    const check = preCheck({ ignoreMsgs: true })
    if (check) {
      if (check.interrupt === 'hostile') {
        console.log(`  nav: hostile detected (${check.entity.name}), pausing navigation`)
        return false
      }
      if (check.interrupt === 'low_health' || check.interrupt === 'drowning') {
        console.log(`  nav: critical status (${check.interrupt}), aborting`)
        return false
      }
    }

    // Cascading strategy selection
    const strategies = pickStrategies(pos, target, failCounts)
    if (strategies.length === 0) {
      console.log(color(c.red, '  nav: all strategies exhausted'))
      break
    }

    let progress = false
    const distBefore = bot.entity.position.distanceTo(target)
    for (const s of strategies) {
      // A raceAbort timeout/abort thrown from a wrapped mineflayer op (dig,
      // place, equip, lookAt) inside a strategy must not reject navigateTo —
      // treat it as a failed step and let the loop-top abortSignal check unwind.
      let ok = false
      try {
        const sctx = ctxMap[s.name] || (ctxMap[s.name] = {})
        ok = await executeStrategy(s.name, tx, ty, tz, range, target, timeout, startTime, lastChatStrategy, sctx)
      } catch (e) {
        if (e instanceof AbortError) { state.abortSignal = true }
        else console.log(color(c.yellow, `  nav: strategy ${s.name} threw (${e.message})`))
        ok = false
      }

      // Re-check arrival after every strategy (prevents overshoot)
      const distNow = bot.entity.position.distanceTo(target)
      if (distNow <= range + 0.5) { progress = true; break }

      if (ok) {
        if (distNow < distBefore - 0.5) {
          progress = true
          failCounts = {}  // reset ALL on real progress
        } else {
          failCounts[s.name] = (failCounts[s.name] || 0) + 1
        }
        break
      }
      failCounts[s.name] = (failCounts[s.name] || 0) + 1
    }

    if (!progress) noProgressRounds++
    else noProgressRounds = 0

    if (noProgressRounds >= 3) {
      const pos = bot.entity.position
      const remainDist = Math.round(pos.distanceTo(target))
      const failedStrats = Object.entries(failCounts).filter(([,c]) => c > 0).map(([n,c]) => `${n}(${c})`).join(',')
      const toolInfo = getToolSummary(bot)
      console.log(color(c.red, `  nav: 3 full rounds with zero progress, giving up (${remainDist}m away, failed: ${failedStrats})`))
      state.navFailReason = `${remainDist}m away, strategies failed: ${failedStrats}, at ${Math.floor(pos.x)},${Math.round(pos.y)},${Math.floor(pos.z)}${toolInfo}`
      break
    }
  }

  return false
  } finally {
    clearNavState()
  }
}

// Vision-guided walk — small burst of steps using open directions
// Verify walkable path using line-of-sight rays (no x-ray).
// Uses PASSABLE set (not TRANSPARENT — glass/water/leaves block movement).
// Knee-height ray (y+0.5) so 1-block step-ups don't fail, head ray (y+1.7).
// Returns how many blocks are clear, up to `blocks`.
// verifyWalkable and visionWalk removed — replaced by cardinalWalk

module.exports = { navigateTo, digHeading, until, digBlock, hasWalkableLOS, cardinalWalk, tunnelStep, staircaseStep, pillarUp, isUnderground }
