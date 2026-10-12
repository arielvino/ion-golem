// The duel arena: a walled stone-brick floor in the air, sealed with barriers so
// nothing gets in or out (under a tinted-glass roof that keeps the daylight out),
// with four cover walls around the centre. Built and reset
// through the server console FIFO; nothing here needs an op client.
//
// makeArena({ cx, cz, r }) gives an arena centred on cx,cz with a play area of
// radius r (default R); the module itself is the one at 0,0. Arenas whose shells
// don't overlap can run at once.
const fs = require('fs')
const os = require('os')
const path = require('path')

const CONSOLE = process.env.MC_CONSOLE ||
  path.resolve(__dirname, '../../../server/server.stdin')
// The console's replies land in the server log.
const LOG = process.env.MC_LOG || path.join(path.dirname(CONSOLE), 'logs', 'latest.log')

// Floor at Y, play area within R of the centre, barrier shell one block outside it
// and one below the floor (BOTTOM): a bot digging through the floor meets barrier,
// not a 99-block drop.
const Y = 150
const BOTTOM = Y - 1
const R = 12
const TOP = Y + 12
// A pristine copy of the arena, buried at the same X/Z (its BOTTOM at COPY_Y): a
// run checks the arena against it and repairs it from it instead of rebuilding.
const COPY_Y = -50
const COPY_TOP = COPY_Y + TOP - BOTTOM
// Fighters take the corners in turn: NW, SE, NE, SW (a fifth starts 3 blocks in
// from the first, and so on), 2 blocks in from the walls.
const CORNERS = [[-1, -1], [1, 1], [1, -1], [-1, 1]]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// One command per write, spaced out: a burst written at once loses lines.
async function cmd(line) {
  fs.writeFileSync(CONSOLE, line + '\n')
  await sleep(150)
}

// Sends a console command and returns its reply from the server log: the first new
// line matching `pattern`, or null after `ms`. A reply doesn't say which command it
// answers, so referees running at once take turns: a lock file around each
// question and its answer (one left by a dead process goes stale after STALE_MS).
const LOCK = path.join(os.tmpdir(), 'iongolem-console.lock')
const STALE_MS = 10000
async function lockConsole() {
  for (;;) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); return } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) fs.unlinkSync(LOCK) } catch (e) {}
      await sleep(20)
    }
  }
}
// The server log survives being rotated at midnight: missing for a moment, then
// short again. logSize() is 0 while it's missing; logSince(from) reads from the start
// of a log shorter than `from` (a new one).
function logSize() {
  try { return fs.statSync(LOG).size } catch (e) { if (e.code === 'ENOENT') return 0; throw e }
}
function logSince(from) {
  let fd
  try { fd = fs.openSync(LOG, 'r') } catch (e) { if (e.code === 'ENOENT') return ''; throw e }
  try {
    const size = fs.fstatSync(fd).size
    if (size < from) from = 0
    const buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    return buf.toString()
  } finally { fs.closeSync(fd) }
}

async function ask(line, pattern, ms = 3000) {
  await lockConsole()
  try {
    const from = logSize()
    await cmd(line)
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
      const m = logSince(from).match(pattern)
      if (m) return m[0]
    }
    return null
  } finally {
    try { fs.unlinkSync(LOCK) } catch (e) {}
  }
}

const ARMOR = [
  ['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'],
  ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']
]
// A side shows its colour in its armour trim (iron can't be dyed) and its name tag.
const COLORS = {
  red: { trim: 'redstone', team: 'red' },
  blue: { trim: 'lapis', team: 'blue' }
}

// A command may touch at most this many blocks (fill, clone, execute if blocks).
const MAX_BLOCKS = 32768

