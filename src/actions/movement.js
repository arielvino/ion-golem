// Movement actions — follow, come, goto, flee, mount, dismount, sail
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { tickWait, raceAbort, AbortError, sleep, stopAll, isAborted } = require('../core/tick')
const { navigateTo, digHeading, until } = require('../navigation/navigation')
const { castVisionRays } = require('../perception/vision')
const { sendChat, recordFailure, fuzzyMatch } = require('../core/utils')
const { logGameEvent } = require('../world/memory')
const { OXYGEN_SURFACED } = require('../config/safety')
const { WATER_BLOCKS, STRUCTURAL_AIR } = require('../config/blocks')

// Best-known position of a player. If their entity is in render range we have
// exact, tracked coords. Otherwise fall back to the Locator Bar waypoint the
// server pushes (bot._waypoints, populated in bot.js) — the same signal a human
// reads off the locator bar — so follow/come can still head the right way from
// hundreds of blocks out. Returns { x, y, z, precise, tracked } or null when
// there's nothing fresh to go on. `precise` = exact coords; `tracked` = we can
// actually see the entity (so distance/arrival checks are meaningful).
function resolvePlayerTarget(bot, username) {
  const p = bot.players[username]
  if (p?.entity) {
    const e = p.entity.position
    return { x: e.x, y: e.y, z: e.z, precise: true, tracked: true }
  }
  const wp = p?.uuid ? bot._waypoints?.get(p.uuid) : null
  if (!wp || (Date.now() - wp.t) >= 30000) return null
  const pos = bot.entity.position
  if (wp.type === 'vec3i') {
    return { x: wp.x, y: wp.y, z: wp.z, precise: true, tracked: false }
  }
  if (wp.type === 'chunk') {
    // Rough chunk centre; the locator gives no Y, so aim level with ourselves.
    return { x: wp.chunkX * 16 + 8, y: pos.y, z: wp.chunkZ * 16 + 8, precise: false, tracked: false }
  }
  if (wp.type === 'azimuth') {
    // Very distant: only a world-frame bearing (azimuth = atan2(dz,dx)). Project
    // a waypoint ahead along it and re-project each tick as we close in.
    const R = 48
    return { x: pos.x + Math.cos(wp.azimuth) * R, y: pos.y, z: pos.z + Math.sin(wp.azimuth) * R, precise: false, tracked: false }
  }
  return null
}

function doFollow(username) {
  stopAll()
  const bot = state.bot
  if (!resolvePlayerTarget(bot, username)) { sendChat("Can't see you and no locator fix on you!"); return }
  state.currentTask = `following ${username}`
  state.followTarget = username
  let busy = false
  let misses = 0
  state.followInterval = setInterval(async () => {
    if (busy) return
    const tgt = resolvePlayerTarget(bot, state.followTarget)
    if (!tgt) {
      // Lost both the entity and a fresh locator fix — the player may be
      // reconnecting or briefly off the locator. Wait ~30s before giving up.
      if (++misses >= 30) { clearInterval(state.followInterval); state.followInterval = null; state.currentTask = null }
      return
    }
    misses = 0
    const pos = bot.entity.position
    const dist = Math.hypot(tgt.x - pos.x, tgt.y - pos.y, tgt.z - pos.z)
    // "Close enough" only counts when we can see them. A rough locator fix means
    // keep closing until they render in and precise tracking takes over.
    if (tgt.tracked && dist <= 4) return
    if (!tgt.tracked && dist <= 6) return
    busy = true
    try {
      await navigateTo(Math.floor(tgt.x), Math.floor(tgt.y), Math.floor(tgt.z),
        tgt.tracked ? 2 : 6, 5000, tgt.precise ? {} : { noReachCheck: true })
    } catch (e) { console.warn('  [FOLLOW] nav err:', e.message) }
    busy = false
  }, 1000)
}

