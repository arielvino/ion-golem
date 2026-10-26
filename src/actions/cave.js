// Walking inside caves: in along the open space, and back out the way the bot came.
//
//   [ACTION:cave:explore[:DIR][:N][:ORE][:X,Y,Z]]  follow a cave's open space (from a CAVES= mouth,
//       X,Y,Z, or from inside), lighting it with torches, until a decision point: a fork, a dead
//       end, water, lava, an ore not seen before (ORE: only that one), a drop it couldn't climb
//       back, 2 torches left, or N blocks walked (default 48). DIR picks the way to start with.
//   [ACTION:cave:out]  walk the recorded way in backwards, to where it started under open sky.
//
// The ways on come from passages.js (what the bot has seen, lit cells only). The walk itself is
// the pathfinder's (it may dig and bridge, as a walk does) with no drop over 3 blocks. Every
// step taken is kept (caveTrail.js), with the blocks it takes to climb back up its drops; a way
// down that would need more blocks than the bot carries is not taken.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { stopAll, isAborted } = require('../core/tick')
const { recordFailure, logEvent } = require('../core/utils')
const { pathfinderWalk } = require('../navigation/navigation')
const { reachGoal } = require('../navigation/goals')
const { lookAround } = require('../perception/sight')
const passages = require('../perception/passages')
const trail = require('../navigation/caveTrail')
const { SCAFFOLD_ITEMS } = require('../navigation/terraformGate')
const { roleOf } = require('../config/natural-blocks')

const VIEW_R = 24           // look this far on each leg
const WALK_DEFAULT = 48     // blocks walked before stopping by default
const LEGS_MAX = 30
const PEEKS_MAX = 12        // looks over an edge per run
const TRAIL_GAP = 24        // farther than this from the trail's end: that trail is not this cave's
const TORCH_BELOW = 7       // light at the eye this low after a leg: put a torch up
const TORCHES_LOW = 2       // stop when down to this many
const LAVA_STOP = 6         // lava this close stops the walk
const FORK_ANGLE = 60       // two ways this far apart are a fork
const AHEAD_ANGLE = 100     // a way within this of the heading is ahead (not the way back)
const TORCHES = new Set(['torch', 'soul_torch', 'copper_torch'])
const DIR_WORDS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1],
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] }

const count = (bot, names) => bot.inventory.items().filter(i => names.has(i.name)).reduce((s, i) => s + i.count, 0)
const SCAFFOLD = new Set(SCAFFOLD_ITEMS)
const angle = (a, b) => {
  const d = Math.abs(Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * 180 / Math.PI
  return d > 180 ? 360 - d : d
}
const fmt = (p) => `${p.x},${p.y},${p.z}`

// The sky is over the bot: a cell with full sky light.
function underSky(bot) {
  const b = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
  return (b?.skyLight ?? 0) >= 15
}

function fail(msg) {
  console.log(`  ${msg}`)
  recordFailure(msg)
  state.currentTask = null
  return false
}

// Ores in a view, by position key (ORE given: that one only, deepslate variants included).
function oresIn(view, ore) {
  const out = new Map()
  for (const b of view.blocks) {
    if (b.sunk || b.underwater || roleOf(b.name, 'overworld', b.biome) !== 'resource') continue
    if (ore && b.name.replace(/^deepslate_/, '') !== ore.replace(/^deepslate_/, '')) continue
    out.set(fmt(b), b)
  }
  return out
}

// Look down a drop the bot can't see the bottom of from where it stands: sneak to the edge (the
// sneak stops it there, its eye out over the drop), take a look, and step back.
async function peek(bot, into) {
  const p0 = bot.entity.position.clone()
  await bot.lookAt(new Vec3(into.x + 0.5, p0.y + 1.6, into.z + 0.5), true)
  bot.setControlState('sneak', true)
  bot.setControlState('forward', true)
  await new Promise(r => setTimeout(r, 900))
  bot.setControlState('forward', false)
  lookAround(bot, VIEW_R)
  bot.setControlState('back', true)
  await new Promise(r => setTimeout(r, 700))
  bot.setControlState('back', false)
  bot.setControlState('sneak', false)
}

async function placeTorch(bot) {
  const { doPlace } = require('./building')
  const name = [...TORCHES].find(n => bot.inventory.items().some(i => i.name === n))
  if (!name) return false
  return (await doPlace(name)) !== false
}

function parseExplore(parts) {
  const o = { dir: null, limit: WALK_DEFAULT, ore: null, at: null }
  for (const p of parts) {
    const s = p.trim().toLowerCase()
    if (!s) continue
    if (DIR_WORDS[s.replace(/[-_]/g, '')]) o.dir = DIR_WORDS[s.replace(/[-_]/g, '')]
    else if (/^\d+$/.test(s)) o.limit = Number(s)
    else if (/^-?\d+,-?\d+,-?\d+$/.test(s)) { const [x, y, z] = s.split(',').map(Number); o.at = { x, y, z } }
    else o.ore = s.endsWith('_ore') ? s : `${s}_ore`
  }
  return o
}

// Why the walk stops here, or null to go on. view: this leg's look; w: its ways.
function stopReason(bot, w, view, seenOres, o, torches0) {
  const fresh = [...oresIn(view, o.ore).entries()].filter(([k]) => !seenOres.has(k)).map(([, b]) => b)
  if (fresh.length) {
    const eye = view.eye
    const b = fresh.reduce((a, c) => (Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z) < Math.hypot(a.x - eye.x, a.y - eye.y, a.z - eye.z) ? c : a))
    return `${b.name} in view at ${fmt(b)}${fresh.length > 1 ? ` (${fresh.length} new ore blocks)` : ''}`
  }
  if (w.lava && w.lava.dist <= LAVA_STOP) return `lava ${w.lava.dist}m ${w.lava.dir} at ${fmt(w.lava.at)}`
  const torches = count(bot, TORCHES)
  if (torches <= TORCHES_LOW && torches < torches0) return `only ${torches} torch${torches === 1 ? '' : 'es'} left`
  return null
}