// dark: no lights, and tinted-glass sides as well as roof, so no daylight gets in
// either: the floor is at light 0 and monsters spawn on it.
function makeArena({ cx = 0, cz = 0, r = R, dark = false } = {}) {
  // x0..x1, z0..z1: the shell's footprint. The walls stand one block inside it, so
  // a fighter that digs through a wall (the pathfinder does, chasing a target
  // outside) meets the shell.
  const x0 = cx - r - 2, x1 = cx + r + 2, z0 = cz - r - 2, z1 = cz + r + 2
  const box = `x=${x0},y=${Y},z=${z0},dx=${2 * r + 4},dy=${TOP - Y},dz=${2 * r + 4}`
  // A big arena's box goes through commands in horizontal slices of `step` layers.
  const step = Math.max(1, Math.floor(MAX_BLOCKS / ((x1 - x0 + 1) * (z1 - z0 + 1))))
  const slices = (lo, hi) => {
    const out = []
    for (let y = lo; y <= hi; y += step) out.push([y, Math.min(hi, y + step - 1)])
    return out
  }
  const copyOf = (y) => COPY_Y + y - BOTTOM
  // Cover walls stand halfway out; lights every 6 blocks.
  const c = Math.round(r / 2)
  const LIGHTS = [-9, -3, 3, 9].filter(o => Math.abs(o) < r)
  // Where a spectator sees the whole floor.
  const VIEW = { x: cx, y: Y + 9, z: cz - r }
  // The dead respawn here, on the roof: out of the fight, watching it.
  const BENCH = { x: cx, y: TOP + 1, z: cz }

  async function matchesCopy() {
    for (const [a, b] of slices(BOTTOM, TOP)) {
      if (!/passed/.test(await ask(`execute if blocks ${x0} ${a} ${z0} ${x1} ${b} ${z1} ${x0} ${copyOf(a)} ${z0} all`, /Test (passed|failed)/) || '')) return false
    }
    return true
  }

  // Whether the copy is there at all: its tinted-glass roof, barrier bottom and its
  // stone-brick floor. Without it, restoring from the copy would clone raw
  // underground (gravel and all) into the sky.
  const isBlock = async (x, y, z, block) =>
    /passed/.test(await ask(`execute if block ${x} ${y} ${z} ${block}`, /Test (passed|failed)/) || '')
  const copyExists = async () =>
    await isBlock(x0, COPY_TOP, z0, 'tinted_glass') && await isBlock(x0, COPY_Y, z0, 'barrier') &&
    await isBlock(cx, COPY_Y + Y - BOTTOM, cz, 'stone_bricks') &&
    await isBlock(x0, copyOf(Y + 1), z0, dark ? 'tinted_glass' : 'barrier')

  // The arena as built: left alone if it matches its copy, restored from the copy
  // if it doesn't, and built from scratch (and copied) only when there's no copy.
  async function ready() {
    await cmd(`forceload add ${x0} ${z0} ${x1} ${z1}`)
    // An arena that matches a copy of an older design (no tinted roof, no barrier
    // bottom) is rebuilt too.
    if (!await copyExists()) { await build(); await saveCopy(); return 'built' }
    if (await matchesCopy()) return 'intact'
    for (const [a, b] of slices(BOTTOM, TOP)) await cmd(`clone ${x0} ${copyOf(a)} ${z0} ${x1} ${copyOf(b)} ${z1} ${x0} ${a} ${z0}`)
    if (await matchesCopy()) return 'repaired'
    await build()
    await saveCopy()
    return 'built'
  }

  async function saveCopy() {
    for (const [a, b] of slices(BOTTOM, TOP)) await cmd(`clone ${x0} ${a} ${z0} ${x1} ${b} ${z1} ${x0} ${copyOf(a)} ${z0}`)
  }

  async function build() {
    // The shell, then the air inside it (a `hollow` fill can't be sliced).
    for (const [a, b] of slices(BOTTOM, TOP)) await cmd(`fill ${x0} ${a} ${z0} ${x1} ${b} ${z1} ${dark ? 'tinted_glass' : 'barrier'}`)
    for (const [a, b] of slices(BOTTOM + 1, TOP - 1)) await cmd(`fill ${x0 + 1} ${a} ${z0 + 1} ${x1 - 1} ${b} ${z1 - 1} air`)
    await cmd(`fill ${x0} ${BOTTOM} ${z0} ${x1} ${BOTTOM} ${z1} barrier`)
    // A tinted-glass roof: see-through, but it stops daylight, which barriers let in
    // (undead burned under them). The light blocks below keep the arena lit.
    await cmd(`fill ${x0} ${TOP} ${z0} ${x1} ${TOP} ${z1} tinted_glass`)
    const w0 = x0 + 1, w1 = x1 - 1, v0 = z0 + 1, v1 = z1 - 1
    await cmd(`fill ${w0} ${Y} ${v0} ${w1} ${Y} ${v1} stone_bricks`)
    // The four walls one at a time: a `hollow` box would also roof the floor over.
    await cmd(`fill ${w0} ${Y + 1} ${v0} ${w1} ${Y + 3} ${v0} stone_bricks`)
    await cmd(`fill ${w0} ${Y + 1} ${v1} ${w1} ${Y + 3} ${v1} stone_bricks`)
    await cmd(`fill ${w0} ${Y + 1} ${v0} ${w0} ${Y + 3} ${v1} stone_bricks`)
    await cmd(`fill ${w1} ${Y + 1} ${v0} ${w1} ${Y + 3} ${v1} stone_bricks`)
    // Lit from the floor and, invisibly, from under the ceiling.
    if (!dark) for (const x of LIGHTS) for (const z of LIGHTS) {
      await cmd(`setblock ${cx + x} ${Y} ${cz + z} glowstone`)
      await cmd(`setblock ${cx + x} ${TOP - 1} ${cz + z} light[level=15]`)
    }
    // Cover: four 3-wide, 3-high walls in a broken ring around the centre.
    await cmd(`fill ${cx - c} ${Y + 1} ${cz - 1} ${cx - c} ${Y + 3} ${cz + 1} cobblestone`)
    await cmd(`fill ${cx + c} ${Y + 1} ${cz - 1} ${cx + c} ${Y + 3} ${cz + 1} cobblestone`)
    await cmd(`fill ${cx - 1} ${Y + 1} ${cz - c} ${cx + 1} ${Y + 3} ${cz - c} cobblestone`)
    await cmd(`fill ${cx - 1} ${Y + 1} ${cz + c} ${cx + 1} ${Y + 3} ${cz + c} cobblestone`)
    await cmd(`kill @e[type=!player,${box}]`)
    for (const [side, c] of Object.entries(COLORS)) {
      await cmd(`team add duel_${side}`)
      await cmd(`team modify duel_${side} color ${c.team}`)
      await cmd(`team modify duel_${side} friendlyFire false`)
    }
  }

  // Corner number n, as a standing position.
  function corner(n) {
    const [ox, oz] = CORNERS[n % CORNERS.length].map(s => s * (r - 2))
    const inward = Math.floor(n / CORNERS.length) * 3
    return { x: cx + ox - Math.sign(ox) * inward + 0.5, y: Y + 1, z: cz + oz - Math.sign(oz) * inward + 0.5 }
  }

  // The strategy's kit in iron armour (none if kit.armor is false), full health, at
  // corner number `n`. Hunger
  // and saturation are left to the game, so regeneration runs at its normal pace.
  async function prepare(name, side, kit, n) {
    const s = corner(n)
    await cmd(`clear ${name}`)
    await cmd(`effect clear ${name}`)
    const trim = `[trim={material:"${COLORS[side].trim}",pattern:"sentry"}]`
    if (kit.armor !== false) for (const [slot, item] of ARMOR) await cmd(`item replace entity ${name} ${slot} with ${item}${trim}`)
    for (const [slot, item] of kit.hands) await cmd(`item replace entity ${name} ${slot} with ${item}`)
    await cmd(`team join duel_${side} ${name}`)
    for (const [item, count] of kit.bag) await cmd(`give ${name} ${item} ${count}`)
    await cmd(`effect give ${name} instant_health 1 10 true`)
    await cmd(`spawnpoint ${name} ${BENCH.x} ${BENCH.y} ${BENCH.z}`)
    await cmd(`tp ${name} ${s.x} ${s.y} ${s.z} facing ${cx} ${s.y + 1} ${cz}`)
  }

  // Drops, arrows and stray mobs from the last round.
  async function sweep() {
    await cmd(`kill @e[type=!player,${box}]`)
  }

  return { ready, build, saveCopy, prepare, sweep, corner, box, cx, cz, r, VIEW, BENCH }
}

module.exports = { ...makeArena(), makeArena, cmd, ask, logSize, logSince, Y, R }