async function doCome(username) {
  stopAll()
  const bot = state.bot
  let tgt = resolvePlayerTarget(bot, username)
  if (!tgt) { sendChat("Can't see you and no locator fix on you!"); return }

  if (bot.vehicle) {
    console.log(`  come: in vehicle, using sail to ${Math.floor(tgt.x)},${Math.floor(tgt.y)},${Math.floor(tgt.z)}`)
    await doSail(`${Math.floor(tgt.x)},${Math.floor(tgt.y)},${Math.floor(tgt.z)}`)
    return
  }

  state.currentTask = `going to ${username}`
  // Walk toward the best-known position in legs, re-resolving each loop: while
  // they're out of render range we chase the locator fix; once they render in,
  // precise entity tracking takes over and we do the final approach.
  const overallStart = Date.now()
  const MAX_TRIP = 180000  // hard ceiling for a long cross-terrain trek
  while (!isAborted()) {
    tgt = resolvePlayerTarget(bot, username)
    if (!tgt) { recordFailure(`come:${username} failed (lost track)`); break }
    const pos = bot.entity.position
    const dist = Math.hypot(tgt.x - pos.x, tgt.y - pos.y, tgt.z - pos.z)
    if (tgt.tracked && dist <= 3) break  // arrived — we can see them
    if (Date.now() - overallStart > MAX_TRIP) {
      recordFailure(`come:${username} failed (timeout, still ${Math.round(dist)}m out)`)
      break
    }

    const yD = Math.abs(pos.y - tgt.y)
    // Tracked: one sized leg straight to them. Locator: short legs, re-resolve
    // often as the fix updates and the player keeps moving.
    const legTimeout = tgt.tracked ? Math.max(30000, Math.round(dist * 2000 + yD * 3000)) : 20000
    const ok = await navigateTo(Math.floor(tgt.x), Math.floor(tgt.y), Math.floor(tgt.z),
      tgt.tracked ? 2 : 6, legTimeout,
      tgt.tracked ? { reachTarget: () => bot.players[username]?.entity?.position } : { noReachCheck: true })

    if (tgt.tracked) {
      // We could see them and the nav still failed — that's a real, reportable failure.
      if (!ok && !isAborted()) {
        const d = bot.entity.position.distanceTo(new Vec3(tgt.x, tgt.y, tgt.z))
        const reason = state.navFailReason || 'unknown'
        console.log(`  come: couldn't reach ${username} (${d.toFixed(1)}m away) — ${reason}`)
        recordFailure(`come:${username} failed (${reason})`)
        state.navFailReason = null
      }
      break  // tracked leg is terminal whether it succeeded or failed
    }
    // Locator leg finished (reached the rough fix, or timed out making progress).
    // Pause a beat so entity tracking can catch up, then loop and re-resolve.
    if (!isAborted()) await sleep(800)
  }
  state.navFailReason = null
  state.currentTask = null
}

async function doFlee() {
  stopAll()
  const bot = state.bot
  state.currentTask = 'fleeing'
  const hostile = bot.nearestEntity(e =>
    (e.type === 'hostile' || e.type === 'mob') && e.position.distanceTo(bot.entity.position) < 32
  )
  const pos = bot.entity.position
  let fleeDir
  if (hostile) {
    fleeDir = pos.minus(hostile.position).normalize()
    console.log(`  fleeing from ${hostile.name} at dist=${Math.round(hostile.position.distanceTo(pos))}`)
  } else {
    const yaw = bot.entity.yaw
    fleeDir = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
    console.log('  fleeing (no hostile nearby, running forward)')
  }
  const dest = pos.plus(fleeDir.scaled(30))
  bot.setControlState('sprint', true)
  const ok = await navigateTo(dest.x, pos.y, dest.z, 3, 15000, { noReachCheck: true })
  bot.setControlState('sprint', false)
  if (ok) console.log('  fled safely')
  else console.log('  flee: partial escape')
  state.currentTask = null
}

