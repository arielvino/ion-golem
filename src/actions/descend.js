// Getting DOWN when the path planner can't: every nav step allows at most a 3-block
// drop (the no-damage height), and nothing digs straight down. On a pillar or a
// ledge over a cavern that leaves no move at all — goto, staircase and tunnel all
// fail "stuck". These two actions are the moves a player would make instead:
//
//   [ACTION:digdown:UNTIL]    dig out the block underfoot and drop into the hole,
//                             one block at a time. UNTIL = yN | Nsteps.
//   [ACTION:jumpdown:DIR]     step off a ledge (north/south/east/west) or break the
//                             floor (down) and take the fall. :blind = landing unseen.
//
// Both read the block DB (what the bot has seen), never the live world. A fall is
// reported with its expected damage; only a certainly lethal one is refused.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { sleep, stopAll, isAborted } = require('../core/tick')
const { recordFailure, logEvent } = require('../core/utils')
const { digBlock } = require('../navigation/navigation')
const { dbBlock, centerInBlock } = require('../navigation/atomicSteps')
const { surveyForNav } = require('../perception/visibility')
const { PASSABLE, HAZARDS, WATER_BLOCKS } = require('../config/blocks')

const SAFE_FALL = 3        // blocks a fall can span without damage
const MAX_SCAN = 64        // how far down a fall is measured
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

function feet() {
  const p = state.bot.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) }
}

// Fall from standing at feet level `fromY` in column (x,z), cells fromY-1 downward.
// `open` = cells treated as air regardless of the DB (the floor about to be dug).
// Returns { blocks, landing, water, hazard, unknown } — `blocks` is how far the bot
// drops; `unknown` means the scan hit a cell nobody has seen before finding ground.
function measureFall(x, fromY, z, open = 0) {
  let blocks = 0
  for (let y = fromY - 1; y >= fromY - MAX_SCAN; y--) {
    if (fromY - 1 - y < open) { blocks++; continue }
    const name = dbBlock(x, y, z)
    if (name === null) return { blocks, unknown: true, at: y }
    if (WATER_BLOCKS.has(name)) return { blocks, water: true, landing: name, at: y }
    if (HAZARDS.has(name)) return { blocks, hazard: name, landing: name, at: y }
    if (PASSABLE.has(name)) { blocks++; continue }
    return { blocks, landing: name, at: y }
  }
  return { blocks, unknown: true, at: fromY - MAX_SCAN }
}

// The cell under a floor is hidden until the floor breaks. But a player standing on
// a pillar still knows: the columns beside it are open air all the way down. When
// our own column is unseen, read the neighbours' — if they open below the floor
// level, the shallowest of them bounds the drop. It is an upper bound, not a
// measurement: the pillar may well continue under the floor.
function neighbourFall(x, floorY, z) {
  let best = null
  for (const [dx, dz] of Object.values(DIRS)) {
    const beside = dbBlock(x + dx, floorY - 1, z + dz)
    if (beside === null || !PASSABLE.has(beside)) continue
    const f = measureFall(x + dx, floorY, z + dz)
    if (f.unknown || f.hazard) continue
    const est = { ...f, blocks: f.blocks + 1, estimated: true }
    if (!best || est.blocks < best.blocks) best = est
  }
  return best
}

const damageOf = (fall) => (fall.water ? 0 : Math.max(0, fall.blocks - SAFE_FALL))

function describeFall(fall) {
  if (fall.unknown) return `at least ${fall.blocks} blocks, landing unseen (y${fall.at} never looked at)`
  const onto = fall.water ? `into ${fall.landing}` : `onto ${fall.landing} at y${fall.at}`
  return `${fall.estimated ? 'about ' : ''}${fall.blocks} blocks ${onto}, ~${damageOf(fall)} damage${fall.estimated ? ' (judged from the open columns beside it)' : ''}`
}

// Look around once if any cell the decision needs is still unknown.
function reveal(cells) {
  if (cells.some(([x, y, z]) => dbBlock(x, y, z) === null)) surveyForNav({ maxDistance: 16 })
}

// Wait for the bot to land after leaving its block. Resolves the drop in blocks.
async function awaitLanding(startY, timeoutMs = 4000) {
  const bot = state.bot
  const deadline = Date.now() + timeoutMs
  await sleep(150)
  while (Date.now() < deadline) {
    if (isAborted()) break
    if (bot.entity.onGround && bot.entity.position.y < startY - 0.5) break
    await sleep(50)
  }
  await sleep(100)
  return Math.round(startY - bot.entity.position.y)
}