async function doCaveExplore(parts) {
  stopAll()
  const bot = state.bot
  const o = parseExplore(parts)
  const torches0 = count(bot, TORCHES)
  const lit = () => { const v = lookAround(bot, 8); return (v.dark?.here ?? 15) >= 1 }
  if (!torches0 && !lit()) return fail('cave:explore: too dark here and no torch to light the way — get torches first (coal or charcoal + stick)')

  state.currentTask = 'exploring a cave'
  // A trail starts under open sky; one already running (back in after a stop) goes on, unless
  // the bot is somewhere else by now (another cave, after a death).
  const old = trail.get(), here = trail.feetOf(bot), end = old?.points[old.points.length - 1]
  if (!old || underSky(bot) || Math.hypot(end.x - here.x, end.y - here.y, end.z - here.z) > TRAIL_GAP) trail.start(here)

  let heading = o.dir, walked = 0, why = null
  const failed = new Set(), peeked = new Set(), torched = new Set()   // torched: spots a torch went up at
  let seenOres = null, last = bot.entity.position.clone(), first = true   // first: the run's first choice of a way
  const result = await trail.recording(bot, async () => {
    if (o.at) {
      const t = o.at
      const r = await pathfinderWalk(t.x, t.y, t.z, 2, 60000, reachGoal(t.x, t.y, t.z, 2), bot.movementsFor?.cave)
      if (!r.ok) { why = r.reason === 'abort' ? null : `couldn't reach the cave at ${fmt(t)} (${r.reason})`; return false }
      last = bot.entity.position.clone()   // the walk there is not the cave's
    }
    for (let leg = 0; leg < LEGS_MAX; leg++) {
      if (isAborted()) return null
      walked += bot.entity.position.distanceTo(last); last = bot.entity.position.clone()
      if (walked >= o.limit) { why = `walked ${Math.round(walked)} blocks`; return true }
      const feet = trail.feetOf(bot)
      const view = lookAround(bot, VIEW_R)
      passages.noteBody(feet, bot.game.minY, bot.game.height)
      const w = passages.waysFrom(feet)
      // Ores already reported don't stop it again.
      if (!seenOres) seenOres = new Set([...oresIn(view, o.ore).keys(), ...trail.reportedOres()])
      const stop = stopReason(bot, w, view, seenOres, o, torches0)
      for (const k of oresIn(view, o.ore).keys()) if (!seenOres.has(k)) trail.noteOre(k)
      if (stop) { why = stop; return true }
      for (const k of oresIn(view, o.ore).keys()) seenOres.add(k)

      // Dark here: light it before choosing (the ways on show only in light).
      if ((view.dark?.here ?? 15) < TORCH_BELOW && count(bot, TORCHES) && !underSky(bot) && !torched.has(fmt(feet))) {
        torched.add(fmt(feet))
        if (await placeTorch(bot)) continue
      }

      const t = trail.get()
      const blocks = count(bot, SCAFFOLD)
      const open = w.ways.filter(x => !x.surface && !failed.has(fmt(x.at)))
      const affordable = open.filter(x => t.back + x.back <= blocks)
      const vec = (x) => [x.at.x - feet.x, x.at.z - feet.z]
      let ahead = heading ? affordable.filter(x => Math.hypot(...vec(x)) < 1 || angle(vec(x), heading) <= AHEAD_ANGLE) : affordable
      if (!ahead.length && first && affordable.length) {
        if (o.dir) { why = `no way on that way; the ways on: ${affordable.map(x => `${x.dir} ${x.dist}m`).join(', ')}`; return true }
        ahead = affordable
      }
      if (!ahead.length) {
        // Name only what lies ahead: the rest is the way back.
        const fwd = (at) => !heading || Math.hypot(at.x - feet.x, at.z - feet.z) < 1 || angle([at.x - feet.x, at.z - feet.z], heading) <= AHEAD_ANGLE
        const costly = open.filter(x => !affordable.includes(x) && fwd(x.at))
        const drop = w.drops.find(d => fwd(d.at) && d.dist <= 12)
        const behind = affordable.length ? ` (the other ways on lead back: ${affordable.map(x => `${x.dir} ${x.dist}m`).join(', ')})` : ''
        why = costly.length ? `the way on goes down drops that would take ${Math.min(...costly.map(x => x.back))} blocks to climb back (have ${blocks}, the way in already needs ${t.back})`
          : w.water && w.water.dist <= 8 && fwd(w.water.at) ? `water ahead (${w.water.dist}m ${w.water.dir})`
          : drop ? `a drop of ${drop.depth} blocks ${drop.dist}m ${drop.dir} — too deep to go down safely${behind}`
          : `a dead end ahead${behind}`
        console.log(`  [cave] stop: ${w.ways.length} ways (${open.length} open, ${affordable.length} affordable), ${w.reached} cells reached, light ${view.dark?.here}`)
        return true
      }
      // A fork: two ways ahead in different directions. The first leg picks by DIR or goes on.
      if (!first && ahead.length > 1) {
        const far = ahead.filter(x => ahead.some(y => y !== x && Math.hypot(...vec(x)) >= 2 && Math.hypot(...vec(y)) >= 2 && angle(vec(x), vec(y)) >= FORK_ANGLE))
        if (far.length > 1) { why = `a fork: ways on ${ahead.map(x => `${x.dir} ${x.dist}m`).join(', ')}`; return true }
      }
      const pick = heading ? ahead.reduce((a, b) => (angle(vec(b), heading) < angle(vec(a), heading) ? b : a)) : ahead[0]
      // The way goes over an edge whose bottom isn't seen: go to the edge and look down first.
      if (pick.unknownDrop && pick.into && !peeked.has(fmt(pick.into)) && peeked.size < PEEKS_MAX) {
        peeked.add(fmt(pick.into))
        first = false
        const p0 = bot.entity.position.clone()
        if (pick.dist > 0) {
          const a = pick.at
          const r = await pathfinderWalk(a.x, a.y, a.z, 0, Math.max(20000, pick.dist * 2000), reachGoal(a.x, a.y, a.z, 0), bot.movementsFor?.cave)
          if (isAborted() || r.reason === 'abort') return null
          if (!r.ok) { failed.add(fmt(a)); continue }
        }
        const mv = [pick.into.x + 0.5 - p0.x, pick.into.z + 0.5 - p0.z]
        if (Math.hypot(...mv) >= 1) heading = mv
        console.log(`  [cave] peeking over the edge at ${fmt(pick.into)}`)
        await peek(bot, pick.into)
        leg--
        continue
      }

      first = false
      const before = bot.entity.position.clone()
      // Standing at the edge of what is seen: step into the unseen cell beside it.
      const step = pick.dist <= 1 && pick.into
      const g = step ? pick.into : pick.at
      console.log(`  [cave] leg ${leg}: ${pick.dir} ${pick.dist}m to ${fmt(g)} (${w.ways.length} ways, back ${t.back}/${blocks})`)
      const range = step ? 0 : 1
      const r = await pathfinderWalk(g.x, g.y, g.z, range, Math.max(20000, pick.dist * 2000), reachGoal(g.x, g.y, g.z, range), bot.movementsFor?.cave)
      if (isAborted() || r.reason === 'abort') return null
      if (r.reason === 'hostile' || r.reason === 'low_health' || r.reason === 'drowning') { why = r.reason === 'hostile' ? 'a hostile mob close by' : r.reason.replace('_', ' '); return true }
      if (!r.ok) { failed.add(fmt(g)); console.log(`  [cave] leg failed: ${r.reason}`); if (failed.size >= 3) { why = `the walk keeps failing (${r.reason})`; return true } }
      const p = bot.entity.position
      if (r.ok && p.distanceTo(before) < 0.5) failed.add(fmt(pick.at))   // arrived without a step: no way on there
      const moved = [p.x - before.x, p.z - before.z]
      if (Math.hypot(...moved) >= 1) heading = moved
    }
    why = 'leg limit'
    return true
  }, underSky)
  state.currentTask = null
  walked += bot.entity.position.distanceTo(last)
  if (result === null) return
  if (result === false) return fail(`cave:explore: ${why}`)
  const f = trail.feetOf(bot), t = trail.get()
  const msg = `cave:explore stopped at ${fmt(f)}: ${why}. Walked ${Math.round(walked)} blocks; way out ${trail.length(t)} blocks${t.back ? `, ${t.back} blocks to climb back` : ''} (cave:out)`
  console.log(`  ${msg}`)
  logEvent(msg)
}