async function doMount(targetName) {
  stopAll()
  const bot = state.bot
  state.currentTask = 'mounting'
  const normalized = (targetName || '').toLowerCase()
  const entity = bot.nearestEntity(e => {
    const n = (e.name || '').toLowerCase()
    if (normalized && normalized !== 'any') return fuzzyMatch(n, normalized)
    return n.includes('boat') || n.includes('minecart') || n.includes('horse') ||
           n.includes('donkey') || n.includes('mule') || n.includes('pig') ||
           n.includes('strider') || n.includes('camel') || n.includes('llama')
  })
  if (!entity) {
    sendChat(`No ${targetName || 'vehicle'} nearby to mount!`)
    state.currentTask = null
    return
  }
  const dist = bot.entity.position.distanceTo(entity.position)
  console.log(`  found ${entity.name} at dist=${Math.round(dist)}`)
  if (dist > 4) {
    await navigateTo(entity.position.x, entity.position.y, entity.position.z, 2, 10000, {
      reachTarget: () => entity?.position
    })
  }
  try {
    bot.mount(entity)
    console.log(`  mounted ${entity.name}`)
    sendChat(`Hopped in the ${entity.name}!`)
  } catch (err) {
    console.log(`  mount failed: ${err.message}`)
    sendChat(`Can't get in: ${err.message}`)
  }
  state.currentTask = null
}

async function doDismount() {
  stopAll()
  const bot = state.bot
  state.currentTask = 'dismounting'
  if (!bot.vehicle) {
    console.log('  not in a vehicle, nothing to dismount')
    state.currentTask = null
    return
  }
  try {
    bot.setControlState('sneak', true)
    await sleep(200)
    bot.setControlState('sneak', false)
    if (bot.vehicle) {
      bot.dismount()
    }
    console.log('  dismounted')
  } catch (err) {
    console.log(`  dismount failed: ${err.message}`)
    bot.setControlState('sneak', true)
    await sleep(500)
    bot.setControlState('sneak', false)
  }
  state.currentTask = null
}