function fail(msg) {
  recordFailure(msg)
  state.currentTask = null
  return false
}

// ── digdown ───────────────────────────────────────────────────────────────
async function doDigDown(arg, opts = {}) {
  stopAll()
  const bot = state.bot
  const until = String(arg || '').trim().toLowerCase()
  const start = feet()
  let targetY = null, maxSteps = null
  const ym = /^y(-?\d+)$/.exec(until)
  const sm = /^(\d+)(?:steps?)?$/.exec(until)
  if (ym) targetY = Number(ym[1])
  else if (sm) maxSteps = Number(sm[1])
  else return fail(`digdown: give a depth — digdown:y60 (down to that Y) or digdown:5 (blocks)`)
  if (targetY !== null && targetY >= start.y) return fail(`digdown:${until}: already at y${start.y}, nothing to dig`)

  state.currentTask = `digging down until ${until}`
  const intent = opts.skipTool ? 'clear-no-tool' : 'clear'
  let steps = 0
  while (true) {
    if (isAborted()) { state.currentTask = null; return }
    const f = feet()
    if (targetY !== null && f.y <= targetY) break
    if (maxSteps !== null && steps >= maxSteps) break

    const floorY = f.y - 1
    reveal([[f.x, floorY, f.z], [f.x, floorY - 1, f.z]])
    // Standing on it proves the floor is solid, whatever an old DB row says (the
    // block under the feet is the one cell the bot rarely gets a fresh look at).
    const floor = dbBlock(f.x, floorY, f.z)
    if (floor !== null && PASSABLE.has(floor)) {
      if (!bot.entity.onGround) return fail(`digdown stopped at y${f.y}: not standing on anything`)
      surveyForNav({ maxDistance: 16 })
    }
    // What digging the floor would drop me onto. An unseen cell under the floor is
    // normal (it's hidden until the floor breaks) — dig on, like a player would,
    // unless the columns beside it show open air below: then it's likely a drop.
    reveal([[f.x + 1, floorY - 1, f.z], [f.x - 1, floorY - 1, f.z], [f.x, floorY - 1, f.z + 1], [f.x, floorY - 1, f.z - 1]])
    let fall = measureFall(f.x, f.y, f.z, 1)
    if (fall.unknown && fall.blocks === 1) fall = neighbourFall(f.x, floorY, f.z) || fall
    if (fall.hazard) return fail(`digdown stopped at y${f.y}: ${fall.hazard} under the floor at y${fall.at}`)
    if (fall.water) return fail(`digdown stopped at y${f.y}: water under the floor at y${fall.at} — the shaft would flood`)
    // A known drop is certain damage: stop and let the model choose jumpdown. An
    // estimated one is only the worst case: dig on while even that is survivable.
    if (!fall.unknown && !fall.estimated && fall.blocks > SAFE_FALL) {
      return fail(`digdown stopped at y${f.y} after ${steps} blocks: breaking this floor drops ${describeFall(fall)}. ` +
        `Use [ACTION:jumpdown:down] to take that fall, or jumpdown:DIR off a ledge`)
    }
    if (fall.estimated && damageOf(fall) >= bot.health) {
      return fail(`digdown stopped at y${f.y} after ${steps} blocks: the floor may open onto a drop of ${describeFall(fall)} — ` +
        `lethal at ${Math.round(bot.health)} HP if the column below is hollow (it is unseen). Heal first (eat), then dig on`)
    }

    await centerInBlock(bot)
    const dug = await digBlock(new Vec3(f.x, floorY, f.z), { intent, reason: 'digdown', ignorePathBlocks: true })
    if (!dug.ok) {
      if (isAborted()) { state.currentTask = null; return }
      const why = dug.reason === 'need_tool' ? `${dug.block} needs a ${dug.need} (or add :skiptool)` : `${dug.reason}${dug.block ? ` (${dug.block})` : ''}`
      return fail(`digdown stopped at y${f.y} after ${steps} blocks: can't dig the floor — ${why}`)
    }
    const dropped = await awaitLanding(bot.entity.position.y)
    if (dropped < 1) return fail(`digdown stopped at y${f.y}: dug the floor but didn't fall (standing on an edge?)`)
    steps++
    if (dropped > SAFE_FALL) logEvent(`digdown: fell ${dropped} blocks at y${f.y} (HP ${Math.round(bot.health)})`)
  }
  const end = feet()
  console.log(`  digdown: ${steps} blocks, y${start.y} → y${end.y}`)
  logEvent(`digdown:${until} done — y${start.y} → y${end.y}`)
  state.currentTask = null
}