async function doCaveOut() {
  stopAll()
  const bot = state.bot
  const t = trail.get()
  if (!t) return fail('cave:out: no way in recorded — staircase up toward the surface instead')
  if (underSky(bot)) { trail.clear(); console.log('  cave:out: already under open sky'); return }
  state.currentTask = 'leaving the cave'
  const pts = t.points
  // Back along the trail, a waypoint every few points; the mouth is the last one.
  let i = pts.length - 1, misses = 0
  const here = trail.feetOf(bot)
  // Start from the point nearest to where the bot is.
  let best = i
  for (let k = 0; k < pts.length; k++) if (Math.hypot(pts[k].x - here.x, pts[k].y - here.y, pts[k].z - here.z) < Math.hypot(pts[best].x - here.x, pts[best].y - here.y, pts[best].z - here.z)) best = k
  i = best
  while (i > 0) {
    if (isAborted()) { state.currentTask = null; return }
    i = Math.max(0, i - 6)
    const g = pts[i]
    const r = await pathfinderWalk(g.x, g.y, g.z, 1, 30000, reachGoal(g.x, g.y, g.z, 1), bot.movementsFor?.caveOut)
    if (isAborted() || r.reason === 'abort') { state.currentTask = null; return }
    if (!r.ok) {
      if (r.reason === 'hostile' || r.reason === 'low_health') return fail(`cave:out stopped at ${fmt(trail.feetOf(bot))}: ${r.reason.replace('_', ' ')} — re-issue cave:out to go on`)
      if (++misses >= 3) return fail(`cave:out stuck at ${fmt(trail.feetOf(bot))} (${r.reason}); the mouth is at ${fmt(t.mouth)}`)
      continue
    }
    misses = 0
    if (underSky(bot)) break
  }
  const f = trail.feetOf(bot)
  state.currentTask = null
  if (!underSky(bot) && Math.hypot(f.x - t.mouth.x, f.y - t.mouth.y, f.z - t.mouth.z) > 3) return fail(`cave:out ended at ${fmt(f)}, short of the mouth at ${fmt(t.mouth)}`)
  trail.clear()
  passages.forget()
  const msg = `cave:out: out of the cave at ${fmt(f)}`
  console.log(`  ${msg}`)
  logEvent(msg)
}