async function doSail(target) {
  const bot = state.bot
  if (!bot.vehicle) {
    sendChat("I'm not in a boat! Mount one first.")
    return
  }
  state.currentTask = 'sailing'

  let goalX, goalZ
  const coordMatch = target.match(/(-?\d+)\s*,\s*(-?\d+)\s*,?\s*(-?\d+)?/)
  if (coordMatch) {
    goalX = parseInt(coordMatch[1])
    goalZ = parseInt(coordMatch[3] || coordMatch[2])
    if (coordMatch[3]) goalZ = parseInt(coordMatch[3])
  } else {
    const dirMatch = target.match(/(north|south|east|west|forward|straight)/i)
    const distMatch = target.match(/(\d+)/)
    const dist = distMatch ? parseInt(distMatch[1]) : 200
    const pos = bot.entity.position
    if (dirMatch) {
      const dir = dirMatch[1].toLowerCase()
      if (dir === 'north') { goalX = pos.x; goalZ = pos.z - dist }
      else if (dir === 'south') { goalX = pos.x; goalZ = pos.z + dist }
      else if (dir === 'east') { goalX = pos.x + dist; goalZ = pos.z }
      else if (dir === 'west') { goalX = pos.x - dist; goalZ = pos.z }
      else {
        const yaw = bot.entity.yaw
        goalX = pos.x - Math.sin(yaw) * dist
        goalZ = pos.z + Math.cos(yaw) * dist
      }
    } else {
      const yaw = bot.entity.yaw
      goalX = pos.x - Math.sin(yaw) * dist
      goalZ = pos.z + Math.cos(yaw) * dist
    }
  }

  const startPos = bot.entity.position.clone()
  const totalDist = Math.sqrt((goalX - startPos.x) ** 2 + (goalZ - startPos.z) ** 2)
  console.log(`  sailing ${Math.round(totalDist)}m toward ${Math.round(goalX)},${Math.round(goalZ)}`)
  sendChat(`Sailing ${Math.round(totalDist)}m!`)

  const timeout = Math.max(totalDist * 300, 30000)
  const start = Date.now()
  let lastDist = Infinity
  let stuckCount = 0

  // Mineflayer doesn't simulate boat physics or send the boat's position, and
  // the server treats boat movement as client-authoritative — so player_input
  // (bot.moveVehicle) alone never moves the boat. We drive it ourselves: each
  // tick, step the boat toward the goal and send a serverbound vehicle_move with
  // the new position + heading (the same packet the vanilla client sends).
  const toDeg = r => r * 180 / Math.PI
  const SPEED = 0.32 // blocks per 50ms tick (~6.4 m/s, within boat speed limits)

  if (state.activeSailTick) { clearInterval(state.activeSailTick); state.activeSailTick = null }
  let lastInput = '-'
  const sailInterval = setInterval(() => {
    const boat = bot.vehicle
    if (!boat) return
    const bx = boat.position.x, by = boat.position.y, bz = boat.position.z
    const dx = goalX - bx, dz = goalZ - bz
    const horiz = Math.sqrt(dx * dx + dz * dz)
    if (horiz < 0.5) { lastInput = 'arrived'; return }
    const ux = dx / horiz, uz = dz / horiz
    const step = Math.min(SPEED, horiz)
    const nx = bx + ux * step, nz = bz + uz * step

    // Shore guard: don't drive into a solid block at the boat's level.
    const ahead = bot.blockAt(new Vec3(Math.floor(nx), Math.floor(by), Math.floor(nz)))
    if (ahead && ahead.boundingBox === 'block') { lastInput = 'BLOCKED'; return }

    // Notchian yaw facing the travel direction: x=-sin(yaw), z=cos(yaw).
    const yawDeg = toDeg(Math.atan2(-ux, uz))
    // Move boat + rider locally (server is authoritative for our own vehicle, so
    // it won't echo this back) and tell the server where the boat now is.
    boat.position.set(nx, by, nz)
    boat.yaw = Math.PI - Math.atan2(-ux, uz)
    bot.entity.position.translate(ux * step, 0, uz * step)
    bot._client.write('vehicle_move', { x: nx, y: by, z: nz, yaw: yawDeg, pitch: 0, onGround: false })
    lastInput = `drive ${step.toFixed(2)}`
  }, 50)
  state.activeSailTick = sailInterval
  console.log(`  sail loop starting (manual vehicle_move driver)`)

  let loopIter = 0
  let movedTotal = 0
  let prevPos = bot.entity.position.clone()
  let notResponding = false
  // try/finally so the driving interval is ALWAYS torn down — a throw inside the
  // loop used to leak the interval, which kept spamming vehicle_move forever and
  // desynced the boat's tracked position.
  try {
    while (true) {
      try { await tickWait(250) } catch(e) { break }
      loopIter++
      const pos = bot.entity.position
      const dx = goalX - pos.x
      const dz = goalZ - pos.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      const stepMoved = pos.distanceTo(prevPos)
      movedTotal += stepMoved
      prevPos = pos.clone()

      if (loopIter <= 6 || loopIter % 8 === 0) {
        const v = bot.vehicle
        const speed = v ? Math.sqrt(v.velocity.x ** 2 + v.velocity.z ** 2) : 0
        const boatYaw = v ? Math.round(toDeg(Math.PI - v.yaw)) : 0
        const bearing = dist > 0 ? Math.round(toDeg(Math.atan2(-dx / dist, dz / dist))) : 0
        console.log(`  sail[${loopIter}]: pos=${pos.x.toFixed(1)},${pos.z.toFixed(1)} dist=${Math.round(dist)} step=${stepMoved.toFixed(2)} spd=${speed.toFixed(2)} boatYaw=${boatYaw} bearing=${bearing} in=${lastInput} veh=${!!v}`)
      }

      if (dist < 10) { console.log(`  arrived at destination`); break }
      if (Date.now() - start > timeout) { console.log(`  sail timeout`); break }
      if (!bot.vehicle) { console.log(`  sail: no longer in vehicle`); break }

      // After ~3s of driving, flag if the boat barely moved (stuck/blocked, or
      // the server is rejecting our vehicle_move).
      if (loopIter === 12 && movedTotal < 0.5) {
        notResponding = true
        console.log(`  sail: boat not moving (moved ${movedTotal.toFixed(2)}m in ~3s) — stuck/blocked or server rejecting vehicle_move`)
      }

      if (Math.abs(dist - lastDist) < 0.3) stuckCount++
      else stuckCount = 0
      lastDist = dist

      if (stuckCount > 80) {
        console.log(`  sail stuck at ${pos.x.toFixed(1)},${pos.z.toFixed(1)}`)
        break
      }
    }
  } finally {
    clearInterval(sailInterval)
    state.activeSailTick = null
    if (bot.vehicle) bot.moveVehicle(0, 0)
  }

  const traveled = bot.entity.position.distanceTo(startPos)
  console.log(`  sailed ${Math.round(traveled)}m total`)
  if (traveled < 2 && notResponding) {
    sendChat("The boat won't move — it may be on land/ice, not water.")
    recordFailure('sail - boat did not move (likely not in water)')
  } else {
    sendChat(`Sailed ${Math.round(traveled)}m.`)
  }
  state.currentTask = null
}