// ── jumpdown ──────────────────────────────────────────────────────────────
async function doJumpDown(arg) {
  stopAll()
  const bot = state.bot
  const parts = String(arg || '').toLowerCase().split(':').map(s => s.trim()).filter(Boolean)
  const dirName = parts[0]
  const blind = parts.includes('blind')
  if (dirName !== 'down' && !DIRS[dirName]) {
    return fail(`jumpdown: give a direction — north/south/east/west (step off a ledge) or down (break the floor)`)
  }
  const f = feet()
  const hp0 = bot.health
  let x = f.x, z = f.z, fall

  if (dirName === 'down') {
    reveal([[x, f.y - 1, z], [x, f.y - 2, z], [x, f.y - 3, z]])
    fall = measureFall(x, f.y, z, 1)
    if (fall.unknown && fall.blocks === 1) fall = neighbourFall(x, f.y - 1, z) || fall
  } else {
    const [dx, dz] = DIRS[dirName]
    x += dx; z += dz
    reveal([[x, f.y, z], [x, f.y + 1, z], [x, f.y - 1, z], [x, f.y - 2, z]])
    const body = [dbBlock(x, f.y, z), dbBlock(x, f.y + 1, z)]
    if (body.some(n => n === null)) return fail(`jumpdown:${dirName}: can't see the space to the ${dirName} — look first`)
    const blocked = body.find(n => !PASSABLE.has(n))
    if (blocked) return fail(`jumpdown:${dirName}: ${blocked} in the way to the ${dirName} — that's no ledge`)
    fall = measureFall(x, f.y, z)
    if (!fall.unknown && fall.blocks === 0) return fail(`jumpdown:${dirName}: no drop to the ${dirName} — just walk (move:${dirName}:1)`)
  }

  if (fall.hazard) return fail(`jumpdown:${dirName}: refusing — the fall lands in ${fall.hazard} (${describeFall(fall)})`)
  if (fall.unknown && !blind) {
    return fail(`jumpdown:${dirName}: landing unseen — the drop is ${describeFall(fall)}. ` +
      `Look first ([CTX:slice]) or jumpdown:${dirName}:blind to jump anyway`)
  }
  if (!fall.unknown && damageOf(fall) >= hp0) {
    return fail(`jumpdown:${dirName}: refusing — ${describeFall(fall)} would kill me at ${Math.round(hp0)} HP`)
  }

  console.log(`  jumpdown:${dirName}: ${describeFall(fall)} (HP ${Math.round(hp0)})`)
  state.currentTask = `jumping down ${dirName}`
  const startY = bot.entity.position.y
  if (dirName === 'down') {
    await centerInBlock(bot)
    const dug = await digBlock(new Vec3(f.x, f.y - 1, f.z), { reason: 'jumpdown', ignorePathBlocks: true })
    if (!dug.ok) return fail(`jumpdown:down: can't break the floor — ${dug.reason}${dug.block ? ` (${dug.block})` : ''}`)
  } else {
    // Walk straight off the edge: face the neighbour column and hold forward until
    // the bot has left its block, then let go and fall.
    await bot.lookAt(new Vec3(x + 0.5, f.y + 1.6, z + 0.5), true)
    bot.setControlState('forward', true)
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !isAborted()) {
      const p = bot.entity.position
      if (Math.floor(p.x) === x && Math.floor(p.z) === z) break
      await sleep(50)
    }
    bot.setControlState('forward', false)
  }
  const dropped = await awaitLanding(startY, 6000)
  const hp1 = Math.round(bot.health)
  state.currentTask = null
  if (dropped < 1) return fail(`jumpdown:${dirName}: didn't fall — still at y${feet().y}`)
  logEvent(`jumpdown:${dirName} fell ${dropped} blocks, HP ${Math.round(hp0)}→${hp1}, now at ${Object.values(feet()).join(',')}`)
}

module.exports = { doDigDown, doJumpDown, measureFall, neighbourFall, damageOf }