// CAVE=[...] — while the bot is in a cave (no open sky over it, and a way in recorded or a seen
// roof): the way out, the ways on, drops too deep to walk, water and lava. Data only; what it
// means is in the system prompt.
function contextLine() {
  const bot = state.bot
  if (!bot?.entity || !/overworld/.test(bot.game?.dimension || '') || underSky(bot)) return ''
  const feet = trail.feetOf(bot), t = trail.get()
  const w = passages.waysFrom(feet)
  if (!t && !w.reached) return ''
  const m = passages.theMap(bot.game.minY, bot.game.height)
  let roof = false
  for (let k = 2; k <= 32 && !roof; k++) roof = m.get(feet.x, feet.y + k, feet.z) === passages.SOLID
  if (!t && !roof) return ''
  const parts = []
  const blocks = count(bot, SCAFFOLD)
  if (t) parts.push(`way in from ${fmt(t.mouth)}: ${trail.length(t)} blocks back${t.back ? `, ${t.back} blocks to climb (have ${blocks})` : ''}`)
  const on = w.ways.filter(x => !x.surface)
  const out = w.ways.filter(x => x.surface)
  parts.push(on.length ? `ways on: ${on.slice(0, 6).map(x => `${x.dir} ${x.dist}m${x.unknownDrop ? ' (over an edge, bottom unseen)' : ''}${x.back ? ` (${x.back} blocks to climb back)` : ''}`).join('; ')}` : 'ways on: none seen')
  if (out.length) parts.push(`open sky: ${out[0].dir} ${out[0].dist}m`)
  if (w.drops.length) parts.push(`drops: ${w.drops.slice(0, 3).map(d => `${d.dir} ${d.dist}m down ${d.depth}`).join('; ')}`)
  if (w.water) parts.push(`water ${w.water.dir} ${w.water.dist}m`)
  if (w.lava) parts.push(`lava ${w.lava.dir} ${w.lava.dist}m@${fmt(w.lava.at)}`)
  return ` CAVE=[${parts.join(' | ')}]`
}

async function doCave(arg) {
  const [sub, ...rest] = String(arg || '').split(':')
  if (sub === 'explore') return doCaveExplore(rest)
  if (sub === 'out') return doCaveOut()
  return fail('cave: use cave:explore[:DIR][:N][:ORE][:X,Y,Z] or cave:out')
}

module.exports = { doCave, parseExplore, contextLine }