const VALID_STRATEGIES = new Set(['tunnel', 'staircase', 'walk'])

async function doGoto(target, opts = {}) {
  stopAll()
  const bot = state.bot

  // Parse optional strategy: "X,Y,Z:tunnel" → coords="X,Y,Z", strategy="tunnel"
  let coordStr = target
  let strategy = null
  const colonIdx = target.lastIndexOf(':')
  if (colonIdx > 0) {
    const maybeSt = target.slice(colonIdx + 1)
    if (VALID_STRATEGIES.has(maybeSt)) {
      coordStr = target.slice(0, colonIdx)
      strategy = maybeSt
    }
  }

  const coords = coordStr.split(',').map(Number)
  if (coords.length !== 3 || coords.some(isNaN)) { console.log('  bad coords:', target); return false }
  const [tx, ty, tz] = coords

  if (bot.vehicle) {
    console.log(`  goto: in vehicle, using sail to ${target}`)
    return await doSail(target)
  }

  state.currentTask = `going to ${coordStr}${strategy ? ` (${strategy})` : ''}`
  const dist = bot.entity.position.distanceTo(new Vec3(tx, ty, tz))
  const yDiff = Math.abs(ty - bot.entity.position.y)
  // Allow ~2s per block horizontal + ~3s per Y level vertical (digging is slow)
  const timeout = Math.max(30000, Math.round(dist * 2000 + yDiff * 3000))
  const navOpts = {}
  if (opts.allowHazards) navOpts.allowHazards = true
  if (opts.mode) navOpts.mode = opts.mode
  if (strategy) navOpts.strategy = strategy
  const ok = await navigateTo(tx, ty, tz, 2, timeout, navOpts)
  if (!ok && !isAborted()) {
    const reason = state.navFailReason || 'unknown'
    recordFailure(`goto:${coordStr} failed (${reason})`)
    state.navFailReason = null
  }
  state.navigationStatus = null
  state.currentTask = null
  return ok
}

// ─── Directional digging / movement (predicate-terminated) ────────
// These express INTENT + a runtime STOP CONDITION instead of a coordinate, so
// the target need not be known in advance ("dig west until a wall"). The heading
// (direction + up/down) is committed once and followed; the driver stops on the
// `until` condition. See navigation.js digHeading / headingGoal.
//   [ACTION:staircase:DIR:UNTIL]  e.g. staircase:west:y30   staircase:north:20
//   [ACTION:move:DIR:UNTIL]       e.g. move:west:wall        move:east:15
const CARDINALS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

function parseHeadingArgs(arg) {
  const parts = String(arg).split(':').map(s => s.trim()).filter(Boolean)
  const dirName = (parts[0] || '').toLowerCase()
  return { dirName, dir: CARDINALS[dirName], untilStr: (parts[1] || '').toLowerCase() }
}

// Turn an "until" token into a predicate + a vertical pattern hint.
// yN → descend/ascend to that level; Nsteps → fixed count; wall → blocked ahead.
function buildUntil(untilStr, curY) {
  if (!untilStr) return null
  const ym = untilStr.match(/^y(-?\d+)$/)
  if (ym) {
    const y = Number(ym[1])
    return y <= curY
      ? { fn: until.depthAtMost(y), desc: `y<=${y}`, pattern: 'down' }
      : { fn: until.heightAtLeast(y), desc: `y>=${y}`, pattern: 'up' }
  }
  if (untilStr === 'wall' || untilStr === 'blocked') return { fn: until.blockedAhead(), desc: 'wall', pattern: 'flat' }
  const sm = untilStr.match(/^(\d+)(?:steps?)?$/)
  if (sm) return { fn: until.steps(Number(sm[1])), desc: `${sm[1]} steps`, pattern: null }
  return null
}

function pushFail(msg) {
  recordFailure(msg)
  state.navFailReason = null
}

async function doStaircase(arg) {
  stopAll()
  const bot = state.bot
  const { dirName, dir, untilStr } = parseHeadingArgs(arg)
  if (!dir) { pushFail(`staircase: bad direction "${dirName}" (use north/south/east/west)`); return }
  const curY = Math.round(bot.entity.position.y)
  const u = buildUntil(untilStr, curY)
  if (!u) { pushFail(`staircase: bad/missing condition "${untilStr}" (use yN or Nsteps)`); return }
  // A staircase must go up or down; a bare step-count defaults to descending.
  const pattern = u.pattern || 'down'
  if (pattern === 'flat') { pushFail(`staircase: "${untilStr}" needs a vertical goal — use yN`); return }
  state.currentTask = `staircase ${dirName} until ${u.desc}`
  const ok = await digHeading('staircase', dir, { pattern, until: u.fn, untilDesc: u.desc })
  if (!ok && !isAborted()) pushFail(`staircase:${dirName}:${untilStr} failed (${state.navFailReason || 'unknown'})`)
  state.currentTask = null
}

async function doMove(arg) {
  stopAll()
  const bot = state.bot
  const { dirName, dir, untilStr } = parseHeadingArgs(arg)
  if (!dir) { pushFail(`move: bad direction "${dirName}" (use north/south/east/west)`); return }
  const u = buildUntil(untilStr, Math.round(bot.entity.position.y))
  if (!u) { pushFail(`move: bad/missing condition "${untilStr}" (use wall or Nsteps)`); return }
  state.currentTask = `move ${dirName} until ${u.desc}`
  const ok = await digHeading('move', dir, { pattern: 'flat', until: u.fn, untilDesc: u.desc })
  if (!ok && !isAborted()) pushFail(`move:${dirName}:${untilStr} failed (${state.navFailReason || 'unknown'})`)
  state.currentTask = null
}

// Directional tunnel: dig a flat (same-Y) corridor heading DIR until a runtime
// condition. The compass heading is committed once, so "tunnel north" can never
// drift south the way a hand-picked goto coordinate can. UNTIL = wall | Nsteps.
// (A changing-Y goal belongs to staircase, not tunnel — rejected below.)
async function doTunnel(arg) {
  stopAll()
  const bot = state.bot
  const { dirName, dir, untilStr } = parseHeadingArgs(arg)
  if (!dir) { pushFail(`tunnel: bad direction "${dirName}" (use north/south/east/west)`); return }
  const u = buildUntil(untilStr, Math.round(bot.entity.position.y))
  if (!u) { pushFail(`tunnel: bad/missing condition "${untilStr}" (use wall or Nsteps)`); return }
  if (u.pattern === 'up' || u.pattern === 'down') {
    pushFail(`tunnel: "${untilStr}" is a vertical goal — use staircase:${dirName}:${untilStr} to change Y`)
    return
  }
  state.currentTask = `tunnel ${dirName} until ${u.desc}`
  const ok = await digHeading('tunnel', dir, { pattern: 'flat', until: u.fn, untilDesc: u.desc })
  if (!ok && !isAborted()) pushFail(`tunnel:${dirName}:${untilStr} failed (${state.navFailReason || 'unknown'})`)
  state.currentTask = null
}

const COMPASS_OFFSETS = {
  n: [0, -1], north: [0, -1],
  s: [0, 1],  south: [0, 1],
  e: [1, 0],  east: [1, 0],
  w: [-1, 0], west: [-1, 0],
  ne: [1, -1], northeast: [1, -1],
  nw: [-1, -1], northwest: [-1, -1],
  se: [1, 1],  southeast: [1, 1],
  sw: [-1, 1], southwest: [-1, 1],
}

async function doTurn(target) {
  const bot = state.bot
  const pos = bot.entity.position
  const dir = target.toLowerCase().trim()

  // Compass direction
  const offset = COMPASS_OFFSETS[dir]
  if (offset) {
    const lookPos = pos.offset(offset[0] * 10, 0, offset[1] * 10)
    await bot.lookAt(lookPos.offset(0, bot.entity.height, 0))
    console.log(`  turned to face ${dir.toUpperCase()}`)
    return
  }

  // Coordinates: x,y,z
  const coordMatch = dir.match(/(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/)
  if (coordMatch) {
    const tx = parseInt(coordMatch[1]), ty = parseInt(coordMatch[2]), tz = parseInt(coordMatch[3])
    await bot.lookAt(new Vec3(tx + 0.5, ty + bot.entity.height, tz + 0.5))
    console.log(`  turned to face ${tx},${ty},${tz}`)
    return
  }

  // Player name
  const player = bot.players[target]
  if (player?.entity) {
    await bot.lookAt(player.entity.position.offset(0, player.entity.height, 0))
    console.log(`  turned to face ${target}`)
    return
  }

  console.log(`  turn: unknown direction "${target}" (use N/S/E/W/NE/NW/SE/SW, coords, or player name)`)
}

async function doSwimUp() {
  const bot = state.bot
  state.currentTask = 'swimming up'
  bot.clearControlStates()
  for (let i = 0; i < 30; i++) {
    if (bot.oxygenLevel >= OXYGEN_SURFACED) { console.log('  [swimup] surfaced, oxygen restored'); break }
    bot.setControlState('jump', true)
    const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0))
    if (headBlock && !STRUCTURAL_AIR.has(headBlock.name) && !WATER_BLOCKS.has(headBlock.name) && headBlock.diggable) {
      const hp = headBlock.position
      if (state.stmts.isPlaced && state.stmts.isPlaced.get(hp.x, hp.y, hp.z)) {
        console.log(`  [swimup] skipping placed block at ${hp}`)
      } else {
        try { await raceAbort(bot.dig(headBlock), 30000); logGameEvent('mine', headBlock.name, 1, hp.x, hp.y, hp.z, { reason: 'swimup' }) } catch(e) { console.warn('  [SWIM] dig err:', e.message) }
      }
    }
    await sleep(400)
  }
  // Stay surfaced a bit longer
  for (let j = 0; j < 5; j++) {
    bot.setControlState('jump', true)
    await sleep(400)
  }
  bot.setControlState('jump', false)

  // Try to swim to shore — find nearest solid ground at water surface level
  if (bot.entity.isInWater) {
    console.log('  [swimup] still in water, seeking shore...')
    const pos = bot.entity.position
    const cy = Math.round(pos.y)
    let bestShore = null, bestDist = Infinity
    // Scan in expanding square for a solid non-water block at foot level
    for (let r = 1; r <= 16; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue // only perimeter
          const bx = Math.floor(pos.x) + dx, bz = Math.floor(pos.z) + dz
          // Check a few Y levels around surface
          for (let dy = -1; dy <= 2; dy++) {
            const b = bot.blockAt(new Vec3(bx, cy + dy, bz))
            const above = bot.blockAt(new Vec3(bx, cy + dy + 1, bz))
            if (b && !WATER_BLOCKS.has(b.name) && !STRUCTURAL_AIR.has(b.name)
                && above && STRUCTURAL_AIR.has(above.name)) {
              const d = Math.abs(dx) + Math.abs(dz)
              if (d < bestDist) { bestDist = d; bestShore = new Vec3(bx, cy + dy + 1, bz) }
            }
          }
        }
      }
      if (bestShore) break // found shore at this radius
    }
    if (bestShore) {
      console.log(`  [swimup] shore at ${bestShore.x},${bestShore.y},${bestShore.z} (${bestDist}m)`)
      // Swim toward shore — jump + look + forward
      for (let s = 0; s < 30; s++) {
        if (!bot.entity.isInWater) { console.log('  [swimup] reached land'); break }
        if (isAborted()) break
        await bot.lookAt(bestShore.offset(0.5, 0.5, 0.5))
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(300)
      }
      bot.clearControlStates()
    } else {
      console.log('  [swimup] no shore found within 16 blocks')
    }
  }

  console.log('  [swimup] done')
  state.currentTask = null
}

module.exports = { doFollow, doCome, doFlee, doMount, doDismount, doSail, doGoto, doStaircase, doMove, doTunnel, doTurn, doSwimUp }
